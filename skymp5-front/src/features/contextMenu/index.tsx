import React, { useLayoutEffect, useRef, useState } from 'react';

import './styles.scss';

interface MenuAction {
  id: string;
  label: string;
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
  }, [data.targetName, actions.length]);

  const style = pos
    ? { left: pos.left + 'px', top: pos.top + 'px' }
    : { left: 'calc(50% + ' + GAP + 'px)', top: 'calc(50% + ' + GAP + 'px)' };

  return (
    <div className="context-menu">
      <div className="context-menu__panel" ref={panelRef} style={style}>
        <div className="context-menu__title">{data.targetName}</div>
        <button className="context-menu__row" onClick={() => send(ev.trade)}>Trade</button>
        {actions.map((a) => (
          <button key={a.id} className="context-menu__row" onClick={() => send(ev.action, a.id)}>
            {a.label}
          </button>
        ))}
        <button className="context-menu__row context-menu__row--close" onClick={() => send(ev.close)}>
          Close
        </button>
      </div>
    </div>
  );
};

export default ContextMenu;
