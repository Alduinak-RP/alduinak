import React from 'react';

import './styles.scss';

interface TradeInviteEvents {
  accept: string;
  decline: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface TradeInviteData {
  from: string;
  events: TradeInviteEvents;
}

const send = (key: string): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('tradeInvite sendMessage', key);
  }
};

// Passive prompt: the client leaves input focus with the game, so the free cursor answers it
const TradeInvite = ({ data }: { data: TradeInviteData }) => {
  const ev = data.events || ({} as TradeInviteEvents);

  return (
    <div className="trade-invite">
      <div className="trade-invite__panel">
        <h2 className="trade-invite__title">Trade Request</h2>
        <p className="trade-invite__body">{data.from || 'Someone'} wants to trade with you.</p>
        <div className="trade-invite__actions">
          <button className="trade-invite__button trade-invite__button--primary" onClick={() => send(ev.accept)}>
            Accept
          </button>
          <button className="trade-invite__button trade-invite__button--quiet" onClick={() => send(ev.decline)}>
            Decline
          </button>
        </div>
      </div>
    </div>
  );
};

export default TradeInvite;
