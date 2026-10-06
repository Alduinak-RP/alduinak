import React, { useEffect, useState } from 'react';

import { assetUrl } from '../../utils/assetUrl';
import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';

import { DEFAULT_RANK_HOURS, FREE_WORK, PROFESSION_TYPES, RANK_NAMES, SHORT_DESC, SLOT_NAMES, SLOT_TAGS } from './ranks';
import './styles.scss';
import { loc } from '../../loc';

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

// The character's hour clock and shared bank (masterySystem.ts BankSummary); times are ms left at the bank's `at`
export interface MasteryBank {
  // Bank places
  max: number;
  intervalMs: number;
  // Banked hours also fall due while logged out
  offline?: boolean;
  // Until work counts an hour again, 0 when it counts now
  countedMs: number;
  // Profession id of the hour counting now, null when none is
  counted: string | null;
  // Until the first banked hour is counted
  payMs: number;
  // The profession id each banked hour pays, in pay order
  queue: string[];
  // Local epoch ms the client received it
  at: number;
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
  // Absent from a server that sends none
  bank?: MasteryBank | null;
  events: MasteryEvents;
}

const LEGENDARY = 5;
const BANK_TICK_MS = 15000;

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

const hoursText = (n: number): string => (n === 1 ? loc('mastery.hourOne', { n }) : loc('mastery.hourMany', { n }));

export const slotName = (s: MasterySlot): string => s.name || SLOT_NAMES[s.slot] || loc('mastery.slot.numbered', { n: s.slot + 1 });

const slotWord = (s: MasterySlot): string => slotName(s).toLowerCase();

// The next rank on the slot's own ladder and the hours it needs; null at the cap
const nextStep = (s: MasterySlot): { name: string; at: number } | null =>
  s.rank < s.cap && s.rankHours[s.rank + 1] !== undefined ? { name: RANK_NAMES[s.rank + 1], at: s.rankHours[s.rank + 1] } : null;

// For example "Tailor, Free, 7 of 20 h to Novice" or "empty, up to Novice"
const chipText = (s: MasterySlot): string => {
  if (!s.profession) return loc('mastery.chip.empty', { rank: RANK_NAMES[s.cap] });
  const next = s.slot > 0 ? nextStep(s) : null;
  const hours = next ? loc('mastery.chip.toNext', { hours: s.hours, at: next.at, rank: next.name }) : loc('mastery.chip.hours', { hours: s.hours });
  return loc('mastery.chip.line', { label: s.label || s.profession, rank: RANK_NAMES[s.rank], progress: hours });
};

// The line under a held craft's hours: the primary's clock rule, a sub-slot's progress on its ladder
const progressText = (s: MasterySlot): string => {
  if (s.slot === 0) return loc('mastery.progress.primary');
  const next = nextStep(s);
  if (!next) return loc('mastery.progress.capped', { slot: slotWord(s), rank: RANK_NAMES[s.cap] });
  const vars = { hours: s.hours, at: next.at, rank: next.name };
  return s.rank === 0 ? loc('mastery.progress.towardFree', vars) : loc('mastery.progress.toward', vars);
};

// "Primary craft only" or "Primary or secondary" for a rank above the viewed slot's cap
const reachText = (slots: MasterySlot[], rank: number): string => {
  const names = slots.filter((s) => s.cap >= rank).map(slotWord);
  const joined = names.join(loc('mastery.reach.join'));
  const text = names.length === 1 ? loc('mastery.reach.only', { names: joined }) : joined;
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const pickText = (s: MasterySlot, label: string, resetsLeft: number): string => {
  const resets = loc('mastery.pick.resets', { n: resetsLeft });
  if (s.slot === 0) return loc('mastery.pick.primary', { label, resets });
  const gate = s.rankHours[1] ? loc('mastery.pick.gate', { hours: hoursText(s.rankHours[1]) }) : '';
  return loc('mastery.pick.sub', { slot: slotWord(s), label, rank: RANK_NAMES[s.cap], gate, resets });
};

const minutesText = (ms: number): string => loc('mastery.minutes', { n: Math.max(1, Math.ceil(ms / 60000)) });

interface BankHour {
  filled: boolean;
  state: string;
  detail: string;
  title: string;
}

// Hour 1 is the hour counting now, then a cell per bank place (or per queued hour when an old record folded in more), each paid an interval after the one before
const bankHours = (bank: MasteryBank, label: (id: string) => string, left: (ms: number) => number): BankHour[] => {
  const counted = left(bank.countedMs);
  const who = bank.counted ? label(bank.counted) : '';
  const time = minutesText(counted);
  const hours: BankHour[] = [
    counted > 0
      ? {
          filled: true,
          state: loc('mastery.bank.counted'),
          detail: who ? loc('mastery.bank.countedFor', { label: who, time }) : loc('mastery.bank.nextIn', { time }),
          title: who ? loc('mastery.bank.countedTitle', { label: who, time }) : loc('mastery.bank.countedTitlePlain', { time }),
        }
      : { filled: false, state: loc('mastery.bank.open'), detail: loc('mastery.bank.countsNow'), title: loc('mastery.bank.openTitle') },
  ];
  const places = Math.max(bank.max, bank.queue.length);
  for (let i = 0; i < places; i++) {
    const id = bank.queue[i];
    if (!id) {
      hours.push({ filled: false, state: loc('mastery.bank.empty'), detail: '', title: loc('mastery.bank.emptyTitle') });
      continue;
    }
    const wait = left(bank.payMs) + i * bank.intervalMs;
    const when = wait > 0 ? minutesText(wait) : '';
    const rule = bank.offline ? loc('mastery.bank.offline') : loc('mastery.bank.online');
    hours.push({
      filled: true,
      state: loc('mastery.bank.pending'),
      detail: when ? loc('mastery.bank.pendingFor', { label: label(id), time: when }) : loc('mastery.bank.pendingSoon', { label: label(id) }),
      title: when ? loc('mastery.bank.pendingTitle', { label: label(id), time: when, rule }) : loc('mastery.bank.pendingTitleSoon', { label: label(id) }),
    });
  }
  return hours;
};

// The hour counting now and the banked hours in pay order; the countdowns tick locally between the server's pushes
const HourBank = ({ bank, professions, slots }: { bank: MasteryBank; professions: Profession[]; slots: MasterySlot[] }) => {
  const [now, setNow] = useState(Date.now());
  const running = bank.countedMs > 0 || bank.queue.length > 0;
  useEffect(() => {
    setNow(Date.now());
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), BANK_TICK_MS);
    return () => clearInterval(timer);
  }, [bank.at, running]);
  const left = (ms: number): number => Math.max(0, ms - Math.max(0, now - bank.at));
  const label = (id: string): string => {
    const p = professions.filter((x) => x.id === id)[0];
    const s = slots.filter((x) => x.profession === id)[0];
    return (p && p.label) || (s && s.label) || id;
  };
  return (
    <div className="mastery__bank">
      <div className="mastery__bank-rule">
        <span className="mastery__bank-title">{loc('mastery.bank.title')}</span>
        {bank.offline ? loc('mastery.bank.ruleOffline') : loc('mastery.bank.ruleOnline')}
      </div>
      <div className="mastery__bank-hours">
        {bankHours(bank, label, left).map((h, i) => (
          <div key={i} className={'mastery__bank-hour' + (h.filled ? ' mastery__bank-hour--filled' : '')} title={h.title}>
            {loc('mastery.bank.hour', { n: i + 1, state: h.state })}
            <span className="mastery__bank-detail">{h.detail || '\u00a0'}</span>
          </div>
        ))}
      </div>
    </div>
  );
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
  // The strip shows once a craft is held
  const bank = data.bank && (multi ? slots.some((s) => !!s.profession) : !!chosen) ? data.bank : null;

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
    if (i === 0) return loc('mastery.everyone');
    if (ladder[i] === undefined) return '';
    if (sub && i === 1) return loc('mastery.freeWorkHours', { hours: hoursText(ladder[i]) });
    return ladder[i] === 0 ? loc('mastery.fromStart') : loc('mastery.hourMany', { n: ladder[i] });
  };

  const resetSlot = resetting ? heldBy(resetting) : undefined;
  const resetLabel = resetting ? (professions.filter((p) => p.id === resetting)[0] || { label: resetting }).label : '';

  return (
    <div className={embedded ? 'mastery mastery--embedded' : 'mastery'}>
      {embedded ? null : <div className="mastery__fade" />}
      <div className={'mastery__frame' + (multi ? ' mastery__frame--slots' : '') + (bank ? ' mastery__frame--bank' : '')}>
        {embedded ? null : <div className="mastery__corner">{loc('mastery.corner')}</div>}
        <h1 className="mastery__title">{current ? loc('mastery.titleFor', { label: current.label }) : loc('mastery.title')}</h1>

        {bank ? <HourBank bank={bank} professions={professions} slots={data.slots || []} /> : null}

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
                  {loc('mastery.atTheCraft', { hours: hoursText(hours) })}
                  <br />
                  <span className="mastery__played--muted mastery__played--hint">
                    {own ? progressText(own) : loc('mastery.progress.primary')}
                  </span>
                  {ev.reset && resetsLeft > 0 ? (
                    <button className="mastery__cancel mastery__reset" onClick={() => setResetting(current.id)}>
                      {own ? loc('mastery.resetSlot', { slot: slotWord(own), n: resetsLeft }) : loc('mastery.resetProfession', { n: resetsLeft })}
                    </button>
                  ) : null}
                </p>
              ) : multi ? (
                openSlot ? (
                  <button className="mastery__choose" disabled={committing} onClick={() => setConfirming(current.id)}>
                    {committing ? loc('mastery.takingUp') : loc('mastery.takeUpSlot', { slot: slotWord(openSlot) })}
                  </button>
                ) : (
                  <p className="mastery__played mastery__played--muted">{loc('mastery.slotsTaken')}</p>
                )
              ) : chosen ? (
                <p className="mastery__played mastery__played--muted">{loc('mastery.otherCraft')}</p>
              ) : (
                <button
                  className="mastery__choose"
                  disabled={committing}
                  onClick={() => setConfirming(current.id)}
                >
                  {committing ? loc('mastery.takingUp') : loc('mastery.takeUp')}
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
                  {work ? <p className="mastery__rank-work">{loc('mastery.towardNovice', { work })}</p> : null}
                  <span className="mastery__rank-cost">{costText(i)}</span>
                </div>
              );
            })}
          </section>
        ) : null}

        {embedded ? null : <button className="mastery__close" onClick={() => send(ev.close)}>{loc('common.close')}</button>}

        {resetting && ev.reset ? (
          <ConfirmDialog
            title={resetSlot ? loc('mastery.reset.slotTitle', { slot: slotWord(resetSlot) }) : loc('mastery.reset.title')}
            body={resetSlot
              ? (resetsLeft === 1 ? loc('mastery.reset.slotBodyOne', { label: resetLabel, slot: slotWord(resetSlot), n: resetsLeft }) : loc('mastery.reset.slotBodyMany', { label: resetLabel, slot: slotWord(resetSlot), n: resetsLeft }))
              : (resetsLeft === 1 ? loc('mastery.reset.bodyOne', { n: resetsLeft }) : loc('mastery.reset.bodyMany', { n: resetsLeft }))}
            confirmLabel={loc('mastery.reset.confirm')}
            cancelLabel={loc('mastery.reset.cancel')}
            onConfirm={() => {
              send(ev.reset as string, resetting);
              setResetting(null);
            }}
            onCancel={() => setResetting(null)}
          />
        ) : null}

        {confirming && current ? (
          <ConfirmDialog
            title={loc('mastery.choose.title', { label: current.label })}
            body={multi && openSlot
              ? pickText(openSlot, current.label, resetsLeft)
              : loc('mastery.choose.body', { times: resetsLeft === 1 ? loc('mastery.choose.once') : loc('mastery.choose.times', { n: resetsLeft }) })}
            confirmLabel={loc('mastery.choose.confirm')}
            cancelLabel={loc('mastery.choose.cancel')}
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
