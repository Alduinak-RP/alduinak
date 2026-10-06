import React, { useLayoutEffect, useRef, useState } from 'react';

import './styles.scss';
import { loc } from '../../loc';

interface MenuAction {
  id: string;
  label: string;
  // Lethal and hostile actions, listed in their own red column
  danger?: boolean;
  disabled?: boolean;
}

interface ContextMenuEvents {
  action: string;
  close: string;
  trade: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface ContextMenuData {
  targetName: string;
  actions: MenuAction[];
  events: ContextMenuEvents;
  hideTrade?: boolean;
  tradeLabel?: string;
}

// Gap from the screen centre to the panel's top-left corner, in px.
const GAP = 12;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('contextMenu sendMessage', key, args);
  }
};

const ContextMenu = ({ data }: { data: ContextMenuData }) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const ev = data.events || ({} as ContextMenuEvents);
  const actions = data.actions || [];
  const dangers = actions.filter((a) => a.danger);
  const row = (a: MenuAction) => (
    <button
      key={a.id}
      className={'context-menu__row' + (a.danger ? ' context-menu__row--danger' : '')}
      disabled={a.disabled}
      onClick={() => send(ev.action, a.id)}
    >
      {a.label}
    </button>
  );

  // Panel hangs down-right of the crosshair, clamped inside the viewport before first paint.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const margin = 8;
    let left = window.innerWidth / 2 + GAP;
    let top = window.innerHeight / 2 + GAP;
    left = Math.max(margin, Math.min(left, window.innerWidth - el.offsetWidth - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - el.offsetHeight - margin));
    setPos({ left, top });
  }, [data.targetName, actions.length, dangers.length]);

  const style = pos
    ? { left: pos.left + 'px', top: pos.top + 'px' }
    : { left: 'calc(50% + ' + GAP + 'px)', top: 'calc(50% + ' + GAP + 'px)' };

  return (
    <div className="context-menu">
      <div className="context-menu__panel" ref={panelRef} style={style}>
        <div className="context-menu__title">{data.targetName}</div>
        <div className="context-menu__columns">
          <div className="context-menu__column">
            {!data.hideTrade ? (
              <button className="context-menu__row" onClick={() => send(ev.trade)}>{data.tradeLabel || loc('contextMenu.trade')}</button>
            ) : null}
            {actions.filter((a) => !a.danger).map(row)}
          </div>
          {dangers.length ? <div className="context-menu__column context-menu__column--danger">{dangers.map(row)}</div> : null}
        </div>
        <button className="context-menu__row context-menu__row--close" onClick={() => send(ev.close)}>
          {loc('common.close')}
        </button>
      </div>
    </div>
  );
};

export default ContextMenu;
