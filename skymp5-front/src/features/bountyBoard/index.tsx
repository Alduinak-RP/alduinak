import React, { useEffect, useState } from 'react';

import { PaperComposer, PaperReader, sendToClient as send, useCloseOnUnfocus, useEscapeLayer } from '../parchment';
import './styles.scss';

interface BoardNote {
  id: number;
  author: string;
  text: string;
  ageHours: number;
}

interface BoardEvents {
  post: string;
  remove: string;
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
  canRemove: boolean;
  notes: BoardNote[];
  events: BoardEvents;
}

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

  useCloseOnUnfocus(ev.close);

  // While a paper or the compose dialog is up, Escape backs out one layer rather than closing the board.
  useEscapeLayer(composing || selectedId !== null, () => {
    if (composing) setComposing(false);
    else setSelectedId(null);
  });

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
          <span className="parchment__hint">
            {'A notice costs ' + data.costGold + ' gold and fades after ' + data.expiryDays + ' days. You carry ' + data.gold + ' gold.'}
          </span>
          <div className="parchment__actions">
            <button
              className="parchment__button parchment__button--primary"
              disabled={full || !canAfford}
              onClick={() => setComposing(true)}
            >
              {full ? 'The board is full' : canAfford ? 'Pin a notice' : 'Not enough gold'}
            </button>
            <button className="parchment__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>

        {selected ? (
          <PaperReader
            text={selected.text}
            byline={'\u2014 ' + selected.author}
            meta={[pinnedLabel(selected.ageHours) + ' \u00b7 ' + fadesLabel(selected.ageHours, data.expiryDays)]}
            onBack={() => setSelectedId(null)}
          >
            <button className="parchment__button" onClick={() => setSelectedId(null)}>Back</button>
            {data.canRemove ? <button className="parchment__button" onClick={() => send(ev.remove, selected.id)}>Remove notice</button> : null}
          </PaperReader>
        ) : null}

        {composing ? (
          <PaperComposer
            heading="Pin a notice"
            value={draft}
            maxLength={data.maxTextLen}
            placeholder="What should the hold read here?"
            hint={draft.length + ' / ' + data.maxTextLen + ' · ' + data.costGold + ' gold'}
            onChange={setDraft}
          >
            <button className="parchment__button parchment__button--primary" disabled={!trimmed} onClick={submit}>
              {'Post for ' + data.costGold + ' gold'}
            </button>
            <button className="parchment__button" onClick={() => setComposing(false)}>Cancel</button>
          </PaperComposer>
        ) : null}
      </div>
    </div>
  );
};

export default BountyBoard;
