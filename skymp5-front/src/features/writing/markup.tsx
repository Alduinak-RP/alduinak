import React from 'react';

import { assetUrl } from '../../utils/assetUrl';

// Tag markup for writings after Space Station 14's paper: stored as plain text, rendered only as React nodes, unknown or broken tags shown as written

export interface FontChoice {
  key: string;
  label: string;
  family: string;
  // Drawn in capitals, for fonts with upper case glyphs only
  upper?: boolean;
  // Letters become digits, the only glyphs the scribble font has
  scribble?: boolean;
  // What the font picker shows in this font
  sample?: string;
}

// Families from the @font-face rules in styles.scss; Georgia stands in for glyphs a font lacks
export const FONTS: FontChoice[] = [
  { key: 'hand', label: 'Handwritten', family: "'Writing Hand', Georgia, serif" },
  { key: 'book', label: 'Book', family: "'Writing Book', Georgia, serif" },
  { key: 'plain', label: 'Plain', family: "Georgia, 'Times New Roman', serif" },
  { key: 'daedric', label: 'Daedric', family: "'Writing Daedric', Georgia, serif" },
  { key: 'dragon', label: 'Dragon', family: "'Writing Dragon', Georgia, serif", upper: true },
  { key: 'dwemer', label: 'Dwemer', family: "'Writing Dwemer', Georgia, serif" },
  { key: 'falmer', label: 'Falmer', family: "'Writing Falmer', Georgia, serif", upper: true },
  { key: 'mage', label: 'Mage Script', family: "'Writing Mage', Georgia, serif", upper: true },
  { key: 'unreadable', label: 'Unreadable', family: "'Writing Unreadable', Georgia, serif", scribble: true, sample: '0123 4567' },
  { key: 'symbols', label: 'Symbols', family: "'Writing Symbols', Georgia, serif", sample: '! # $ % & @' },
];

// Inks that read on parchment; [color=#hex] takes any other
export const INKS: Array<{ key: string; hex: string }> = [
  { key: 'black', hex: '#1f1a14' },
  { key: 'brown', hex: '#5a3a1e' },
  { key: 'red', hex: '#8b1a1a' },
  { key: 'blue', hex: '#1e3a6e' },
  { key: 'green', hex: '#2f5a2a' },
  { key: 'purple', hex: '#4b2a5e' },
  { key: 'gold', hex: '#9a7420' },
  { key: 'grey', hex: '#55504a' },
];

// Same pattern as MARKUP_TAG in skymp5-server/ts/systems/writingSystem.ts, which counts a page's length without these tags
export const TAG = /\[(\/?)(b|bold|i|italic|u|s|color|head|bullet|font|fancy|center|right|hr)(?:=("?)([^\]"\n]{1,24})\3)?\/?\]/gi;

// Mirrors MARKUP_ROOM on the server: a page's raw text may be this many times its visible limit
export const MARKUP_ROOM = 2;

const MAX_DEPTH = 8;
const MAX_TAGS = 400;
const ALIAS: Record<string, string> = { bold: 'b', italic: 'i' };
const BLOCKS = new Set(['head', 'center', 'right']);
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z]/g, '');

export const fontOf = (name: string): FontChoice | undefined => FONTS.find((f) => f.key === norm(name) || norm(f.label) === norm(name));

const inkOf = (value: string): string => {
  const v = value.trim();
  if (HEX.test(v)) return v;
  const ink = INKS.find((c) => c.key === norm(v) || (norm(v) === 'gray' && c.key === 'grey'));
  return ink ? ink.hex : '';
};

interface Tagged {
  tag: string;
  arg: string;
  children: MdNode[];
}

type MdNode = string | Tagged;

// A valid argument for the tag, '' for a tag without one, null when the tag cannot open
const argOf = (tag: string, raw: string | undefined): string | null => {
  if (tag === 'color') return raw !== undefined && inkOf(raw) ? inkOf(raw) : null;
  if (tag === 'head') return raw !== undefined && /^[1-3]$/.test(raw) ? raw : null;
  if (tag === 'font') {
    const font = raw !== undefined ? fontOf(raw) : undefined;
    return font ? font.key : null;
  }
  return raw === undefined ? '' : null;
};

export const parseMarkup = (text: string): MdNode[] => {
  const root: Tagged = { tag: '', arg: '', children: [] };
  const stack: Tagged[] = [root];
  const top = (): Tagged => stack[stack.length - 1];
  const re = new RegExp(TAG.source, 'gi');
  let at = 0;
  let tags = 0;
  let fancySeen = false;
  const pushText = (s: string): void => {
    if (!s) return;
    const kids = top().children;
    if (typeof kids[kids.length - 1] === 'string') kids[kids.length - 1] += s;
    else kids.push(s);
  };
  // Blocks start and end their own lines, so one line break beside a block tag is dropped
  const skipBreak = (): void => {
    if (text[re.lastIndex] === '\n') re.lastIndex += 1;
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(text.slice(at, m.index));
    const close = m[1] === '/';
    const tag = ALIAS[m[2].toLowerCase()] || m[2].toLowerCase();
    const raw = m[4];
    let done = false;
    if (++tags <= MAX_TAGS) {
      if (close) {
        let i = stack.length - 1;
        while (i > 0 && stack[i].tag !== tag) i--;
        if (i > 0) {
          stack.length = i;
          done = true;
          if (BLOCKS.has(tag)) skipBreak();
        } else if (tag === 'fancy' && fancySeen) {
          done = true;
        }
      } else if ((tag === 'bullet' || tag === 'hr') && raw === undefined) {
        top().children.push({ tag, arg: '', children: [] });
        done = true;
        if (tag === 'hr') skipBreak();
      } else if (tag === 'fancy') {
        const letter = raw === undefined ? text.charAt(re.lastIndex) : '';
        if (/[a-z]/i.test(letter)) {
          top().children.push({ tag, arg: letter.toUpperCase(), children: [] });
          re.lastIndex += 1;
          fancySeen = true;
          done = true;
        }
      } else {
        const arg = argOf(tag, raw);
        if (arg !== null && stack.length <= MAX_DEPTH) {
          const el: Tagged = { tag, arg, children: [] };
          top().children.push(el);
          stack.push(el);
          done = true;
          if (BLOCKS.has(tag)) skipBreak();
        }
      }
    }
    if (!done) pushText(m[0]);
    at = re.lastIndex;
  }
  pushText(text.slice(at));
  return root.children;
};

// The text a reader sees, for previews and counts; the server counts the same way
export const plainText = (text: string): string => text.replace(new RegExp(TAG.source, 'gi'), '');

const fancyCache = new Map<string, string>();

// The illuminated capital's image, '' when the owner's set has none for that letter
const fancyUrl = (letter: string): string => {
  let url = fancyCache.get(letter);
  if (url === undefined) {
    try {
      url = assetUrl(require('../../img/writing/fancy/' + letter + '.png'));
    } catch {
      url = '';
    }
    fancyCache.set(letter, url);
  }
  return url;
};

const scrawl = (s: string): string => s.replace(/[a-z]/gi, (c) => String(c.charCodeAt(0) % 10));

const render = (nodes: MdNode[], scribble = false): React.ReactNode[] => nodes.map((n, i) => {
  if (typeof n === 'string') return scribble ? scrawl(n) : n;
  const font = n.tag === 'font' ? fontOf(n.arg) : undefined;
  const kids = render(n.children, font ? !!font.scribble : scribble);
  switch (n.tag) {
    case 'b': return <strong key={i}>{kids}</strong>;
    case 'i': return <em key={i}>{kids}</em>;
    case 'u': return <u key={i}>{kids}</u>;
    case 's': return <s key={i}>{kids}</s>;
    case 'color': return <span key={i} style={{ color: n.arg }}>{kids}</span>;
    case 'font': return <span key={i} style={font ? { fontFamily: font.family, textTransform: font.upper ? 'uppercase' : undefined } : undefined}>{kids}</span>;
    case 'head': return <span key={i} className={'writing-md__head writing-md__head--' + n.arg}>{kids}</span>;
    case 'center': return <span key={i} className="writing-md__block writing-md__block--center">{kids}</span>;
    case 'right': return <span key={i} className="writing-md__block writing-md__block--right">{kids}</span>;
    case 'bullet': return <span key={i} className="writing-md__bullet">{'• '}</span>;
    case 'hr': return <span key={i} className="writing-md__hr" />;
    case 'fancy': {
      const url = fancyUrl(n.arg);
      return url
        ? <img key={i} className="writing-md__fancy" src={url} alt={n.arg} />
        : <span key={i} className="writing-md__fancy writing-md__fancy--text">{n.arg}</span>;
    }
    default: return <span key={i}>{kids}</span>;
  }
});

export const Markup = ({ text }: { text: string }) => <>{render(parseMarkup(text))}</>;
