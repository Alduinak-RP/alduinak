import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';

interface WritingToolsProps {
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
}

// Same id shape and title bound the server checks (writingStore.ts, writingSystem.ts)
const WRITING_ID = /^W[0-9A-Z]{5}$/;
const MAX_TITLE = 40;

// Kept across sub-tab switches and reopening the menu
let lastId = '';

// Staff tools for player writings, found by the id in the item name; the server logs every use to admin.log
const WritingTools = ({ ev, send }: WritingToolsProps) => {
  const [id, setId] = useState(lastId);
  const [title, setTitle] = useState('');
  const [armed, setArmed] = useState(false);

  const target = id.trim().toUpperCase();
  const valid = WRITING_ID.test(target);

  useEffect(() => {
    lastId = id;
    setArmed(false);
  }, [id]);

  const destroy = (): void => {
    if (!armed) {
      setArmed(true);
      return;
    }
    send(ev.writingDestroy, target);
    setArmed(false);
  };

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__form">
        <label className="admin-panel__field admin-panel__field--half">
          Writing id, the tag in the item name
          <input className="admin-panel__input" placeholder="W1A7QZ" maxLength={6} value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="admin-panel__field admin-panel__field--half">
          New title
          <input className="admin-panel__input" maxLength={MAX_TITLE} value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
      </div>
      <div className="admin-panel__actions">
        <Button text="Read" width={104} height={32} disabled={!valid || !ev.writingRead} onClick={() => send(ev.writingRead, target)} />
        <Button text="Rename" width={104} height={32} disabled={!valid || !title.trim()} onClick={() => send(ev.writingRename, target, title.trim())} />
        <Button text={armed ? 'Really destroy' : 'Destroy'} width={150} height={32} disabled={!valid} onClick={destroy} />
      </div>
      <span className="admin-panel__hint">
        Reading never breaks a seal. Rename and Destroy reach the packs of players online at once; copies in chests or offline packs change when they are next read.
      </span>
    </div>
  );
};

export default WritingTools;
