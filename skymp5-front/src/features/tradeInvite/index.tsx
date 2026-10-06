import React from 'react';

import './styles.scss';
import { loc } from '../../loc';

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
        <h2 className="trade-invite__title">{loc('tradeInvite.title')}</h2>
        <p className="trade-invite__body">{loc('tradeInvite.body', { name: data.from || loc('tradeInvite.someone') })}</p>
        <div className="trade-invite__actions">
          <button className="trade-invite__button trade-invite__button--primary" onClick={() => send(ev.accept)}>
            {loc('common.accept')}
          </button>
          <button className="trade-invite__button trade-invite__button--quiet" onClick={() => send(ev.decline)}>
            {loc('common.decline')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TradeInvite;
