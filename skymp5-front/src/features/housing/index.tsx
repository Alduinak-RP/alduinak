import React, { useEffect, useState } from 'react';

import './styles.scss';

interface HousingEvents {
  claim: string;
  abandon: string;
  revoke: string;
  lock: string;
  unlock: string;
  transfer: string;
  rename: string;
  createKey: string;
  revokeKeys: string;
  grantContainer: string;
  cancel: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface HousingData {
  targetLabel: string;
  view: 'owner' | 'manager' | 'claimable' | 'denied';
  owned: boolean;
  name: string | null;
  locked: boolean;
  hasKeys: boolean;
  canGrantContainers: boolean;
  ownerName: string | null;
  events: HousingEvents;
}

// Mirrors cleanName in the server's housingSystem.
const NAME_CHARS = /^[A-Za-z0-9 '_-]+$/;

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

  const [rename, setRename] = useState(data.name || '');

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

  const status = manages
    ? (isOwner ? 'Yours' : 'Managed') + (data.locked ? ' · locked' : ' · unlocked')
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

        {!manages ? (
          <p className="housing__empty">
            {view === 'claimable' ? 'Nobody has claimed this yet.' : "This isn't yours."}
          </p>
        ) : null}

        <div className="housing__actions">
          {view === 'claimable' || (isManager && !data.owned) ? (
            <button className="housing__button housing__button--primary" onClick={() => send(ev.claim)}>
              Claim
            </button>
          ) : null}

          {manages && data.owned ? (
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
            <button className="housing__button" onClick={() => send(ev.revokeKeys)}>Void all keys</button>
          ) : null}

          {manages ? (
            <button className="housing__button" onClick={() => send(ev.transfer)}>
              {isOwner ? 'Transfer' : 'Grant ownership'}
            </button>
          ) : null}

          {isOwner ? (
            <button className="housing__button housing__button--danger" onClick={() => send(ev.abandon)}>
              Give up
            </button>
          ) : null}

          {isManager && data.owned ? (
            <button className="housing__button housing__button--danger" onClick={() => send(ev.revoke)}>
              Revoke ownership
            </button>
          ) : null}

          {manages && data.canGrantContainers ? (
            <button className="housing__button" onClick={() => send(ev.grantContainer)}>
              Grant this container
            </button>
          ) : null}
        </div>

        {manages ? (
          <div className="housing__rename">
            <input
              className="housing__input"
              placeholder="name this property"
              maxLength={32}
              spellCheck={false}
              value={rename}
              onChange={(e) => setRename(e.target.value)}
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
    </div>
  );
};

export default Housing;
