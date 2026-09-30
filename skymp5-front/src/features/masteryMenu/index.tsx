import React, { useEffect, useState } from 'react';

import { assetUrl } from '../../utils/assetUrl';
import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';

import { DEFAULT_RANK_HOURS, FREE_WORK, PROFESSION_TYPES, RANK_NAMES, SHORT_DESC, SLOT_NAMES, SLOT_TAGS } from './ranks';
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

// One configured craft slot (masterySystem.ts SlotSummary); profession is null while the slot is empty
export interface MasterySlot {
  slot: number;
  name: string;
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
  cap: number;
  capName: string;
  // Hours for each rank indexed by rank, Free first
  rankHours: number[];
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
  // Every configured craft slot, primary first; absent or a single slot keeps the one-craft view
  slots?: MasterySlot[];
  events: MasteryEvents;
}

const LEGENDARY = 5;

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

const hoursText = (n: number): string => n + (n === 1 ? ' hour' : ' hours');

export const slotName = (s: MasterySlot): string => s.name || SLOT_NAMES[s.slot] || 'Slot ' + (s.slot + 1);

const slotWord = (s: MasterySlot): string => slotName(s).toLowerCase();

// The next rank on the slot's own ladder and the hours it needs; null at the cap
const nextStep = (s: MasterySlot): { name: string; at: number } | null =>
  s.rank < s.cap && s.rankHours[s.rank + 1] !== undefined ? { name: RANK_NAMES[s.rank + 1], at: s.rankHours[s.rank + 1] } : null;

// For example "Tailor, Free, 7 of 20 h to Novice" or "empty, up to Novice"
const chipText = (s: MasterySlot): string => {
  if (!s.profession) return 'empty, up to ' + RANK_NAMES[s.cap];
  const next = s.slot > 0 ? nextStep(s) : null;
  const hours = next ? s.hours + ' of ' + next.at + ' h to ' + next.name : s.hours + ' h';
  return (s.label || s.profession) + ', ' + RANK_NAMES[s.rank] + ', ' + hours;
};

// The line under a held craft's hours: the primary's clock rule, a sub-slot's progress on its ladder
const progressText = (s: MasterySlot): string => {
  if (s.slot === 0) return 'Working your craft earns an hour; the next counts an hour later.';
  const next = nextStep(s);
  if (!next) return 'As your ' + slotWord(s) + ' craft it rises no higher than ' + RANK_NAMES[s.cap] + '.';
  return s.hours + ' of ' + next.at + ' hours toward ' + next.name + (s.rank === 0 ? ', earned by its free work.' : '.');
};

// "Primary craft only" or "Primary or secondary" for a rank above the viewed slot's cap
const reachText = (slots: MasterySlot[], rank: number): string => {
  const names = slots.filter((s) => s.cap >= rank).map(slotWord);
  const text = names.join(' or ') + (names.length === 1 ? ' craft only' : '');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const pickText = (s: MasterySlot, label: string, resetsLeft: number): string => {
  const resets = 'Resets are shared by all your crafts (' + resetsLeft + ' left).';
  if (s.slot === 0) return 'As your primary craft the ' + label + ' makes you a Novice at once. ' + resets;
  const gate = s.rankHours[1] ? ' It starts at Free: ' + hoursText(s.rankHours[1]) + ' of its free work make you a Novice.' : '';
  return 'As your ' + slotWord(s) + ' craft the ' + label + ' rises no higher than ' + RANK_NAMES[s.cap] + '.' + gate + ' ' + resets;
};

// embedded renders inside the Personal Menu Skills tab: no backdrop, corner label or Close button
const MasteryMenu = ({ data, embedded }: { data: MasteryData; embedded?: boolean }) => {
  const ev = data.events || ({} as MasteryEvents);
  const professions = data.professions || [];
  const chosen = data.profession;
  const thresholds = data.rankHours && data.rankHours.length >= 5 ? data.rankHours : DEFAULT_RANK_HOURS;
  const resetsLeft = data.resetsLeft || 0;
  // Craft slots show once the server configures more than one
  const slots = data.slots && data.slots.length > 1 ? data.slots : [];
  const multi = slots.length > 0;

  // The detail side stays empty until a profession is focused
  const [viewing, setViewing] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  // The profession whose reset waits for confirmation
  const [resetting, setResetting] = useState<string | null>(null);

  const heldKey = multi ? slots.map((s) => s.profession || '').join(',') : chosen || '';
  useEffect(() => {
    setCommitting(false);
    setConfirming(null);
  }, [heldKey]);

  useEffect(() => {
    if (embedded) return undefined;
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close, embedded]);

  const heldBy = (id: string): MasterySlot | undefined => slots.filter((s) => s.profession === id)[0];
  const openSlot = slots.filter((s) => !s.profession)[0];

  const current = professions.filter((p) => p.id === viewing)[0];
  const own = current ? heldBy(current.id) : undefined;
  const isChosen = !!current && (multi ? !!own : chosen === current.id);
  const rank = own ? own.rank : isChosen ? data.rank : 0;
  const hours = own ? own.hours : data.hours;
  // The ladder follows the slot the viewed craft is in or would go into
  const ladderSlot = current ? own || openSlot : undefined;
  const sub = !!ladderSlot && ladderSlot.slot > 0;
  const ladder = sub && ladderSlot ? ladderSlot.rankHours : thresholds;
  const cap = ladderSlot ? ladderSlot.cap : LEGENDARY;
  const art = current ? artFor(current.id) : '';
  const shownRanks = RANK_NAMES.filter((_, i) => i < 5 || (isChosen && rank >= 5));

  const costText = (i: number): string => {
    if (i > cap) return reachText(slots, i);
    if (i === 0) return 'everyone';
    if (ladder[i] === undefined) return '';
    if (sub && i === 1) return hoursText(ladder[i]) + ' of free work';
    return ladder[i] === 0 ? 'from the start' : ladder[i] + ' hours';
  };

  const resetSlot = resetting ? heldBy(resetting) : undefined;
  const resetLabel = resetting ? (professions.filter((p) => p.id === resetting)[0] || { label: resetting }).label : '';

  return (
    <div className={embedded ? 'mastery mastery--embedded' : 'mastery'}>
      {embedded ? null : <div className="mastery__fade" />}
      <div className={'mastery__frame' + (multi ? ' mastery__frame--slots' : '')}>
        {embedded ? null : <div className="mastery__corner">Skills</div>}
        <h1 className="mastery__title">{current ? current.label + ' – Mastery' : 'Mastery'}</h1>

        {multi ? (
          <div className="mastery__slots">
            {slots.map((s) => (
              <button
                key={s.slot}
                className={'mastery__slot' + (s.profession && s.profession === viewing ? ' mastery__slot--viewing' : '')}
                disabled={!s.profession}
                title={slotName(s) + ': ' + chipText(s)}
                onClick={() => setViewing(s.profession || '')}
              >
                <span className="mastery__slot-name">{slotName(s)}</span>
                <span className="mastery__slot-text">{chipText(s)}</span>
              </button>
            ))}
          </div>
        ) : null}

        <nav className="mastery__list">
          {professions.map((p) => {
            const held = multi ? heldBy(p.id) : undefined;
            const isHeld = multi ? !!held : p.id === chosen;
            return (
              <button
                key={p.id}
                className={
                  'mastery__item' +
                  (p.id === viewing ? ' mastery__item--viewing' : '') +
                  (isHeld ? ' mastery__item--chosen' : '')
                }
                onClick={() => setViewing(p.id)}
              >
                {isHeld ? <span className="mastery__marker">&#9670;</span> : null}
                <span className="mastery__item-label">{p.label}</span>
                <span className="mastery__item-type">{p.type || PROFESSION_TYPES[p.id] || ''}</span>
                {held ? <span className="mastery__item-slot">{SLOT_TAGS[held.slot] || slotName(held)}</span> : null}
              </button>
            );
          })}
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
                  {hoursText(hours)} at the craft
                  <br />
                  <span className="mastery__played--muted mastery__played--hint">
                    {own ? progressText(own) : 'Working your craft earns an hour; the next counts an hour later.'}
                  </span>
                  {ev.reset && resetsLeft > 0 ? (
                    <button className="mastery__cancel mastery__reset" onClick={() => setResetting(current.id)}>
                      {own ? 'Reset ' + slotWord(own) + ' craft' : 'Reset profession'} ({resetsLeft} left)
                    </button>
                  ) : null}
                </p>
              ) : multi ? (
                openSlot ? (
                  <button className="mastery__choose" disabled={committing} onClick={() => setConfirming(current.id)}>
                    {committing ? 'Taking it up...' : 'Take up as your ' + slotWord(openSlot) + ' craft'}
                  </button>
                ) : (
                  <p className="mastery__played mastery__played--muted">Every craft slot is taken.</p>
                )
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
              const capped = i > cap;
              const reached = !capped && (i === 0 || (isChosen && rank >= i));
              const work = sub && i === 0 && rank === 0 ? FREE_WORK[current.id] : '';
              return (
                <div
                  key={rankName}
                  className={'mastery__rank' + (reached ? ' mastery__rank--reached' : '') + (capped ? ' mastery__rank--capped' : '')}
                >
                  <h3 className="mastery__rank-name">{rankName}</h3>
                  <p className="mastery__rank-perk">{rankDesc(current, i)}</p>
                  {work ? <p className="mastery__rank-work">Toward Novice: {work}</p> : null}
                  <span className="mastery__rank-cost">{costText(i)}</span>
                </div>
              );
            })}
          </section>
        ) : null}

        {embedded ? null : <button className="mastery__close" onClick={() => send(ev.close)}>Close</button>}

        {resetting && ev.reset ? (
          <ConfirmDialog
            title={resetSlot ? 'Set your ' + slotWord(resetSlot) + ' craft aside?' : 'Set your profession aside?'}
            body={resetSlot
              ? `The ${resetLabel} loses its hours and rank and you may choose a ${slotWord(resetSlot)} craft again; your other crafts stay. You have ${resetsLeft} ${resetsLeft === 1 ? 'reset' : 'resets'} left, shared by all your crafts.`
              : `Your hours and rank are lost and you may choose a craft again. You have ${resetsLeft} ${resetsLeft === 1 ? 'reset' : 'resets'} left on this character.`}
            confirmLabel="Reset"
            cancelLabel="Keep it"
            onConfirm={() => {
              send(ev.reset as string, resetting);
              setResetting(null);
            }}
            onCancel={() => setResetting(null)}
          />
        ) : null}

        {confirming && current ? (
          <ConfirmDialog
            title={`Take up the ${current.label}?`}
            body={multi && openSlot
              ? pickText(openSlot, current.label, resetsLeft)
              : `A character keeps one craft. It can be reset only ${resetsLeft === 1 ? 'once' : `${resetsLeft} times`}, and the hours go with it.`}
            confirmLabel="Commit"
            cancelLabel="Not yet"
            onConfirm={() => {
              if (multi && openSlot) send(ev.choose, confirming, openSlot.slot);
              else send(ev.choose, confirming);
              setCommitting(true);
              setConfirming(null);
            }}
            onCancel={() => setConfirming(null)}
          />
        ) : null}
      </div>
    </div>
  );
};

export default MasteryMenu;
