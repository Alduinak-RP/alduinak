import React, { useEffect, useState } from 'react';

import { assetUrl } from '../../utils/assetUrl';

import { DEFAULT_RANK_HOURS, PROFESSION_TYPES, RANK_NAMES, SHORT_DESC } from './ranks';
import './styles.scss';

interface Profession {
  id: string;
  label: string;
  title: string;
  type?: string;
  // Per-rank blurbs from the server by rank index; SHORT_DESC is the fallback.
  blurbs?: string[];
}

interface MasteryEvents {
  choose: string;
  reset?: string;
  close: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface MasteryData {
  profession: string | null;
  rank: number;
  hours: number;
  rankHours: number[];
  // Profession resets this character has left
  resetsLeft?: number;
  professions: Profession[];
  events: MasteryEvents;
}

// Artwork is keyed by profession id; the file names predate the labels.
const ART: Record<string, string> = {
  alchemist: 'Alchemist',
  blacksmith: 'Blacksmith',
  cook: 'Cooking',
  farmer: 'Cooking',
  hunter: 'Hunting',
  mage: 'Combat',
  miner: 'Mining',
  tailor: 'Tailor',
  warrior: 'Combat',
  woodworker: 'Woodcutting',
};

const artFor = (professionId: string): string => {
  const name = ART[professionId];
  if (!name) return '';
  try {
    return assetUrl(require('./assets/' + name + '.jpg'));
  } catch (e) {
    return '';
  }
};

const rankDesc = (p: Profession, i: number): string => {
  const blurbs = p.blurbs || [];
  if (blurbs.length >= 5 && blurbs[i]) return blurbs[i];
  return (SHORT_DESC[p.id] || [])[i] || '';
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

// embedded renders inside the Personal Menu Skills tab: no backdrop, corner label or Close button
const MasteryMenu = ({ data, embedded }: { data: MasteryData; embedded?: boolean }) => {
  const ev = data.events || ({} as MasteryEvents);
  const professions = data.professions || [];
  const chosen = data.profession;
  const thresholds = data.rankHours && data.rankHours.length >= 5 ? data.rankHours : DEFAULT_RANK_HOURS;

  // The detail side stays empty until a profession is focused
  const [viewing, setViewing] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (chosen) {
      setCommitting(false);
      setConfirming(null);
    }
  }, [chosen]);

  useEffect(() => {
    if (embedded) return undefined;
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close, embedded]);

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

  const current = professions.filter((p) => p.id === viewing)[0];
  const isChosen = !!current && chosen === current.id;
  const art = current ? artFor(current.id) : '';
  const shownRanks = RANK_NAMES.filter((_, i) => i < 5 || (isChosen && data.rank >= 5));

  return (
    <div className={embedded ? 'mastery mastery--embedded' : 'mastery'}>
      {embedded ? null : <div className="mastery__fade" />}
      <div className="mastery__frame">
        {embedded ? null : <div className="mastery__corner">Skills</div>}
        <h1 className="mastery__title">{current ? current.label + ' – Mastery' : 'Mastery'}</h1>

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
              <span className="mastery__item-label">{p.label}</span>
              <span className="mastery__item-type">{p.type || PROFESSION_TYPES[p.id] || ''}</span>
            </button>
          ))}
        </nav>

        {current ? (
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
                  <br />
                  <span className="mastery__played--muted mastery__played--hint">Working your craft earns an hour; the next counts an hour later.</span>
                  {ev.reset && (data.resetsLeft || 0) > 0 ? (
                    <button className="mastery__cancel mastery__reset" onClick={() => setResetting(true)}>
                      Reset profession ({data.resetsLeft} left)
                    </button>
                  ) : null}
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
        ) : (
          <section className="mastery__empty" />
        )}

        {current ? (
          <section className="mastery__ranks">
            {shownRanks.map((rankName, i) => {
              const reached = i === 0 || (isChosen && data.rank >= i);
              return (
                <div
                  key={rankName}
                  className={'mastery__rank' + (reached ? ' mastery__rank--reached' : '')}
                >
                  <h3 className="mastery__rank-name">{rankName}</h3>
                  <p className="mastery__rank-perk">{rankDesc(current, i)}</p>
                  <span className="mastery__rank-cost">
                    {i === 0 ? 'everyone' : thresholds[i] === 0 ? 'from the start' : thresholds[i] + ' hours'}
                  </span>
                </div>
              );
            })}
          </section>
        ) : null}

        {embedded ? null : <button className="mastery__close" onClick={() => send(ev.close)}>Close</button>}

        {resetting && ev.reset ? (
          <div className="mastery__confirm-shade">
            <div className="mastery__confirm">
              <h3 className="mastery__confirm-title">Set your profession aside?</h3>
              <p className="mastery__confirm-body">
                Your hours and rank are lost and you may choose a craft again. You have {data.resetsLeft} {data.resetsLeft === 1 ? 'reset' : 'resets'} left on this character.
              </p>
              <div className="mastery__confirm-actions">
                <button
                  className="mastery__choose"
                  onClick={() => {
                    send(ev.reset as string);
                    setResetting(false);
                  }}
                >
                  Reset
                </button>
                <button className="mastery__cancel" onClick={() => setResetting(false)}>
                  Keep it
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {confirming && current ? (
          <div className="mastery__confirm-shade">
            <div className="mastery__confirm">
              <h3 className="mastery__confirm-title">Take up the {current.label}?</h3>
              <p className="mastery__confirm-body">
                A character keeps one craft. It can be reset only {data.resetsLeft === 1 ? 'once' : `${data.resetsLeft || 0} times`}, and the hours go with it.
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
