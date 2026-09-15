import React, { useEffect, useState } from 'react';

import './styles.scss';

interface PetPromptEvents {
  ok: string;
  cancel: string;
  [key: string]: string;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface PetPromptData {
  caption: string;
  value: string;
  events: PetPromptEvents;
}

// Same bound the server's cleanDisplayName applies to a pet name
const MAX_LENGTH = 24;

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('petPrompt sendMessage', key, args);
  }
};

const PetPrompt = ({ data }: { data: PetPromptData }) => {
  const ev = data.events || ({} as PetPromptEvents);
  const [text, setText] = useState(data.value || '');

  // A re-push while open keeps this instance; follow the new prefill
  useEffect(() => {
    setText(data.value || '');
  }, [data.value]);

  useEffect(() => {
    const onUnfocused = () => send(ev.cancel);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [ev.cancel]);

  // index.js fires menu:escape globally; here Escape is the prompt's own Cancel
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      send(ev.cancel);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ev.cancel]);

  const trimmed = text.trim();
  const ok = () => {
    if (trimmed) send(ev.ok, trimmed);
  };

  return (
    <div className="pet-prompt">
      <div className="pet-prompt__fade" />
      <div className="pet-prompt__panel">
        <h2 className="pet-prompt__title">{data.caption}</h2>
        <input
          className="pet-prompt__input"
          autoFocus
          maxLength={MAX_LENGTH}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ok(); }}
        />
        <div className="pet-prompt__actions">
          <button className="pet-prompt__button pet-prompt__button--primary" disabled={!trimmed} onClick={ok}>
            OK
          </button>
          <button className="pet-prompt__button pet-prompt__button--quiet" onClick={() => send(ev.cancel)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};

export default PetPrompt;
