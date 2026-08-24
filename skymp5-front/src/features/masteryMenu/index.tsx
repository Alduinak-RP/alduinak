import React, { useEffect, useState } from 'react';

import './styles.scss';

interface Profession {
  id: string;
  label: string;
  title: string;
}

interface MasteryEvents {
  choose: string;
  close: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface MasteryData {
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  professions: Profession[];
  events: MasteryEvents;
}

const RANKS = ['Novice', 'Adept', 'Expert', 'Master'];

// What each rank opens up, shown beside the ladder.
const RANK_BLURB = [
  'The first recipes of the craft.',
  'Refined work, and better materials.',
  'Rare patterns few can attempt.',
  'The full repertoire of the craft.',
];

// Artwork is keyed by profession id; the file names predate the labels.
const ART: Record<string, string> = {
  alchemist: 'Alchemist',
  blacksmith: 'Blacksmith',
  cook: 'Cooking',
  hunter: 'Hunting',
  miner: 'Mining',
  tailor: 'Tailor',
  warrior: 'Combat',
  woodworker: 'Woodcutting',
};

// Asset modules export the url as module.exports or as .default depending on the loader.
const assetUrl = (mod: { default?: string } | string): string =>
  typeof mod === 'string' ? mod : mod.default || '';

const artFor = (professionId: string): string => {
  const name = ART[professionId];
  if (!name) return '';
  try {
    return assetUrl(require('./assets/' + name + '.jpg'));
  } catch (e) {
    return '';
  }
};

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('mastery sendMessage', key, args);
  }
};

const MasteryMenu = ({ data }: { data: MasteryData }) => {
  const ev = data.events || ({} as MasteryEvents);
  const professions = data.professions || [];
  const chosen = data.profession;
  const thresholds = data.rankHours && data.rankHours.length ? data.rankHours : [0, 10, 40, 100];

  // Browsing is free; the chosen craft is what the panel opens on.
  const [viewing, setViewing] = useState(chosen || (professions[0] ? professions[0].id : ''));
  const [confirming, setConfirming] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    if (chosen) {
      setViewing(chosen);
      setCommitting(false);
      setConfirming(null);
    }
  }, [chosen]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  // index.js fires menu:escape globally; while the commit dialog is up,
  // Escape should back out of the dialog rather than the whole menu.
  useEffect(() => {
    if (!confirming) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setConfirming(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [confirming]);

  const current = professions.filter((p) => p.id === viewing)[0] || professions[0];
  if (!current) return null;

  const isChosen = chosen === current.id;
  const art = artFor(current.id);

  return (
    <div className="mastery">
      <div className="mastery__fade" />
      <div className="mastery__frame">
        <div className="mastery__corner">Skills</div>
        <h1 className="mastery__title">{current.label} &mdash; Mastery</h1>

        <nav className="mastery__list">
          {professions.map((p) => (
            <button
              key={p.id}
              className={
                'mastery__item' +
                (p.id === viewing ? ' mastery__item--viewing' : '') +
                (p.id === chosen ? ' mastery__item--chosen' : '')
              }
              onClick={() => setViewing(p.id)}
            >
              {p.id === chosen ? <span className="mastery__marker">&#9670;</span> : null}
              {p.label}
            </button>
          ))}
        </nav>

        <section className="mastery__stage">
          <h2 className="mastery__epithet">{current.title}</h2>
          {art ? (
            <img className="mastery__art" src={art} alt="" />
          ) : (
            <div className="mastery__art mastery__art--missing" />
          )}
          <div className="mastery__stage-foot">
            {isChosen ? (
              <p className="mastery__played">
                {data.hours} {data.hours === 1 ? 'hour' : 'hours'} at the craft
              </p>
            ) : chosen ? (
              <p className="mastery__played mastery__played--muted">You follow another craft.</p>
            ) : (
              <button
                className="mastery__choose"
                disabled={committing}
                onClick={() => setConfirming(current.id)}
              >
                {committing ? 'Taking it up...' : 'Take up this craft'}
              </button>
            )}
          </div>
        </section>

        <section className="mastery__ranks">
          {RANKS.map((rankName, i) => {
            const reached = isChosen && data.rank >= i;
            return (
              <div
                key={rankName}
                className={'mastery__rank' + (reached ? ' mastery__rank--reached' : '')}
              >
                <h3 className="mastery__rank-name">{rankName}</h3>
                <p className="mastery__rank-perk">{RANK_BLURB[i]}</p>
                <span className="mastery__rank-cost">
                  {thresholds[i] === 0 ? 'from the start' : thresholds[i] + ' hours'}
                </span>
              </div>
            );
          })}
        </section>

        <button className="mastery__close" onClick={() => send(ev.close)}>Close</button>

        {confirming ? (
          <div className="mastery__confirm-shade">
            <div className="mastery__confirm">
              <h3 className="mastery__confirm-title">Take up the {current.label}?</h3>
              <p className="mastery__confirm-body">
                A character keeps one craft for life. Only an admin can set it aside.
              </p>
              <div className="mastery__confirm-actions">
                <button
                  className="mastery__choose"
                  onClick={() => {
                    send(ev.choose, confirming);
                    setCommitting(true);
                    setConfirming(null);
                  }}
                >
                  Commit
                </button>
                <button className="mastery__cancel" onClick={() => setConfirming(null)}>
                  Not yet
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default MasteryMenu;
