import React, { useEffect, useState } from 'react';

import { ConfirmBar, PaperComposer, PaperReader, sendToClient as send, useCloseOnUnfocus, useEscapeLayer } from '../parchment';
import './styles.scss';
import { loc } from '../../loc';

interface BoardNote {
  id: number;
  author: string;
  text: string;
  ageHours: number;
  mine?: boolean;
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
  if (ageHours < 24) return loc('bountyBoard.pinnedToday');
  if (ageHours < 48) return loc('bountyBoard.pinnedYesterday');
  return loc('bountyBoard.pinnedDaysAgo', { n: Math.floor(ageHours / 24) });
};

const fadesLabel = (ageHours: number, expiryDays: number): string => {
  const daysLeft = expiryDays - Math.floor(ageHours / 24);
  if (daysLeft <= 1) return loc('bountyBoard.fadesSoon');
  return loc('bountyBoard.fadesIn', { n: daysLeft });
};

const BountyBoard = ({ data }: { data: BountyBoardData }) => {
  const ev = data.events || ({} as BoardEvents);
  const notes = data.notes || [];

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [draft, setDraft] = useState('');
  const [confirming, setConfirming] = useState(false);

  const selected = notes.filter((n) => n.id === selectedId)[0] || null;

  // A refresh can pull the note being read off the board.
  useEffect(() => {
    if (selectedId !== null && !selected) setSelectedId(null);
  }, [notes, selectedId, selected]);

  useEffect(() => {
    setConfirming(false);
  }, [selectedId]);

  // The draft survives a rejected post (cooldown, distance, gold); it only
  // clears once the server shows the note pinned.
  useEffect(() => {
    if (composing || !draft) return;
    const t = draft.trim();
    if (t && notes.filter((n) => n.text === t).length) setDraft('');
  }, [notes, composing, draft]);

  useCloseOnUnfocus(ev.close);

  // While a paper, its confirm or the compose dialog is up, Escape backs out one layer rather than closing the board.
  useEscapeLayer(composing || selectedId !== null, () => {
    if (composing) setComposing(false);
    else if (confirming) setConfirming(false);
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
        <h1 className="bountyBoard__title">{loc('bountyBoard.title', { name: data.boardName })}</h1>

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
          <p className="bountyBoard__empty">{loc('bountyBoard.empty')}</p>
        )}

        <div className="bountyBoard__footer">
          <span className="parchment__hint">
            {loc('bountyBoard.costHint', { cost: data.costGold, days: data.expiryDays, gold: data.gold })}
          </span>
          <div className="parchment__actions">
            <button
              className="parchment__button parchment__button--primary"
              disabled={full || !canAfford}
              onClick={() => setComposing(true)}
            >
              {full ? loc('bountyBoard.full') : canAfford ? loc('bountyBoard.pinNotice') : loc('bountyBoard.notEnoughGold')}
            </button>
            <button className="parchment__button" onClick={() => send(ev.close)}>{loc('common.close')}</button>
          </div>
        </div>

        {selected ? (
          <PaperReader
            text={selected.text}
            byline={loc('bountyBoard.byline', { author: selected.author })}
            meta={[pinnedLabel(selected.ageHours) + ' \u00b7 ' + fadesLabel(selected.ageHours, data.expiryDays)].concat(selected.mine ? [loc('bountyBoard.yourNotice')] : [])}
            onBack={() => setSelectedId(null)}
          >
            {confirming ? (
              <ConfirmBar
                text={selected.mine ? loc('bountyBoard.confirmTakeDown') : loc('bountyBoard.confirmRemove')}
                onYes={() => {
                  send(ev.remove, selected.id);
                  setConfirming(false);
                }}
                onNo={() => setConfirming(false)}
              />
            ) : (
              <>
                <button className="parchment__button" onClick={() => setSelectedId(null)}>{loc('common.back')}</button>
                {selected.mine || data.canRemove ? (
                  <button className="parchment__button" onClick={() => setConfirming(true)}>
                    {selected.mine ? loc('bountyBoard.takeDown') : loc('bountyBoard.remove')}
                  </button>
                ) : null}
              </>
            )}
          </PaperReader>
        ) : null}

        {composing ? (
          <PaperComposer
            heading={loc('bountyBoard.pinNotice')}
            value={draft}
            maxLength={data.maxTextLen}
            placeholder={loc('bountyBoard.placeholder')}
            hint={loc('bountyBoard.composeHint', { len: draft.length, max: data.maxTextLen, cost: data.costGold })}
            onChange={setDraft}
          >
            <button className="parchment__button parchment__button--primary" disabled={!trimmed} onClick={submit}>
              {loc('bountyBoard.post', { cost: data.costGold })}
            </button>
            <button className="parchment__button" onClick={() => setComposing(false)}>{loc('common.cancel')}</button>
          </PaperComposer>
        ) : null}
      </div>
    </div>
  );
};

export default BountyBoard;
