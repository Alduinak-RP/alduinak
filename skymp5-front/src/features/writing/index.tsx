import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { ConfirmBar, PaperReader, sendToClient as send, useCloseOnUnfocus, useEscapeLayer } from '../parchment';
import { assetUrl } from '../../utils/assetUrl';
import { FONTS, INKS, MARKUP_ROOM, Markup, TAG, plainText } from './markup';
import './styles.scss';

export { Markup, plainText } from './markup';

type Kind = 'letter' | 'journal' | 'book';

interface Limits {
  title: number;
  letter: number;
  page: number;
  journalPages: number;
  bookPages: number;
}

// One document as this reader may see it (writingSystem.ts sendDoc)
interface DocView {
  id: string;
  kind: Kind;
  title: string;
  pages: string[];
  byline: string;
  copy: boolean;
  finished: boolean;
  sealText: string;
  // Faction ids whose marks the seal and the signature carry, empty for none
  sealFaction: string;
  signFaction: string;
  brokenSeals: string[];
  canEdit: boolean;
  canFinish: boolean;
  canSeal: boolean;
  canBreak: boolean;
  canCopy: boolean;
  canBurn: boolean;
  hasWax: boolean;
  blankBooks: number;
  staff: boolean;
  staffLines: string[];
}

interface ListRow {
  id: string;
  kind: Kind;
  title: string;
  sealed: boolean;
}

// The server's writingMenu reply; seq counts the replies
export interface WritingMenu {
  view: 'compose' | 'read' | 'sealed' | 'list';
  seq: number;
  limits: Limits;
  compose?: { kind: Kind; blankName: string };
  doc?: DocView;
  list?: ListRow[];
}

export interface WritingData {
  menu: WritingMenu;
  events: Record<string, string>;
}

type Confirm = '' | 'burn' | 'break' | 'finish';

const KIND_LABEL: Record<Kind, string> = { letter: 'Letter', journal: 'Journal', book: 'Book' };

// Vanilla notes and journals are handwritten, books printed
const KIND_FONT: Record<Kind, string> = { letter: 'hand', journal: 'hand', book: 'book' };

const DEFAULT_LIMITS: Limits = { title: 40, letter: 2000, page: 1500, journalPages: 50, bookPages: 100 };

const CONFIRM_TEXT: Record<Exclude<Confirm, ''>, string> = {
  burn: 'Burn this writing? It is gone for good.',
  break: 'Break the seal? Everyone who reads it later will see it was opened.',
  finish: 'Finish the book? Its pages can never be changed again, but it can be copied.',
};

// Factions with artwork in ../../img/seals, by the faction id the server records (writingSystem.ts SEAL_FACTIONS); sign is the art under a signature when it differs
const SEALS: Record<string, { file: string; label: string; sign?: string }> = {
  'hold:haafingar': { file: 'haafingar', label: 'Court of Haafingar' },
  'hold:the-reach': { file: 'the-reach', label: 'Court of the Reach' },
  'hold:falkreath': { file: 'falkreath', label: 'Court of Falkreath' },
  'hold:hjaalmarch': { file: 'hjaalmarch', label: 'Court of Hjaalmarch' },
  'hold:eastmarch': { file: 'eastmarch', label: 'Court of Eastmarch' },
  'hold:winterhold': { file: 'winterhold', label: 'Court of Winterhold' },
  'hold:the-rift': { file: 'the-rift', label: 'Court of the Rift' },
  'hold:the-pale': { file: 'the-pale', label: 'Court of the Pale' },
  'hold:whiterun': { file: 'whiterun', label: 'Court of Whiterun' },
  'faction:imperial-legion': { file: 'imperial-legion', label: 'Imperial Legion' },
  'faction:college-of-winterhold': { file: 'college-of-winterhold', label: 'College of Winterhold' },
  'faction:dark-brotherhood': { file: 'dark-brotherhood', label: 'Dark Brotherhood' },
  'faction:house-telvanni': { file: 'house-telvanni', label: 'House Telvanni', sign: 'house-telvanni-banner' },
  'faction:house-redoran': { file: 'house-redoran', label: 'House Redoran' },
  'faction:house-dres': { file: 'house-dres', label: 'House Dres' },
  'faction:house-indoril': { file: 'house-indoril', label: 'House Indoril' },
  'faction:house-sadras': { file: 'house-sadras', label: 'House Sadras' },
  'faction:morag-tong': { file: 'morag-tong', label: 'Morag Tong' },
};

const sealArt = (id: string, sign?: boolean): { url: string; label: string } | null => {
  const seal = SEALS[id];
  if (!seal) return null;
  return { url: assetUrl(require('../../img/seals/' + ((sign && seal.sign) || seal.file) + '.png')), label: seal.label };
};

// The pressed seal on a sealed face, or the mark under a signature; null without artwork
export const sealMark = (id: string, sign?: boolean): React.ReactNode => {
  const seal = sealArt(id, sign);
  if (!seal) return null;
  return (
    <>
      <img className={'writing__seal' + (sign ? ' writing__seal--sign' : '')} src={seal.url} alt={seal.label} title={seal.label} />
      {sign ? null : <p className="writing__seal-caption">{seal.label}</p>}
    </>
  );
};

const maxPagesOf = (kind: Kind, l: Limits): number => (kind === 'letter' ? 1 : kind === 'journal' ? l.journalPages : l.bookPages);

const pageLenOf = (kind: Kind, l: Limits): number => (kind === 'letter' ? l.letter : l.page);

const familyOf = (kind: Kind): string => (FONTS.find((f) => f.key === KIND_FONT[kind]) || FONTS[0]).family;

// Toolbar buttons keep the page's selection by never taking focus
const keepFocus = (e: React.MouseEvent): void => e.preventDefault();

interface Edit {
  text: string;
  start: number;
  end: number;
}

interface ComposerProps {
  kind: Kind;
  limits: Limits;
  heading: string;
  startTitle: string;
  startPages: string[];
  editing: boolean;
  onSubmit: (title: string, pages: string[], signed: boolean) => void;
  onCancel: () => void;
}

// Raw markup in the fields, a toolbar that wraps the selection in tags, and a preview; journals and books show two pages at a time
const Composer = ({ kind, limits, heading, startTitle, startPages, editing, onSubmit, onCancel }: ComposerProps) => {
  const spread = kind !== 'letter';
  const maxPages = maxPagesOf(kind, limits);
  const pageLen = pageLenOf(kind, limits);
  const rawCap = pageLen * MARKUP_ROOM;
  const [title, setTitle] = useState(startTitle);
  const [pages, setPages] = useState<string[]>(startPages.length ? startPages : ['']);
  const [signed, setSigned] = useState(true);
  const [first, setFirst] = useState(0);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState(false);
  const [popup, setPopup] = useState<'' | 'font' | 'ink'>('');
  const [warn, setWarn] = useState('');
  const fields = useRef<Array<HTMLTextAreaElement | null>>([null, null]);
  const caret = useRef<{ side: number; start: number; end: number } | null>(null);

  useLayoutEffect(() => {
    const c = caret.current;
    caret.current = null;
    const el = c ? fields.current[c.side] : null;
    if (!c || !el) return;
    el.focus();
    el.setSelectionRange(c.start, c.end);
  });

  useEscapeLayer(popup !== '' || editing, () => (popup ? setPopup('') : onCancel()));

  const textAt = (i: number): string => pages[i] || '';
  const setText = (i: number, text: string): void => setPages((prev) => {
    const next = prev.slice();
    while (next.length <= i) next.push('');
    next[i] = text;
    return next;
  });

  // Applies a change to the selection of the page last written on
  const edit = (change: (t: string, s: number, e: number) => Edit | null): void => {
    setPopup('');
    const side = active;
    const i = first + side;
    if (i >= maxPages) return;
    const el = fields.current[side];
    const t = textAt(i);
    const out = change(t, el ? el.selectionStart : t.length, el ? el.selectionEnd : t.length);
    if (!out) return;
    if (out.text.length > rawCap) {
      setWarn('No room for more formatting on this page.');
      return;
    }
    setWarn('');
    setText(i, out.text);
    caret.current = { side, start: out.start, end: out.end };
  };
  const wrap = (open: string, close: string) => () => edit((t, s, e) => ({
    text: t.slice(0, s) + open + t.slice(s, e) + close + t.slice(e), start: s + open.length, end: e + open.length,
  }));
  const insert = (tag: string) => () => edit((t, s) => ({ text: t.slice(0, s) + tag + t.slice(s), start: s + tag.length, end: s + tag.length }));
  const bullets = (): void => edit((t, s, e) => {
    const from = t.lastIndexOf('\n', s - 1) + 1;
    const lines = t.slice(from, e).split('\n').map((l) => '[bullet] ' + l).join('\n');
    return { text: t.slice(0, from) + lines + t.slice(e), start: from, end: from + lines.length };
  });
  const capital = (): void => edit((t, s) => {
    const m = /[a-z]/i.exec(t.slice(s));
    if (!m) return null;
    const at = s + m.index;
    return { text: t.slice(0, at) + '[fancy]' + t.slice(at), start: at + 8, end: at + 8 };
  });
  const unformat = (): void => edit((t, s, e) => {
    const plain = t.slice(s, e).replace(new RegExp(TAG.source, 'gi'), '');
    return { text: t.slice(0, s) + plain + t.slice(e), start: s, end: s + plain.length };
  });

  const tools: Array<[string, string, () => void]> = [
    ['B', 'Bold', wrap('[b]', '[/b]')],
    ['I', 'Italic', wrap('[i]', '[/i]')],
    ['U', 'Underline', wrap('[u]', '[/u]')],
    ['S', 'Strike through', wrap('[s]', '[/s]')],
    ['H1', 'Large heading', wrap('[head=1]', '[/head]')],
    ['H2', 'Heading', wrap('[head=2]', '[/head]')],
    ['H3', 'Small heading', wrap('[head=3]', '[/head]')],
    ['Centre', 'Centre the selected lines', wrap('[center]', '[/center]')],
    ['Right', 'Align the selected lines right', wrap('[right]', '[/right]')],
    ['•', 'Bullet the selected lines', bullets],
    ['Line', 'A dividing line', insert('[hr]')],
    ['Capital', 'An illuminated capital for the next letter', capital],
    ['Plain', 'Remove the formatting from the selection', unformat],
  ];

  const over = (i: number): boolean => plainText(textAt(i)).length > pageLen;
  const written = pages.some((p) => plainText(p).trim());
  const fits = pages.every((p, i) => !over(i) && p.length <= rawCap);
  const submit = (): void => {
    if (!written || !fits) return;
    const out = pages.slice();
    while (out.length > 1 && !out[out.length - 1].trim()) out.pop();
    onSubmit(title.trim(), out, signed);
  };
  const turn = (to: number): void => {
    setFirst(to);
    setActive(0);
  };
  const removeSpread = (): void => {
    const next = pages.filter((_, i) => i < first || i > first + 1);
    setPages(next.length ? next : ['']);
    if (first > 0 && first >= next.length) turn(first - 2);
  };

  const sides = spread ? [0, 1] : [0];
  return (
    <div className="parchment__shade">
      <div className={'writing__desk writing__desk--' + (spread ? 'spread' : 'note')}>
        <div className="writing__head">
          <div className="writing__head-row">
            <h3 className="parchment__compose-title">{heading}</h3>
            <input
              className="writing__title-input"
              value={title}
              maxLength={limits.title}
              placeholder={kind === 'letter' ? 'Title, for example Letter to Ysolda' : 'Title'}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="writing__tools">
            {tools.map(([label, hint, run]) => (
              <button key={label} className="writing__tool" title={hint} disabled={preview} onMouseDown={keepFocus} onClick={run}>{label}</button>
            ))}
            <button className={'writing__tool' + (popup === 'ink' ? ' writing__tool--on' : '')} title="Ink colour" disabled={preview} onMouseDown={keepFocus} onClick={() => setPopup(popup === 'ink' ? '' : 'ink')}>Ink</button>
            <button className={'writing__tool' + (popup === 'font' ? ' writing__tool--on' : '')} title="Font of the selection" disabled={preview} onMouseDown={keepFocus} onClick={() => setPopup(popup === 'font' ? '' : 'font')}>Font</button>
            <button className={'writing__tool writing__tool--wide' + (preview ? ' writing__tool--on' : '')} title="See the page as readers will" onMouseDown={keepFocus} onClick={() => { setPopup(''); setPreview(!preview); }}>
              {preview ? 'Back to writing' : 'Preview'}
            </button>
            {popup === 'font' ? (
              <div className="writing__popup">
                {FONTS.map((f) => (
                  <button key={f.key} className="writing__popup-row" onMouseDown={keepFocus} onClick={wrap('[font=' + f.key + ']', '[/font]')}>
                    <span>{f.label}</span>
                    <span className="writing__popup-sample" style={{ fontFamily: f.family, textTransform: f.upper ? 'uppercase' : undefined }}>{f.sample || 'Aa Bb Cc'}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {popup === 'ink' ? (
              <div className="writing__popup writing__popup--inks">
                {INKS.map((c) => (
                  <button key={c.key} className="writing__swatch" title={c.key} style={{ background: c.hex }} onMouseDown={keepFocus} onClick={wrap('[color=' + c.key + ']', '[/color]')} />
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className={'writing__paper writing__paper--' + (spread ? 'spread' : 'note')} style={{ fontFamily: familyOf(kind) }}>
          <div className={'parchment__art parchment__art--' + (spread ? 'journal' : 'note')} />
          {sides.map((side) => {
            const i = first + side;
            if (i >= maxPages) return null;
            const shown = plainText(textAt(i)).length;
            return (
              <div key={side} className={'writing__page writing__page--' + (spread ? (side ? 'right' : 'left') : 'note')}>
                {preview ? (
                  <div className="writing__view"><Markup text={textAt(i)} /></div>
                ) : (
                  <textarea
                    ref={(el) => { fields.current[side] = el; }}
                    className="writing__field"
                    value={textAt(i)}
                    maxLength={rawCap}
                    autoFocus={side === 0}
                    spellCheck={false}
                    placeholder={i === 0 ? 'Dip the quill and write.' : ''}
                    onFocus={() => setActive(side)}
                    onChange={(e) => setText(i, e.target.value)}
                  />
                )}
                <span className={'writing__count' + (over(i) ? ' writing__count--over' : '')}>
                  {(spread ? 'Page ' + (i + 1) + '   ' : '') + shown + ' / ' + pageLen}
                </span>
              </div>
            );
          })}
        </div>
        <div className="writing__foot">
          {spread ? (
            <div className="writing__pager">
              <button className="parchment__button" disabled={first === 0} onClick={() => turn(first - 2)}>Previous</button>
              <span className="parchment__hint">{'Pages ' + (first + 1) + '-' + Math.min(first + 2, maxPages) + ' of ' + maxPages}</span>
              <button className="parchment__button" disabled={first + 2 >= maxPages} onClick={() => turn(first + 2)}>Next</button>
              <button className="parchment__button" disabled={pages.length <= first} onClick={removeSpread}>Remove these pages</button>
            </div>
          ) : <span className="parchment__hint">Select words, then a button above. Preview shows the result.</span>}
          {warn ? <span className="writing__warn">{warn}</span> : null}
          <div className="parchment__actions">
            {!editing ? (
              <label className="writing__sign">
                <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} />
                Sign it
              </label>
            ) : null}
            <button className="parchment__button parchment__button--primary" disabled={!written || !fits} onClick={submit}>
              {editing ? 'Save' : 'Write it'}
            </button>
            <button className="parchment__button" onClick={onCancel}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface SpreadProps {
  doc: DocView;
  first: number;
  meta: string[];
  children: React.ReactNode;
}

// A journal or book open at two pages; the title opens the first page and the signature closes the last
const Spread = ({ doc, first, meta, children }: SpreadProps) => {
  const count = doc.pages.length;
  const mark = sealMark(doc.signFaction, true);
  return (
    <div className="parchment__shade">
      <div className="writing__desk writing__desk--spread writing__desk--read">
        <div className="writing__paper writing__paper--spread" style={{ fontFamily: familyOf(doc.kind) }}>
          <div className="parchment__art parchment__art--journal" />
          {[0, 1].map((side) => {
            const i = first + side;
            return (
              <div key={side} className={'writing__page writing__page--' + (side ? 'right' : 'left')}>
                <div className="writing__view">
                  {i === 0 ? <h3 className="writing__book-title">{doc.title}</h3> : null}
                  {i < count ? <Markup text={doc.pages[i]} /> : null}
                  {i === count - 1 && (doc.byline || mark) ? <p className="writing__byline">{doc.byline}{mark}</p> : null}
                </div>
                {i < count ? <span className="writing__count">{i + 1}</span> : null}
              </div>
            );
          })}
        </div>
        <div className="writing__foot">
          <div className="writing__meta">
            {meta.map((line, i) => <p key={i}>{line}</p>)}
          </div>
          <div className="parchment__actions parchment__actions--end">{children}</div>
        </div>
      </div>
    </div>
  );
};

const Writing = ({ data }: { data: WritingData }) => {
  const ev = data.events || {};
  const menu = data.menu || ({} as WritingMenu);
  const limits = menu.limits || DEFAULT_LIMITS;
  const doc = menu.doc || null;

  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>('');

  // A reply after a save or a new writing ends the edit; a refused one sends no reply and leaves the draft in place
  useEffect(() => {
    if (saving) {
      setSaving(false);
      setEditing(false);
    }
    setConfirm('');
  }, [menu.seq]);

  const docId = doc ? doc.id : '';
  useEffect(() => {
    setPage(0);
    setEditing(false);
  }, [docId, menu.view]);

  useCloseOnUnfocus(ev.close);
  useEscapeLayer(confirm !== '', () => setConfirm(''));

  const frame = (body: React.ReactNode) => (
    <div className="writing">
      <div className="writing__fade" />
      <div className="writing__frame">{body}</div>
    </div>
  );

  if (menu.view === 'compose' || (editing && doc)) {
    const kind: Kind = (menu.view === 'compose' ? menu.compose && menu.compose.kind : doc && doc.kind) || 'letter';
    const heading = editing && doc ? 'Edit ' + doc.title : 'Write on ' + ((menu.compose && menu.compose.blankName) || KIND_LABEL[kind]);
    return frame(
      <Composer
        key={editing && doc ? doc.id : 'new-' + kind}
        kind={kind}
        limits={limits}
        heading={heading}
        startTitle={editing && doc ? doc.title : ''}
        startPages={editing && doc ? doc.pages.slice() : ['']}
        editing={editing}
        onSubmit={(title, pages, signed) => {
          setSaving(true);
          if (editing && doc) send(ev.save, doc.id, title, JSON.stringify(pages));
          else send(ev.create, title, JSON.stringify(pages), signed);
        }}
        onCancel={() => (editing ? setEditing(false) : send(ev.close))}
      />,
    );
  }

  const confirmBar = (id: string) => (confirm ? (
    <ConfirmBar
      text={CONFIRM_TEXT[confirm]}
      onYes={() => {
        send(confirm === 'burn' ? ev.burn : confirm === 'break' ? ev.breakSeal : ev.finish, id);
        setConfirm('');
      }}
      onNo={() => setConfirm('')}
    />
  ) : null);

  if (menu.view === 'list') {
    const rows = menu.list || [];
    return frame(
      <div className="parchment__shade">
        <div className="parchment__compose">
          <h3 className="parchment__compose-title">Which one?</h3>
          <div className="writing__list">
            {rows.map((r) => (
              <button key={r.id} className="writing__row" onClick={() => send(ev.open, r.id)}>
                <span>{r.title}</span>
                <span className="parchment__hint">{r.sealed ? 'Sealed' : KIND_LABEL[r.kind]}</span>
              </button>
            ))}
          </div>
          <div className="parchment__actions parchment__actions--end">
            <button className="parchment__button" onClick={() => send(ev.close)}>Close</button>
          </div>
        </div>
      </div>,
    );
  }

  if (!doc) return null;

  const closeButton = <button className="parchment__button" onClick={() => send(ev.close)}>Close</button>;

  if (menu.view === 'sealed') {
    const seal = sealArt(doc.sealFaction);
    return frame(
      <div className="parchment__shade">
        <div className="writing__desk writing__desk--sealed">
          <div className="writing__sealed">
            <div className="parchment__art parchment__art--sealed" />
            {seal ? <img className="writing__sealed-mark" src={seal.url} alt={seal.label} title={seal.label} /> : null}
          </div>
          <div className="writing__foot writing__foot--column">
            {seal ? <p className="writing__sealed-caption">{seal.label}</p> : null}
            <p className="writing__sealed-text">{doc.sealText}</p>
            <div className="writing__meta">
              {doc.brokenSeals.map((line, i) => <p key={i}>{line}</p>)}
            </div>
            <div className="parchment__actions parchment__actions--end">
              {confirmBar(doc.id) || (
                <>
                  {doc.canBreak ? <button className="parchment__button parchment__button--primary" onClick={() => setConfirm('break')}>Break the seal</button> : null}
                  {doc.canBurn ? <button className="parchment__button" onClick={() => setConfirm('burn')}>Burn</button> : null}
                  {closeButton}
                </>
              )}
            </div>
          </div>
        </div>
      </div>,
    );
  }

  const count = doc.pages.length;
  const spread = doc.kind !== 'letter';
  const step = spread ? 2 : 1;
  const at = Math.min(page, Math.max(0, count - 1));
  const meta = (count > step ? [spread ? 'Pages ' + (at + 1) + '-' + Math.min(at + 2, count) + ' of ' + count : 'Page ' + (at + 1) + ' of ' + count] : [])
    .concat(doc.copy ? ['A copy'] : [])
    .concat(doc.brokenSeals)
    .concat(doc.staff ? [doc.id].concat(doc.staffLines) : []);

  const actions = confirmBar(doc.id) || (
    <>
      {count > step ? <button className="parchment__button" disabled={at === 0} onClick={() => setPage(Math.max(0, at - step))}>Previous</button> : null}
      {count > step ? <button className="parchment__button" disabled={at + step >= count} onClick={() => setPage(at + step)}>Next</button> : null}
      {doc.canEdit ? <button className="parchment__button" onClick={() => setEditing(true)}>Edit</button> : null}
      {doc.canFinish ? <button className="parchment__button" onClick={() => setConfirm('finish')}>Finish</button> : null}
      {doc.canSeal ? (
        <button className="parchment__button" disabled={!doc.hasWax} title={doc.hasWax ? '' : 'Needs Sealing Wax'} onClick={() => send(ev.seal, doc.id)}>
          {doc.hasWax ? 'Seal' : 'Seal (needs wax)'}
        </button>
      ) : null}
      {doc.canCopy ? (
        <button className="parchment__button" disabled={doc.blankBooks < 1} onClick={() => send(ev.copy, doc.id)}>
          {doc.blankBooks < 1 ? 'Copy (needs a Blank Book)' : 'Copy'}
        </button>
      ) : null}
      {doc.canBurn ? <button className="parchment__button" onClick={() => setConfirm('burn')}>Burn</button> : null}
      {closeButton}
    </>
  );

  if (spread) return frame(<Spread doc={doc} first={at - (at % 2)} meta={meta}>{actions}</Spread>);

  return frame(
    <PaperReader
      heading={doc.title}
      text={doc.pages[at] || ''}
      body={<Markup text={doc.pages[at] || ''} />}
      byline={doc.byline}
      mark={sealMark(doc.signFaction, true)}
      meta={meta}
      note
    >
      {actions}
    </PaperReader>,
  );
};

export default Writing;
