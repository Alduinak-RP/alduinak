import React, { useEffect, useState } from 'react';

import { PaperComposer, PaperReader, sendToClient as send, useCloseOnUnfocus, useEscapeLayer } from '../parchment';
import { assetUrl } from '../../utils/assetUrl';
import './styles.scss';

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

const DEFAULT_LIMITS: Limits = { title: 40, letter: 2000, page: 1500, journalPages: 50, bookPages: 100 };

const CONFIRM_TEXT: Record<Exclude<Confirm, ''>, string> = {
  burn: 'Burn this writing? It is gone for good.',
  break: 'Break the seal? Everyone who reads it later will see it was opened.',
  finish: 'Finish the book? Its pages can never be changed again, but it can be copied.',
};

// Factions with artwork in ../../img/seals, by the faction id the server records (writingSystem.ts SEAL_FACTIONS)
const SEALS: Record<string, { file: string; label: string }> = {
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
};

// The pressed seal on a sealed face, or the small mark beside a signature; null without artwork
const sealMark = (id: string, small?: boolean): React.ReactNode => {
  const seal = SEALS[id];
  if (!seal) return null;
  return (
    <>
      <img
        className={'writing__seal' + (small ? ' writing__seal--small' : '')}
        src={assetUrl(require('../../img/seals/' + seal.file + '.png'))}
        alt={seal.label}
        title={seal.label}
      />
      {small ? null : <p className="writing__seal-caption">{seal.label}</p>}
    </>
  );
};

const maxPagesOf = (kind: Kind, l: Limits): number => (kind === 'letter' ? 1 : kind === 'journal' ? l.journalPages : l.bookPages);

const pageLenOf = (kind: Kind, l: Limits): number => (kind === 'letter' ? l.letter : l.page);

const Writing = ({ data }: { data: WritingData }) => {
  const ev = data.events || {};
  const menu = data.menu || ({} as WritingMenu);
  const limits = menu.limits || DEFAULT_LIMITS;
  const doc = menu.doc || null;

  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [pages, setPages] = useState<string[]>(['']);
  const [signed, setSigned] = useState(true);
  const [confirm, setConfirm] = useState<Confirm>('');

  // A reply after a save or a new writing ends the edit; a refused one sends no reply and leaves the draft in place
  useEffect(() => {
    if (saving) {
      setSaving(false);
      setEditing(false);
      setTitle('');
      setPages(['']);
    }
    setConfirm('');
  }, [menu.seq]);

  const docId = doc ? doc.id : '';
  useEffect(() => {
    setPage(0);
    setEditing(false);
  }, [docId, menu.view]);

  useCloseOnUnfocus(ev.close);
  useEscapeLayer(editing || confirm !== '', () => {
    if (confirm) setConfirm('');
    else setEditing(false);
  });

  const composing = menu.view === 'compose' || (editing && !!doc);
  const kind: Kind = (menu.view === 'compose' ? menu.compose && menu.compose.kind : doc && doc.kind) || 'letter';
  const maxPages = maxPagesOf(kind, limits);
  const pageLen = pageLenOf(kind, limits);

  const startEdit = (): void => {
    if (!doc) return;
    setTitle(doc.title);
    setPages(doc.pages.length ? doc.pages.slice() : ['']);
    setPage(0);
    setEditing(true);
  };

  if (composing) {
    const at = Math.min(page, pages.length - 1);
    const setText = (text: string): void => setPages(pages.map((p, i) => (i === at ? text : p)));
    const written = pages.some((p) => p.trim());
    const submit = (): void => {
      if (!written) return;
      setSaving(true);
      if (editing && doc) send(ev.save, doc.id, title.trim(), JSON.stringify(pages));
      else send(ev.create, title.trim(), JSON.stringify(pages), signed);
    };
    const fields = (
      <div className="writing__fields">
        <input
          className="writing__title-input"
          value={title}
          maxLength={limits.title}
          placeholder={kind === 'letter' ? 'Title, for example Letter to Ysolda' : 'Title'}
          onChange={(e) => setTitle(e.target.value)}
        />
        {maxPages > 1 ? (
          <div className="writing__pager">
            <button className="parchment__button" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button>
            <span className="parchment__hint">{'Page ' + (at + 1) + ' of ' + pages.length}</span>
            <button className="parchment__button" disabled={at >= pages.length - 1} onClick={() => setPage(at + 1)}>Next</button>
            <button
              className="parchment__button"
              disabled={pages.length >= maxPages}
              onClick={() => {
                setPages(pages.concat(['']));
                setPage(pages.length);
              }}
            >
              Add page
            </button>
            <button
              className="parchment__button"
              disabled={pages.length <= 1}
              onClick={() => {
                setPages(pages.filter((_, i) => i !== at));
                setPage(Math.max(0, at - 1));
              }}
            >
              Remove page
            </button>
          </div>
        ) : null}
      </div>
    );
    const heading = editing ? 'Edit ' + (doc ? doc.title : '') : 'Write on ' + ((menu.compose && menu.compose.blankName) || KIND_LABEL[kind]);
    return (
      <div className="writing">
        <div className="writing__fade" />
        <div className="writing__frame">
          <PaperComposer
            heading={heading}
            value={pages[at] || ''}
            maxLength={pageLen}
            placeholder="Dip the quill and write."
            hint={(pages[at] || '').length + ' / ' + pageLen}
            onChange={setText}
            fields={fields}
            wide
          >
            {!editing ? (
              <label className="writing__sign">
                <input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} />
                Sign it
              </label>
            ) : null}
            <button className="parchment__button parchment__button--primary" disabled={!written} onClick={submit}>
              {editing ? 'Save' : 'Write it'}
            </button>
            <button className="parchment__button" onClick={() => (editing ? setEditing(false) : send(ev.close))}>Cancel</button>
          </PaperComposer>
        </div>
      </div>
    );
  }

  const confirmBar = (id: string) => (confirm ? (
    <div className="writing__confirm">
      <span className="writing__confirm-text">{CONFIRM_TEXT[confirm]}</span>
      <button
        className="parchment__button parchment__button--primary"
        onClick={() => {
          send(confirm === 'burn' ? ev.burn : confirm === 'break' ? ev.breakSeal : ev.finish, id);
          setConfirm('');
        }}
      >
        Yes
      </button>
      <button className="parchment__button" onClick={() => setConfirm('')}>No</button>
    </div>
  ) : null);

  if (menu.view === 'list') {
    const rows = menu.list || [];
    return (
      <div className="writing">
        <div className="writing__fade" />
        <div className="writing__frame">
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
          </div>
        </div>
      </div>
    );
  }

  if (!doc) return null;

  const closeButton = <button className="parchment__button" onClick={() => send(ev.close)}>Close</button>;

  if (menu.view === 'sealed') {
    return (
      <div className="writing">
        <div className="writing__fade" />
        <div className="writing__frame">
          <PaperReader heading="Sealed Letter" text={doc.sealText} meta={doc.brokenSeals} stamp={sealMark(doc.sealFaction)}>
            {confirmBar(doc.id) || (
              <>
                {doc.canBreak ? <button className="parchment__button parchment__button--primary" onClick={() => setConfirm('break')}>Break the seal</button> : null}
                {doc.canBurn ? <button className="parchment__button" onClick={() => setConfirm('burn')}>Burn</button> : null}
                {closeButton}
              </>
            )}
          </PaperReader>
        </div>
      </div>
    );
  }

  const count = doc.pages.length;
  const at = Math.min(page, Math.max(0, count - 1));
  const meta = (count > 1 ? ['Page ' + (at + 1) + ' of ' + count] : [])
    .concat(doc.copy ? ['A copy'] : [])
    .concat(doc.brokenSeals)
    .concat(doc.staff ? [doc.id].concat(doc.staffLines) : []);

  return (
    <div className="writing">
      <div className="writing__fade" />
      <div className="writing__frame">
        <PaperReader heading={doc.title} text={doc.pages[at] || ''} byline={doc.byline} mark={sealMark(doc.signFaction, true)} meta={meta} wide>
          {confirmBar(doc.id) || (
            <>
              {count > 1 ? <button className="parchment__button" disabled={at === 0} onClick={() => setPage(at - 1)}>Previous</button> : null}
              {count > 1 ? <button className="parchment__button" disabled={at >= count - 1} onClick={() => setPage(at + 1)}>Next</button> : null}
              {doc.canEdit ? <button className="parchment__button" onClick={startEdit}>Edit</button> : null}
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
          )}
        </PaperReader>
      </div>
    </div>
  );
};

export default Writing;
