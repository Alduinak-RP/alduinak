import React, { useState } from 'react';

import './styles.scss';

// One stack as resolved by the client (name already looked up from the baseId).
interface UiItem {
  lineId: string; // identifies the exact entry, extras included; rides add/remove events
  baseId: number;
  count: number;
  name: string;
  tags?: string[];
  equipped?: boolean;
  category?: string; // inventory tab id set by the client, misc when absent
}

interface TradeEvents {
  add: string;
  remove: string;
  lock: string;
  unlock: string;
  accept: string;
  cancel: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface TradeData {
  partnerName: string;
  inventory: UiItem[];
  myOffer: UiItem[];
  theirOffer: UiItem[];
  myLocked: boolean;
  theirLocked: boolean;
  bothLocked: boolean;
  iAccepted: boolean;
  theyAccepted: boolean;
  stackPromptThreshold: number;
  events: TradeEvents;
}

// The inventory pane's tabs in vanilla order; gold is a misc item
const TABS: Array<{ id: string; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'weapons', label: 'Weapons' },
  { id: 'apparel', label: 'Apparel' },
  { id: 'potions', label: 'Potions' },
  { id: 'food', label: 'Food' },
  { id: 'ingredients', label: 'Ingredients' },
  { id: 'books', label: 'Books' },
  { id: 'misc', label: 'Misc' },
];

const inTab = (item: UiItem, tab: string): boolean => tab === 'all' || (item.category || 'misc') === tab;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('trade sendMessage', key, args);
  }
};

interface ItemListProps {
  items: UiItem[];
  emptyText: string;
  onItemClick?: (item: UiItem) => void;
}

// A scrollable column of "<name> (xN)" rows. Clickable when onItemClick is set.
const ItemList = ({ items, emptyText, onItemClick }: ItemListProps) => {
  if (!items || items.length === 0) {
    return <div className="trade__empty">{emptyText}</div>;
  }
  return (
    <div className="trade__list">
      {items.map((item, n) => (
        <div
          key={n + ':' + item.lineId}
          className={'trade__item' + (onItemClick ? ' trade__item--clickable' : '')}
          onClick={onItemClick ? () => onItemClick(item) : undefined}
        >
          <span className="trade__item-name">
            {item.name}
            {(item.tags || []).map((tag) => (
              <span key={tag} className="trade__item-tag">{tag}</span>
            ))}
            {item.equipped ? <span className="trade__item-tag">equipped</span> : null}
          </span>
          {item.count > 1 ? <span className="trade__item-count">{item.count}</span> : null}
        </div>
      ))}
    </div>
  );
};

interface CountPrompt {
  dir: 'add' | 'remove';
  item: UiItem;
}

const Trade = ({ data }: { data: TradeData }) => {
  const [prompt, setPrompt] = useState<CountPrompt | null>(null);
  const [promptCount, setPromptCount] = useState(1);
  const [tab, setTab] = useState('all');

  const ev = data.events || ({} as TradeEvents);
  const threshold = data.stackPromptThreshold || 5;

  const sendMove = (dir: 'add' | 'remove', item: UiItem, count: number): void => {
    send(dir === 'add' ? ev.add : ev.remove, item.lineId, count);
  };

  // Stacks up to the threshold move one per click; larger stacks ask how many
  const clickItem = (dir: 'add' | 'remove', item: UiItem): void => {
    if (item.count > threshold) {
      setPromptCount(1);
      setPrompt({ dir, item });
    } else {
      sendMove(dir, item, 1);
    }
  };

  const confirmPrompt = (): void => {
    if (!prompt) {
      return;
    }
    const n = Math.max(1, Math.min(promptCount, prompt.item.count));
    sendMove(prompt.dir, prompt.item, n);
    setPrompt(null);
  };

  const clampPromptCount = (value: number): void => {
    if (!prompt) {
      return;
    }
    if (Number.isNaN(value)) {
      setPromptCount(1);
      return;
    }
    setPromptCount(Math.max(1, Math.min(Math.floor(value), prompt.item.count)));
  };

  // The Trade button unlocks only when both sides have locked their offers.
  const tradeAvailable = data.bothLocked && !data.iAccepted;

  const inventory = data.inventory || [];
  const shownInventory = inventory.filter((item) => inTab(item, tab));

  return (
    <div className="trade">
      <div className="trade__fade" />
      <div className="trade__window">
        <h2 className="trade__header">Trade with {data.partnerName}</h2>

        <div className="trade__body">
          {/* Left: my offerable inventory */}
          <div className="trade__pane trade__pane--inventory">
            <div className="trade__pane-title">
              Your Inventory <span className="trade__lock">({shownInventory.length})</span>
            </div>
            <div className="trade__tabs">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  className={
                    'trade__tab' +
                    (t.id === tab ? ' trade__tab--active' : '') +
                    (inventory.some((item) => inTab(item, t.id)) ? '' : ' trade__tab--empty')
                  }
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <ItemList
              items={shownInventory}
              emptyText={tab === 'all' ? 'Nothing to trade' : 'Nothing here to trade'}
              onItemClick={(item) => clickItem('add', item)}
            />
          </div>

          {/* Center: cancel / lock / trade */}
          <div className="trade__actions">
            <button className="trade__button trade__button--quiet" onClick={() => send(ev.cancel)}>
              Cancel
            </button>
            <button className="trade__button" onClick={() => send(data.myLocked ? ev.unlock : ev.lock)}>
              {data.myLocked ? 'Unlock' : 'Lock'}
            </button>
            <button
              className="trade__button trade__button--primary"
              disabled={!tradeAvailable}
              onClick={() => send(ev.accept)}
            >
              {data.iAccepted ? 'Waiting…' : 'Trade'}
            </button>
          </div>

          {/* Right: my offer above the partner's offer */}
          <div className="trade__right">
            <div className={'trade__pane trade__pane--offer' + (data.myLocked ? ' trade__pane--locked' : '')}>
              <div className="trade__pane-title">
                Your Offer {data.myLocked ? <span className="trade__lock">[locked]</span> : null}
              </div>
              <ItemList
                items={data.myOffer}
                emptyText="(empty)"
                onItemClick={data.myLocked ? undefined : (item) => clickItem('remove', item)}
              />
            </div>

            <div className={'trade__pane trade__pane--their-offer' + (data.theirLocked ? ' trade__pane--locked' : '')}>
              <div className="trade__pane-title">
                {data.partnerName}&apos;s Offer{' '}
                {data.theirLocked ? <span className="trade__lock">[locked]</span> : null}
                {data.theyAccepted ? <span className="trade__lock">[trading]</span> : null}
              </div>
              <ItemList items={data.theirOffer} emptyText="(empty)" />
            </div>
          </div>
        </div>

        {prompt ? (
          <div className="trade__prompt-overlay">
            <div className="trade__prompt">
              <h3 className="trade__prompt-title">
                {prompt.dir === 'add' ? 'Add how many' : 'Remove how many'} {prompt.item.name}?
              </h3>
              <div className="trade__prompt-row">
                <button className="trade__button trade__button--narrow" onClick={() => clampPromptCount(promptCount - 1)}>
                  -
                </button>
                <input
                  className="trade__prompt-input"
                  type="number"
                  min={1}
                  max={prompt.item.count}
                  value={promptCount}
                  onChange={(e) => clampPromptCount(parseInt(e.target.value, 10))}
                />
                <button className="trade__button trade__button--narrow" onClick={() => clampPromptCount(promptCount + 1)}>
                  +
                </button>
                <button className="trade__button trade__button--narrow" onClick={() => setPromptCount(prompt.item.count)}>
                  All
                </button>
              </div>
              <div className="trade__prompt-row">
                <button className="trade__button trade__button--primary" onClick={confirmPrompt}>
                  Confirm
                </button>
                <button className="trade__button trade__button--quiet" onClick={() => setPrompt(null)}>
                  Back
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default Trade;
