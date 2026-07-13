import React, { useState } from 'react';

import Button from '../../constructorComponents/button';
import './styles.scss';

// One stack as resolved by the client (name already looked up from the baseId).
interface UiItem {
  baseId: number;
  count: number;
  name: string;
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

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) — log instead.
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
      {items.map((item) => (
        <div
          key={item.baseId}
          className={'trade__item' + (onItemClick ? ' trade__item--clickable' : '')}
          onClick={onItemClick ? () => onItemClick(item) : undefined}
        >
          <span className="trade__item-name">{item.name}</span>
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

  const ev = data.events || ({} as TradeEvents);
  const threshold = data.stackPromptThreshold || 5;

  // Small stacks move whole; large stacks ask "how many?" first (like vanilla).
  const clickItem = (dir: 'add' | 'remove', item: UiItem): void => {
    if (item.count > threshold) {
      setPromptCount(1);
      setPrompt({ dir, item });
    } else {
      send(dir === 'add' ? ev.add : ev.remove, item.baseId, item.count);
    }
  };

  const confirmPrompt = (): void => {
    if (!prompt) {
      return;
    }
    const n = Math.max(1, Math.min(promptCount, prompt.item.count));
    send(prompt.dir === 'add' ? ev.add : ev.remove, prompt.item.baseId, n);
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

  const acceptAvailable = data.bothLocked && !data.iAccepted;

  return (
    <div className="trade">
      <div className="trade__window">
        <div className="trade__header">Trade with {data.partnerName}</div>

        <div className="trade__body">
          {/* Left: my offerable inventory */}
          <div className="trade__pane trade__pane--inventory">
            <div className="trade__pane-title">Your Inventory</div>
            <ItemList
              items={data.inventory}
              emptyText="Nothing to trade"
              onItemClick={(item) => clickItem('add', item)}
            />
          </div>

          {/* Right: my offer / actions / their offer, stacked */}
          <div className="trade__right">
            <div className="trade__pane trade__pane--offer">
              <div className="trade__pane-title">
                Your Offer {data.myLocked ? <span className="trade__lock">[locked]</span> : null}
              </div>
              <ItemList
                items={data.myOffer}
                emptyText="(empty)"
                onItemClick={data.myLocked ? undefined : (item) => clickItem('remove', item)}
              />
            </div>

            <div className="trade__actions">
              <Button text="Cancel" width={104} height={36} onClick={() => send(ev.cancel)} />
              <Button
                text={data.myLocked ? 'Unlock' : 'Lock'}
                width={104}
                height={36}
                onClick={() => send(data.myLocked ? ev.unlock : ev.lock)}
              />
              <Button
                text={data.iAccepted ? 'Waiting…' : 'Accept'}
                width={104}
                height={36}
                disabled={!acceptAvailable}
                onClick={() => send(ev.accept)}
              />
            </div>

            <div className="trade__pane trade__pane--their-offer">
              <div className="trade__pane-title">
                {data.partnerName}&apos;s Offer{' '}
                {data.theirLocked ? <span className="trade__lock">[locked]</span> : null}
                {data.theyAccepted ? <span className="trade__lock">[accepted]</span> : null}
              </div>
              <ItemList items={data.theirOffer} emptyText="(empty)" />
            </div>
          </div>
        </div>

        {prompt ? (
          <div className="trade__prompt-overlay">
            <div className="trade__prompt">
              <div className="trade__prompt-title">
                {prompt.dir === 'add' ? 'Add how many' : 'Remove how many'} {prompt.item.name}?
              </div>
              <div className="trade__prompt-row">
                <Button text="-" width={44} height={36} onClick={() => clampPromptCount(promptCount - 1)} />
                <input
                  className="trade__prompt-input"
                  type="number"
                  min={1}
                  max={prompt.item.count}
                  value={promptCount}
                  onChange={(e) => clampPromptCount(parseInt(e.target.value, 10))}
                />
                <Button text="+" width={44} height={36} onClick={() => clampPromptCount(promptCount + 1)} />
                <Button text="All" width={64} height={36} onClick={() => setPromptCount(prompt.item.count)} />
              </div>
              <div className="trade__prompt-row">
                <Button text="Confirm" width={128} height={36} onClick={confirmPrompt} />
                <Button text="Back" width={128} height={36} onClick={() => setPrompt(null)} />
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default Trade;
