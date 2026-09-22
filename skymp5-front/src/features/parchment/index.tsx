import React, { useEffect } from 'react';

import './styles.scss';

// Paper widgets shared by the missive board and the writings: the client bridge, focus and Escape handling, the reader and the composer

export const sendToClient = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('sendMessage', key, args);
  }
};

// The menu closes itself when the browser loses focus
export const useCloseOnUnfocus = (closeKey: string): void => {
  useEffect(() => {
    const onUnfocused = () => sendToClient(closeKey);
    window.addEventListener('skymp5-client:browserUnfocused', onUnfocused);
    return () => window.removeEventListener('skymp5-client:browserUnfocused', onUnfocused);
  }, [closeKey]);
};

// index.js fires menu:escape globally; while a layer is open, Escape backs out of that layer instead of closing the menu
export const useEscapeLayer = (open: boolean, back: () => void): void => {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      back();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, back]);
};

interface PaperReaderProps {
  heading?: string;
  text: string;
  byline?: string;
  meta?: string[];
  wide?: boolean;
  // A click beside the paper
  onBack?: () => void;
  // A seal pressed under the heading
  stamp?: React.ReactNode;
  // A mark in front of the byline
  mark?: React.ReactNode;
  children?: React.ReactNode;
}

export const PaperReader = ({ heading, text, byline, meta, wide, onBack, stamp, mark, children }: PaperReaderProps) => (
  <div className="parchment__shade" onClick={onBack}>
    <div className={'parchment__read' + (wide ? ' parchment__read--wide' : '')} onClick={(e) => e.stopPropagation()}>
      {heading ? <h3 className="parchment__read-heading">{heading}</h3> : null}
      {stamp}
      <p className="parchment__read-text">{text}</p>
      {byline || mark ? <p className="parchment__read-author">{mark}{byline}</p> : null}
      {(meta || []).map((line, i) => (
        <p key={i} className="parchment__read-meta">{line}</p>
      ))}
      <div className="parchment__actions parchment__actions--end">{children}</div>
    </div>
  </div>
);

interface PaperComposerProps {
  heading: string;
  value: string;
  maxLength: number;
  placeholder?: string;
  hint: string;
  onChange: (value: string) => void;
  // Fields above the page, such as a title or the page tabs
  fields?: React.ReactNode;
  wide?: boolean;
  children?: React.ReactNode;
}

export const PaperComposer = ({ heading, value, maxLength, placeholder, hint, onChange, fields, wide, children }: PaperComposerProps) => (
  <div className="parchment__shade">
    <div className={'parchment__compose' + (wide ? ' parchment__compose--wide' : '')}>
      <h3 className="parchment__compose-title">{heading}</h3>
      {fields}
      <textarea
        className="parchment__compose-text"
        value={value}
        maxLength={maxLength}
        autoFocus
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="parchment__compose-foot">
        <span className="parchment__hint">{hint}</span>
        <div className="parchment__actions">{children}</div>
      </div>
    </div>
  </div>
);
