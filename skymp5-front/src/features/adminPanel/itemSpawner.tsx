import React, { useEffect, useRef, useState } from 'react';

import Button from '../../constructorComponents/button';

export interface ItemRow {
  desc: string; // espm desc, e.g. 12eb7:Skyrim.esm
  name: string;
  edid: string;
  type: string; // record type, e.g. WEAP
  plugin: string;
}

// One adminItems reply from the server
export interface ItemResults {
  query: string;
  kind: string;
  ready: boolean; // false while the server still builds its catalog
  total: number;
  page: number;
  pages: number;
  rows: ItemRow[];
}

interface ItemSpawnerProps {
  items: ItemResults | null;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
  selfActorId: string;
  selected: { a: string; n: string } | null; // the online Players row
  refreshKey: number; // bumped by the header Refresh to search again
}

// Pages offered in the picker; a huge result set is thinned so the dropdown stays usable and Previous/Next reach the rest
const pageNumbers = (pages: number): number[] => {
  const step = pages > 1000 ? Math.ceil(pages / 1000) : 1;
  const out: number[] = [];
  for (let n = 1; n <= pages; n += step) out.push(n);
  if (out[out.length - 1] !== pages) out.push(pages);
  return out;
};

const KINDS: Array<{ id: string; label: string }> = [
  { id: '', label: 'All' },
  { id: 'WEAP', label: 'Weapons' },
  { id: 'ARMO', label: 'Armor' },
  { id: 'AMMO', label: 'Ammo' },
  { id: 'ALCH', label: 'Potions' },
  { id: 'INGR', label: 'Ingredients' },
  { id: 'BOOK', label: 'Books' },
  { id: 'MISC', label: 'Misc' },
  { id: 'KEYM', label: 'Keys' },
  { id: 'SCRL', label: 'Scrolls' },
  { id: 'SLGM', label: 'Soul gems' },
  { id: 'LIGH', label: 'Lights' },
];

// Same bound the server enforces per spawn
const MAX_SPAWN_COUNT = 10000;

// Same cut the server applies before echoing the query
const MAX_QUERY_LENGTH = 64;

const normQuery = (q: string): string => q.trim().toLowerCase();

const isSpawnCount = (text: string): boolean => /^\d+$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= MAX_SPAWN_COUNT;

const kindLabel = (type: string): string => (KINDS.find((k) => k.id === type) || { label: type }).label;

// Kept across sub-tab switches and reopening the menu
let lastQuery = '';
let lastKind = '';
let lastPick: ItemRow | null = null;
let lastToPlayer = false;

const ItemSpawner = ({ items, ev, send, selfActorId, selected, refreshKey }: ItemSpawnerProps) => {
  const [query, setQuery] = useState(lastQuery);
  const [kind, setKind] = useState(lastKind);
  const [pick, setPick] = useState<ItemRow | null>(lastPick);
  const [count, setCount] = useState('1');
  const [toPlayer, setToPlayer] = useState(lastToPlayer);
  const [page, setPage] = useState(1);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    lastPick = pick;
    lastToPlayer = toPlayer;
  }, [pick, toPlayer]);

  const searchable = normQuery(query).length >= 2 || kind !== '';
  const search = (): void => {
    if (searchable && ev.itemSearch) send(ev.itemSearch, query.trim(), kind, page);
  };

  useEffect(() => {
    lastQuery = query;
    lastKind = kind;
    if (!searchable) return undefined;
    const timer = setTimeout(search, 250);
    return () => clearTimeout(timer);
  }, [query, kind, page, refreshKey]);

  useEffect(() => { setPage(1); }, [query, kind]);

  // A reply for an older query or kind is never shown
  const shown = items && normQuery(items.query || '') === normQuery(query) && (items.kind || '').toUpperCase() === kind && Number(items.page || 1) === page ? items : null;
  const loading = !!shown && shown.ready === false;
  const rows = shown && Array.isArray(shown.rows) ? shown.rows : [];

  // The server is still building its catalog
  useEffect(() => {
    if (!loading) return undefined;
    const timer = setInterval(search, 2000);
    return () => clearInterval(timer);
  }, [loading, query, kind]);

  // Escape empties a filled search box before the menu-wide close sees it
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const input = searchRef.current;
      if (e.key !== 'Escape' || !input || document.activeElement !== input || !input.value) return;
      e.stopImmediatePropagation();
      setQuery('');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const giveToPlayer = toPlayer && !!selected;
  const target = giveToPlayer && selected ? selected.a : selfActorId;
  const canSpawn = !!(pick && target && ev.itemSpawn && isSpawnCount(count));

  const spawn = (row: ItemRow | null): void => {
    if (row && target && ev.itemSpawn && isSpawnCount(count)) send(ev.itemSpawn, row.desc, Number(count), target);
  };

  let listText = '';
  if (!searchable) listText = 'Type at least two letters or pick a type';
  else if (!shown) listText = 'Searching';
  else if (loading) listText = 'Item list is loading';
  else if (!rows.length) listText = 'No items found';

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <input
          ref={searchRef}
          className="admin-panel__search"
          placeholder="Search items by name, editor ID or form ID"
          maxLength={MAX_QUERY_LENGTH}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="admin-panel__chips">
        {KINDS.map((k) => (
          <button
            key={k.id || 'all'}
            className={'admin-panel__mode admin-panel__mode--chip' + (kind === k.id ? ' admin-panel__mode--active' : '')}
            onClick={() => setKind(k.id)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="admin-panel__row admin-panel__row--head">
        <span className="admin-panel__cell admin-panel__cell--name">Name</span>
        <span className="admin-panel__cell admin-panel__cell--kind">Type</span>
        <span className="admin-panel__cell admin-panel__cell--edid">Editor ID</span>
        <span className="admin-panel__cell admin-panel__cell--desc">Form</span>
      </div>
      <div className="admin-panel__list">
        {listText ? (
          <div className="admin-panel__empty">{listText}</div>
        ) : (
          rows.map((row) => (
            <div
              key={row.desc}
              className={'admin-panel__row admin-panel__row--clickable' + (pick && pick.desc === row.desc ? ' admin-panel__row--selected' : '')}
              onClick={() => setPick(row)}
              onDoubleClick={() => {
                setPick(row);
                spawn(row);
              }}
            >
              <span className="admin-panel__cell admin-panel__cell--name" title={row.name}>{row.name || '-'}</span>
              <span className="admin-panel__cell admin-panel__cell--kind">{kindLabel(row.type)}</span>
              <span className="admin-panel__cell admin-panel__cell--edid" title={row.edid}>{row.edid || '-'}</span>
              <span className="admin-panel__cell admin-panel__cell--desc" title={row.desc}>{row.desc}</span>
            </div>
          ))
        )}
      </div>
      {shown && !loading && (shown.pages || 1) > 1 ? (
        <div className="admin-panel__actions admin-panel__pager">
          <span className="admin-panel__hint">{shown.total} items, {shown.pages} pages</span>
          <label className="admin-panel__checkbox">
            Page
            <select
              className="admin-panel__input admin-panel__pager-page"
              value={String(shown.page || page)}
              onChange={(e) => setPage(Number(e.target.value))}
            >
              {pageNumbers(shown.pages).map((n) => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </label>
          <Button text="Previous" width={92} height={30} disabled={page <= 1} onClick={() => setPage(page - 1)} />
          <Button text="Next" width={72} height={30} disabled={page >= (shown.pages || 1)} onClick={() => setPage(page + 1)} />
        </div>
      ) : null}
      <div className="admin-panel__actions admin-panel__spawn">
        <span className="admin-panel__spawn-item" title={pick ? pick.desc : undefined}>
          {pick ? pick.name || pick.edid || pick.desc : 'Select an item'}
        </span>
        <label className="admin-panel__checkbox">
          Count
          <input
            className="admin-panel__input admin-panel__spawn-count"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
        </label>
        <label className="admin-panel__checkbox">
          <input type="radio" name="item-spawn-target" checked={!giveToPlayer} onChange={() => setToPlayer(false)} />
          You
        </label>
        <label className="admin-panel__checkbox">
          <input type="radio" name="item-spawn-target" checked={giveToPlayer} disabled={!selected} onChange={() => setToPlayer(true)} />
          {selected ? selected.n || '(no name)' : 'Selected player'}
        </label>
        <Button text="Spawn" width={104} height={32} disabled={!canSpawn} onClick={() => spawn(pick)} />
      </div>
    </div>
  );
};

export default ItemSpawner;
