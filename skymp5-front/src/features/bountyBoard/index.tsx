import React, { useEffect, useState } from 'react';

import './styles.scss';

interface BoardNote {
  id: number;
  author: string;
  text: string;
  ageHours: number;
}

interface BoardEvents {
  post: string;
  close: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface BountyBoardData {
  boardName: string;
  costGold: number;
  gold: number;
  maxTextLen: number;
  maxNotes: number;
  expiryDays: number;
  notes: BoardNote[];
  events: BoardEvents;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('bountyBoard sendMessage', key, args);
  }
};

const pinnedLabel = (ageHours: number): string => {
  if (ageHours < 24) return 'Pinned today';
  if (ageHours < 48) return 'Pinned yesterday';
  return 'Pinned ' + Math.floor(ageHours / 24) + ' days ago';
};

const fadesLabel = (ageHours: number, expiryDays: number): string => {
  const daysLeft = expiryDays - Math.floor(ageHours / 24);
  if (daysLeft <= 1) return 'Fades soon';
  return 'Fades in ' + daysLeft + ' days';
};

const BountyBoard = ({ data }: { data: BountyBoardData }) => {
  const ev = data.events || ({} as BoardEvents);
  const notes = data.notes || [];

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');

  const selected = notes.filter((n) => n.id === selectedId)[0] || null;

  // A refresh can pull the note being read off the board.
  useEffect(() => {
    if (selectedId !== null && !selected) setSelectedId(null);
  }, [notes, selectedId, selected]);

  // The draft survives a rejected post (cooldown, distance, gold); it only
  // clears once the server shows the note pinned.
  useEffect(() => {
    if (composing || !draft) return;
    const t = draft.trim();
    if (t && notes.filter((n) => n.text === t).length) setDraft('');
  }, [notes, composing, draft]);

  useEffect(() => {
    const onUnfocused = () => send(ev.close);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.close]);

  // index.js fires menu:escape globally; while a paper or the compose dialog
  // is up, Escape should back out one layer rather than close the board.
  useEffect(() => {
    if (!composing && selectedId === null) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      if (composing) setComposing(false);
      else setSelectedId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [composing, selectedId]);

  const full = notes.length >= data.maxNotes;
  const canAfford = data.gold >= data.costGold;
  const trimmed = draft.trim();

  const submit = () => {
    if (!trimmed) return;
    send(ev.post, trimmed);
    setComposing(false);
  };

  return (
    <div className="bountyBoard">
      <div className="bountyBoard__fade" />
      <div className="bountyBoard__frame">
        <h1 className="bountyBoard__title">{data.boardName} Notice Board</h1>

        {notes.length ? (
          <div className="bountyBoard__grid">
            {notes.map((n) => (
              <button key={n.id} className="bountyBoard__paper" onClick={() => setSelectedId(n.id)}>
                <span className="bountyBoard__paper-text">{n.text}</span>
                <span className="bountyBoard__paper-author">{n.author}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="bountyBoard__empty">Nothing is pinned here yet.</p>
        )}

        <div className="bountyBoard__footer">
          <span className="bountyBoard__hint">
            {'A notice costs ' + data.costGold + ' gold and fades after ' + data.expiryDays + ' days. You carry ' + data.gold + ' gold.'}
          </span>
          <div className="bountyBoard__actions">
            <button
              className="bountyBoard__button bountyBoard__button--primary"
              disabled={full || !canAfford}
              onClick={() => setComposing(true)}
            >
              {full ? 'The board is full' : canAfford ? 'Pin a notice' : 'Not enough gold'}
            </button>
            <button className="bountyBoard__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>

        {selected ? (
          <div className="bountyBoard__shade" onClick={() => setSelectedId(null)}>
            <div className="bountyBoard__read" onClick={(e) => e.stopPropagation()}>
              <p className="bountyBoard__read-text">{selected.text}</p>
              <p className="bountyBoard__read-author">&mdash; {selected.author}</p>
              <p className="bountyBoard__read-age">
                {pinnedLabel(selected.ageHours)} &middot; {fadesLabel(selected.ageHours, data.expiryDays)}
              </p>
              <button className="bountyBoard__button" onClick={() => setSelectedId(null)}>Back</button>
            </div>
          </div>
        ) : null}

        {composing ? (
          <div className="bountyBoard__shade">
            <div className="bountyBoard__compose">
              <h3 className="bountyBoard__compose-title">Pin a notice</h3>
              <textarea
                className="bountyBoard__compose-text"
                value={draft}
                maxLength={data.maxTextLen}
                autoFocus
                placeholder="What should the hold read here?"
                onChange={(e) => setDraft(e.target.value)}
              />
              <div className="bountyBoard__compose-foot">
                <span className="bountyBoard__hint">
                  {draft.length + ' / ' + data.maxTextLen + ' · ' + data.costGold + ' gold'}
                </span>
                <div className="bountyBoard__actions">
                  <button
                    className="bountyBoard__button bountyBoard__button--primary"
                    disabled={!trimmed}
                    onClick={submit}
                  >
                    {'Post for ' + data.costGold + ' gold'}
                  </button>
                  <button className="bountyBoard__button" onClick={() => setComposing(false)}>Cancel</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default BountyBoard;
