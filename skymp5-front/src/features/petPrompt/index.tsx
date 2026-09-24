import React, { useEffect, useMemo, useState } from 'react';

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
  // A regex character class body the whole text must match, shown as allowedHint
  allowedChars?: string;
  allowedHint?: string;
  maxLength?: number;
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

  const pattern = useMemo(() => {
    try {
      return data.allowedChars ? new RegExp('^[' + data.allowedChars + ']+$') : null;
    } catch (e) {
      return null;
    }
  }, [data.allowedChars]);

  const trimmed = text.trim();
  const valid = !!trimmed && (!pattern || pattern.test(trimmed));
  const ok = () => {
    if (valid) send(ev.ok, trimmed);
  };

  return (
    <div className="pet-prompt">
      <div className="pet-prompt__fade" />
      <div className="pet-prompt__panel">
        <h2 className="pet-prompt__title">{data.caption}</h2>
        <input
          className="pet-prompt__input"
          autoFocus
          maxLength={data.maxLength || MAX_LENGTH}
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') ok(); }}
        />
        {data.allowedHint ? (
          <p className={'pet-prompt__hint' + (trimmed && !valid ? ' pet-prompt__hint--bad' : '')}>{data.allowedHint}</p>
        ) : null}
        <div className="pet-prompt__actions">
          <button className="pet-prompt__button pet-prompt__button--primary" disabled={!valid} onClick={ok}>
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
