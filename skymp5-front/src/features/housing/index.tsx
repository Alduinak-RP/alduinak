import React, { useEffect, useState } from 'react';

import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';
import { PaperReader, useEscapeLayer } from '../parchment';
import { sealMark } from '../writing';
import './styles.scss';

interface HousingEvents {
  claim: string;
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
  events: HousingEvents;
}

// Mirrors cleanName in the server's housingSystem.
const NAME_CHARS = /^[A-Za-z0-9 '_-]+$/;

// Actions that ask before they go to the server
type Pending = 'voidKeys' | 'giveUp' | 'breakLock' | 'pinNote';

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
  const displayName = data.name || data.targetLabel || 'Property';
  const isOwner = view === 'owner';
  const isManager = view === 'manager';
  const manages = isOwner || isManager;
  const hasAccess = manages || view === 'keyholder';
  const canLock = hasAccess && data.canLock !== false;

  const note = data.note || null;
  const letters = data.letters || [];

  const [rename, setRename] = useState(data.name || '');
  const [pending, setPending] = useState<Pending | null>(null);
  const [reading, setReading] = useState(false);
  const [pick, setPick] = useState('');

  const confirms: Record<Pending, { title: string; body: React.ReactNode; label: string; event: string; args?: unknown[] }> = {
    voidKeys: {
      title: 'Void all keys?',
      body: 'Every key cut for this property stops working, including the ones you hold.',
      label: 'Void keys',
      event: ev.revokeKeys,
    },
    giveUp: { title: `Give up ${displayName}?`, body: 'Anyone may claim it afterwards.', label: 'Give up', event: ev.abandon },
    breakLock: {
      title: `Break the lock on ${displayName}?`,
      body: 'The owner and every key holder lose it, every key stops working and anyone may claim it.',
      label: 'Break lock',
      event: ev.breakLock,
    },
    pinNote: {
      title: 'Pin which note?',
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
          It leaves your pack. Whoever takes it down gets it.
        </>
      ),
      label: 'Pin it',
      event: ev.pinNote,
      args: [pick],
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
    ? ` · entrance ${data.lockedEntrance ? 'locked' : 'open'} · exit ${data.lockedExit ? 'locked' : 'open'}`
    : (data.locked ? ' · locked' : ' · unlocked');
  const status = hasAccess
    ? (isOwner ? 'Yours' : isManager ? 'Managed' : 'Key holder') + lockState
    : (data.owned ? 'Owned by another' : 'Unclaimed');

  return (
    <div className="housing">
      <div className="housing__fade" />
      <div className="housing__panel">
        <div className="housing__header">
          <h2 className="housing__title">{displayName}</h2>
          <span className={'housing__status' + (data.locked ? ' housing__status--locked' : '')}>{status}</span>
        </div>

        {data.ownerName && !isOwner ? (
          <p className="housing__owner">Owner: {data.ownerName}</p>
        ) : null}

        {data.hold ? <p className="housing__owner">Hold: {data.hold}</p> : null}

        {note ? (
          <button className="housing__note" onClick={() => setReading(true)}>
            <span className="housing__note-label">{note.mine ? 'Your note is pinned here' : 'A note is pinned here'}</span>
            <span className="housing__note-title">{note.title}</span>
            <span className="housing__note-text">{note.text}</span>
          </button>
        ) : null}

        {!hasAccess ? (
          <p className="housing__empty">
            {view === 'claimable' ? 'Nobody has claimed this yet. Claiming uses up one lock.' : "This isn't yours."}
          </p>
        ) : null}

        <div className="housing__actions">
          {view === 'claimable' || (isManager && !data.owned) ? (
            <button className="housing__button housing__button--primary" onClick={() => send(ev.claim)}>
              Claim
            </button>
          ) : null}

          {canLock && data.owned && data.sides ? (
            <>
              <button
                className="housing__button housing__button--primary"
                onClick={() => send(data.lockedEntrance ? ev.unlockEntrance : ev.lockEntrance)}
              >
                {data.lockedEntrance ? 'Unlock Entrance' : 'Lock Entrance'}
              </button>
              <button
                className="housing__button housing__button--primary"
                onClick={() => send(data.lockedExit ? ev.unlockExit : ev.lockExit)}
              >
                {data.lockedExit ? 'Unlock Exit' : 'Lock Exit'}
              </button>
            </>
          ) : null}

          {canLock && data.owned && !data.sides ? (
            <button
              className="housing__button housing__button--primary"
              onClick={() => send(data.locked ? ev.unlock : ev.lock)}
            >
              {data.locked ? 'Unlock' : 'Lock'}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button" onClick={() => send(ev.createKey)}>Cut a key</button>
          ) : null}

          {manages && data.hasKeys ? (
            <button className="housing__button" onClick={() => setPending('voidKeys')}>Void all keys</button>
          ) : null}

          {manages ? (
            <button className="housing__button" onClick={() => send(ev.transfer)}>
              {isOwner ? 'Transfer' : 'Grant ownership'}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button housing__button--danger" onClick={() => setPending('giveUp')}>
              Give up
            </button>
          ) : null}

          {isManager && data.owned ? (
            <button className="housing__button housing__button--danger" onClick={() => setPending('breakLock')}>
              Break lock
            </button>
          ) : null}

          {manages && data.canGrantContainers ? (
            <button className="housing__button" onClick={() => send(ev.grantContainer)}>
              Grant this container
            </button>
          ) : null}

          {data.pets ? (
            <button className="housing__button" onClick={() => send(ev.pets)}>Pets</button>
          ) : null}

          {letters.length > 0 && ev.pinNote ? (
            <button className="housing__button" onClick={openPicker}>Pin a note</button>
          ) : null}

          {note && note.canTakeDown ? (
            <button className="housing__button" onClick={() => send(ev.takeNote)}>Take down the note</button>
          ) : null}

          {data.canKnock && ev.knock ? (
            <button className="housing__button" onClick={() => send(ev.knock)}>Knock</button>
          ) : null}
        </div>

        {isOwner && data.sides ? (
          <p className="housing__hint">A locked entrance stops everyone coming in, a locked exit everyone going out, you included, until it is unlocked here. Leave the exit open and nobody is shut inside. A key lets its holder lock and unlock both too: trade it or leave it in a chest. Void all keys cancels every copy.</p>
        ) : null}

        {isOwner && !data.sides ? (
          <p className="housing__hint">A locked door stops everyone, you included, until it is unlocked here. A key lets its holder lock and unlock it too: trade it or leave it in a chest. Void all keys cancels every copy.</p>
        ) : null}

        {manages ? (
          <div className="housing__rename">
            <input
              className="housing__input"
              placeholder="name this property"
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
              Save
            </button>
          </div>
        ) : null}

        {manages && rename.trim() && !NAME_CHARS.test(rename.trim()) ? (
          <p className="housing__hint">Letters, numbers, spaces, apostrophes and dashes only.</p>
        ) : null}

        <div className="housing__footer">
          <button className="housing__button housing__button--quiet" onClick={() => send(ev.cancel)}>
            Close
          </button>
        </div>
      </div>
      {note && reading ? (
        <PaperReader
          heading={note.title}
          text={note.text}
          byline={note.byline}
          mark={sealMark(note.signFaction, true)}
          meta={note.brokenSeals}
          wide
          onBack={() => setReading(false)}
        >
          {note.canTakeDown ? (
            <button className="parchment__button" onClick={() => send(ev.takeNote)}>Take it down</button>
          ) : null}
          <button className="parchment__button parchment__button--primary" onClick={() => setReading(false)}>Back</button>
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
