import React, { useEffect, useState } from 'react';

import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';
import { PaperReader, useEscapeLayer } from '../parchment';
import { Markup, plainText, sealMark } from '../writing';
import './styles.scss';
import { loc } from '../../loc';

interface HousingEvents {
  claim: string;
  claimFaction?: string;
  abandon: string;
  breakLock: string;
  lock: string;
  unlock: string;
  lockEntrance: string;
  unlockEntrance: string;
  lockExit: string;
  unlockExit: string;
  transfer: string;
  rename: string;
  createKey: string;
  revokeKeys: string;
  grantContainer: string;
  pets: string;
  pinNote: string;
  takeNote: string;
  knock: string;
  cancel: string;
  typing: string;
  [key: string]: string;
}

// The letter pinned to the door half the menu was opened at (housingSystem.ts noteFor)
interface DoorNote {
  title: string;
  text: string;
  byline: string;
  signFaction: string;
  brokenSeals: string[];
  mine: boolean;
  canTakeDown: boolean;
}

interface PinnableLetter {
  id: string;
  title: string;
}

// The faction owning a faction claim; role is the viewer's standing in it
interface OwningFaction {
  id: string;
  name: string;
  role: 'manager' | 'member' | '';
}

interface FactionChoice {
  id: string;
  name: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface HousingData {
  targetLabel: string;
  view: 'owner' | 'manager' | 'keyholder' | 'claimable' | 'denied';
  owned: boolean;
  name: string | null;
  locked: boolean;
  lockedEntrance?: boolean;
  lockedExit?: boolean;
  sides?: boolean; // A door from outdoors into an interior: the entrance and the exit lock apart
  canLock?: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
  pets?: string; // "stable" | "farm" | "house" when pets are kept at this door, else ""
  hold?: string; // The hold the property lies in, "" outside every hold
  note?: DoorNote | null;
  letters?: PinnableLetter[]; // Letters this viewer may pin here now
  canKnock?: boolean; // A door anyone may knock on
  faction?: OwningFaction | null; // Set on a faction claim
  claimFactions?: FactionChoice[]; // Factions this viewer may claim this for, or hand their own claim to
  events: HousingEvents;
}

// Mirrors cleanName in the server's housingSystem.
const NAME_CHARS = /^[A-Za-z0-9 '_-]+$/;
// Only read while the server sends sides (housingSystem's SIDED_LOCKS): false offers no Lock Exit, true brings it back with EXIT_LOCKS there
const EXIT_LOCKS = false;

// Actions that ask before they go to the server
type Pending = 'voidKeys' | 'giveUp' | 'breakLock' | 'pinNote' | 'giveFaction';

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('housing sendMessage', key, args);
  }
};

const Housing = ({ data }: { data: HousingData }) => {
  const ev = data.events || ({} as HousingEvents);
  const view = data.view || 'denied';
  const displayName = data.name || data.targetLabel || loc('housing.property');
  const isOwner = view === 'owner';
  const isManager = view === 'manager';
  const manages = isOwner || isManager;
  const hasAccess = manages || view === 'keyholder';
  const canLock = hasAccess && data.canLock !== false;

  const note = data.note || null;
  const letters = data.letters || [];
  const faction = data.faction || null;
  const claimFactions = ev.claimFaction ? data.claimFactions || [] : [];
  const canClaim = view === 'claimable' || (isManager && !data.owned);

  const [rename, setRename] = useState(data.name || '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [reading, setReading] = useState(false);
  const [pick, setPick] = useState('');
  const [giveTo, setGiveTo] = useState<FactionChoice | null>(null);

  const confirms: Record<Pending, { title: string; body: React.ReactNode; label: string; event: string; args?: unknown[] }> = {
    voidKeys: {
      title: loc('housing.confirm.voidKeysTitle'),
      body: loc('housing.confirm.voidKeysBody'),
      label: loc('housing.confirm.voidKeysLabel'),
      event: ev.revokeKeys,
    },
    giveUp: {
      title: loc('housing.confirm.giveUpTitle', { name: displayName }),
      body: loc('housing.confirm.giveUpBody'),
      label: loc('housing.confirm.giveUpLabel'),
      event: ev.abandon,
    },
    breakLock: {
      title: loc('housing.confirm.breakLockTitle', { name: displayName }),
      body: loc('housing.confirm.breakLockBody'),
      label: loc('housing.confirm.breakLockLabel'),
      event: ev.breakLock,
    },
    pinNote: {
      title: loc('housing.confirm.pinNoteTitle'),
      body: (
        <>
          <span className="housing__pick">
            {letters.map((l) => (
              <label key={l.id} className="housing__pick-row">
                <input type="radio" name="housing-pick" checked={pick === l.id} onChange={() => setPick(l.id)} />
                <span>{l.title}</span>
                <span className="housing__pick-id">{l.id}</span>
              </label>
            ))}
          </span>
          {loc('housing.confirm.pinNoteBody')}
        </>
      ),
      label: loc('housing.confirm.pinNoteLabel'),
      event: ev.pinNote,
      args: [pick],
    },
    giveFaction: {
      title: loc('housing.confirm.giveFactionTitle', { name: displayName, faction: giveTo ? giveTo.name : loc('housing.confirm.theFaction') }),
      body: loc('housing.confirm.giveFactionBody'),
      label: loc('housing.confirm.giveFactionLabel'),
      event: ev.claimFaction || '',
      args: [giveTo ? giveTo.id : ''],
    },
  };
  const dialog = pending ? confirms[pending] : null;

  const openPicker = (): void => {
    setPick(letters.length ? letters[0].id : '');
    setPending('pinNote');
  };

  useEscapeLayer(reading, () => setReading(false));

  // A note taken down or crumbled closes its reader
  useEffect(() => {
    if (!note) setReading(false);
  }, [note]);

  // The client tears the widget down on close, but a re-push while it is open
  // (after lock, rename, ...) keeps this instance - follow the server's name.
  useEffect(() => {
    setRename(data.name || '');
  }, [data.name]);

  useEffect(() => {
    const onUnfocused = () => send(ev.cancel);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, []);

  const lockState = data.sides
    ? loc('housing.status.entrance', { state: data.lockedEntrance ? loc('housing.status.locked') : loc('housing.status.open') }) +
      (EXIT_LOCKS ? loc('housing.status.exit', { state: data.lockedExit ? loc('housing.status.locked') : loc('housing.status.open') }) : '')
    : (data.locked ? loc('housing.status.lockedSuffix') : loc('housing.status.unlockedSuffix'));
  const holder = faction && faction.role ? loc('housing.status.factions') : isOwner ? loc('housing.status.yours') : isManager ? loc('housing.status.managed') : loc('housing.status.keyHolder');
  const status = hasAccess ? holder + lockState : (data.owned ? loc('housing.status.ownedByAnother') : loc('housing.status.unclaimed'));

  return (
    <div className="housing">
      <div className="housing__fade" />
      <div className="housing__panel">
        <div className="housing__header">
          <h2 className="housing__title">{displayName}</h2>
          <span className={'housing__status' + (data.locked ? ' housing__status--locked' : '')}>{status}</span>
        </div>

        {data.ownerName && (!isOwner || faction) ? (
          <p className="housing__owner">{loc('housing.owner', { name: data.ownerName })}</p>
        ) : null}

        {data.hold ? <p className="housing__owner">{loc('housing.territory', { hold: data.hold })}</p> : null}

        {note ? (
          <button className="housing__note" onClick={() => setReading(true)}>
            <span className="housing__note-label">{note.mine ? loc('housing.noteMine') : loc('housing.noteOther')}</span>
            <span className="housing__note-title">{note.title}</span>
            <span className="housing__note-text">{plainText(note.text)}</span>
          </button>
        ) : null}

        {!hasAccess ? (
          <p className="housing__empty">
            {view === 'claimable' ? loc('housing.claimable') : loc('housing.notYours')}
          </p>
        ) : null}

        {canClaim && claimFactions.length > 0 ? (
          <p className="housing__hint">{loc('housing.factionClaimHint')}</p>
        ) : null}

        <div className="housing__actions">
          {canClaim ? (
            <button className="housing__button housing__button--primary" onClick={() => send(ev.claim)}>
              {loc('housing.claim')}
            </button>
          ) : null}

          {canClaim
            ? claimFactions.map((f) => (
                <button
                  key={f.id}
                  className="housing__button housing__button--primary"
                  onClick={() => send(ev.claimFaction || '', f.id)}
                >
                  {loc('housing.claimFor', { name: f.name })}
                </button>
              ))
            : null}

          {canLock && data.owned && data.sides ? (
            <>
              <button
                className="housing__button housing__button--primary"
                onClick={() => send(data.lockedEntrance ? ev.unlockEntrance : ev.lockEntrance)}
              >
                {data.lockedEntrance ? loc('housing.unlockEntrance') : loc('housing.lockEntrance')}
              </button>
              {EXIT_LOCKS ? (
                <button
                  className="housing__button housing__button--primary"
                  onClick={() => send(data.lockedExit ? ev.unlockExit : ev.lockExit)}
                >
                  {data.lockedExit ? loc('housing.unlockExit') : loc('housing.lockExit')}
                </button>
              ) : null}
            </>
          ) : null}

          {canLock && data.owned && !data.sides ? (
            <button
              className="housing__button housing__button--primary"
              onClick={() => send(data.locked ? ev.unlock : ev.lock)}
            >
              {data.locked ? loc('housing.unlock') : loc('housing.lock')}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button" onClick={() => send(ev.createKey)}>{loc('housing.cutKey')}</button>
          ) : null}

          {manages && data.hasKeys ? (
            <button className="housing__button" onClick={() => setPending('voidKeys')}>{loc('housing.voidAllKeys')}</button>
          ) : null}

          {manages ? (
            <button className="housing__button" onClick={() => send(ev.transfer)}>
              {isOwner ? loc('housing.transfer') : loc('housing.grantOwnership')}
            </button>
          ) : null}

          {isOwner && !faction && data.owned
            ? claimFactions.map((f) => (
                <button
                  key={f.id}
                  className="housing__button"
                  onClick={() => {
                    setGiveTo(f);
                    setPending('giveFaction');
                  }}
                >
                  {loc('housing.giveTo', { name: f.name })}
                </button>
              ))
            : null}

          {isOwner ? (
            <button className="housing__button housing__button--danger" onClick={() => setPending('giveUp')}>
              {loc('housing.giveUp')}
            </button>
          ) : null}

          {isManager && data.owned ? (
            <button className="housing__button housing__button--danger" onClick={() => setPending('breakLock')}>
              {loc('housing.breakLock')}
            </button>
          ) : null}

          {manages && data.canGrantContainers ? (
            <button className="housing__button" onClick={() => send(ev.grantContainer)}>
              {loc('housing.grantContainer')}
            </button>
          ) : null}

          {data.pets ? (
            <button className="housing__button" onClick={() => send(ev.pets)}>{loc('housing.pets')}</button>
          ) : null}

          {letters.length > 0 && ev.pinNote ? (
            <button className="housing__button" onClick={openPicker}>{loc('housing.pinNote')}</button>
          ) : null}

          {note && note.canTakeDown ? (
            <button className="housing__button" onClick={() => send(ev.takeNote)}>{loc('housing.takeDownNote')}</button>
          ) : null}

          {data.canKnock && ev.knock ? (
            <button className="housing__button" onClick={() => send(ev.knock)}>{loc('housing.knock')}</button>
          ) : null}
        </div>

        {isOwner && data.sides ? (
          <p className="housing__hint">{EXIT_LOCKS
            ? loc('housing.hintSidesExit')
            : loc('housing.hintSides')}</p>
        ) : null}

        {isOwner && !data.sides ? (
          <p className="housing__hint">{loc('housing.hintDoor')}</p>
        ) : null}

        {faction && faction.role ? (
          <p className="housing__hint">
            {faction.role === 'manager'
              ? loc('housing.factionManagerHint', { faction: faction.name })
              : loc('housing.factionMemberHint', { faction: faction.name })}
          </p>
        ) : null}

        {manages ? (
          <div className="housing__rename">
            <input
              className="housing__input"
              placeholder={loc('housing.namePlaceholder')}
              maxLength={32}
              spellCheck={false}
              value={rename}
              onChange={(e) => setRename(e.target.value)}
              onFocus={() => ev.typing && send(ev.typing)}
            />
            <button
              className="housing__button"
              disabled={!rename.trim() || !NAME_CHARS.test(rename.trim())}
              onClick={() => send(ev.rename, rename.trim())}
            >
              {loc('common.save')}
            </button>
          </div>
        ) : null}

        {manages && rename.trim() && !NAME_CHARS.test(rename.trim()) ? (
          <p className="housing__hint">{loc('housing.nameChars')}</p>
        ) : null}

        <div className="housing__footer">
          <button className="housing__button housing__button--quiet" onClick={() => send(ev.cancel)}>
            {loc('common.close')}
          </button>
        </div>
      </div>
      {note && reading ? (
        <PaperReader
          heading={note.title}
          text={note.text}
          body={<Markup text={note.text} />}
          byline={note.byline}
          mark={sealMark(note.signFaction, true)}
          meta={note.brokenSeals}
          note
          onBack={() => setReading(false)}
        >
          {note.canTakeDown ? (
            <button className="parchment__button" onClick={() => send(ev.takeNote)}>{loc('housing.takeItDown')}</button>
          ) : null}
          <button className="parchment__button parchment__button--primary" onClick={() => setReading(false)}>{loc('common.back')}</button>
        </PaperReader>
      ) : null}
      {dialog ? (
        <ConfirmDialog
          title={dialog.title}
          body={dialog.body}
          confirmLabel={dialog.label}
          onConfirm={() => {
            send(dialog.event, ...(dialog.args || []));
            setPending(null);
          }}
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
};

export default Housing;
