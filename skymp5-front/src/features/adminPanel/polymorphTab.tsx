import React, { useState } from 'react';

import Button from '../../constructorComponents/button';
import { loc } from '../../loc';

// One race of the server load order (polymorph.ts RaceRow)
export interface RaceRow {
  d: string; // desc, e.g. 1320a:Skyrim.esm
  n: string; // name
  e: string; // editor id
  g: string; // playable | vampire | people | creature
  r: string; // why it is a known crash risk, "" when none is known
  m: boolean; // male skeleton
  f: boolean; // female skeleton
}

// One online character still transformed
export interface PolymorphActive {
  a: string; // actor id hex
  n: string;
  race: string;
  by: number; // profile of the admin who did it
}

// The adminRaces reply (adminMenuService.ts parseRaces)
export interface RaceMenuData {
  ready: boolean; // false while the server still reads the load order
  rows: RaceRow[];
  active: PolymorphActive[];
}

interface PolymorphTabProps {
  data: RaceMenuData | null;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
  selfActorId: string;
  selected: { a: string; n: string } | null; // the online Players row
}

const GROUPS: Array<{ id: string; label: string }> = [
  { id: '', label: loc('adminPanel.common.all') },
  { id: 'playable', label: loc('adminPanel.polymorph.playable') },
  { id: 'vampire', label: loc('adminPanel.polymorph.vampire') },
  { id: 'people', label: loc('adminPanel.polymorph.people') },
  { id: 'creature', label: loc('adminPanel.polymorph.creature') },
];

// Closing the menu remounts the panel, so the picks live here
let saved = { race: '', search: '', group: '', toPlayer: false };

const groupLabel = (id: string): string => (GROUPS.find((g) => g.id === id) || GROUPS[0]).label;

// The server refuses a race without a skeleton and one marked as a crash risk
const usable = (r: RaceRow): boolean => (r.m || r.f) && !r.r;

const noteOf = (r: RaceRow): string => {
  if (!r.m && !r.f) return loc('adminPanel.polymorph.noSkeleton');
  if (r.r) return loc('adminPanel.polymorph.refused');
  const notes: string[] = [];
  if (r.g === 'creature') notes.push(loc('adminPanel.polymorph.gearOff'));
  if (!r.m || !r.f) notes.push(r.m ? loc('adminPanel.polymorph.maleOnly') : loc('adminPanel.polymorph.femaleOnly'));
  return notes.join(', ');
};

const PolymorphTab = ({ data, ev, send, selfActorId, selected }: PolymorphTabProps) => {
  const [form, setFormState] = useState(saved);

  const setForm = (next: typeof saved): void => {
    saved = next;
    setFormState(next);
  };

  const rows = data ? data.rows : [];
  const active = data ? data.active : [];
  const query = form.search.trim().toLowerCase();
  const shown = rows.filter((r) => (!form.group || r.g === form.group) && (!query || (r.n + ' ' + r.e + ' ' + r.d).toLowerCase().indexOf(query) !== -1));
  const pick = rows.find((r) => r.d === form.race) || null;
  const toPlayer = form.toPlayer && !!selected;
  const target = toPlayer && selected ? selected.a : '';
  const targetId = target || selfActorId;
  const current = active.find((x) => x.a === targetId) || null;
  const canTransform = !!(ev.polymorph && pick && usable(pick));

  const transform = (row: RaceRow | null): void => {
    if (row && ev.polymorph && usable(row)) send(ev.polymorph, target, row.d);
  };

  let listText = '';
  if (!data || !data.ready) listText = loc('adminPanel.polymorph.reading');
  else if (!shown.length) listText = loc('adminPanel.polymorph.noMatch');

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__filters">
        <input
          className="admin-panel__search"
          placeholder={loc('adminPanel.polymorph.search')}
          value={form.search}
          onChange={(e) => setForm({ ...form, search: e.target.value })}
        />
      </div>
      <div className="admin-panel__chips">
        {GROUPS.map((g) => (
          <button
            key={g.id || 'all'}
            className={'admin-panel__mode admin-panel__mode--chip' + (form.group === g.id ? ' admin-panel__mode--active' : '')}
            onClick={() => setForm({ ...form, group: g.id })}
          >
            {g.label}
          </button>
        ))}
      </div>
      <div className="admin-panel__row admin-panel__row--head">
        <span className="admin-panel__cell admin-panel__cell--name">{loc('adminPanel.polymorph.race')}</span>
        <span className="admin-panel__cell admin-panel__cell--kind">{loc('adminPanel.polymorph.group')}</span>
        <span className="admin-panel__cell admin-panel__cell--edid">{loc('adminPanel.common.editorId')}</span>
        <span className="admin-panel__cell admin-panel__cell--desc">{loc('adminPanel.common.form')}</span>
      </div>
      <div className="admin-panel__list admin-panel__list--races">
        {listText ? (
          <div className="admin-panel__empty">{listText}</div>
        ) : (
          shown.map((r) => {
            const note = noteOf(r);
            return (
              <div
                key={r.d}
                className={'admin-panel__row admin-panel__row--clickable admin-panel__row--zone'
                  + (pick && pick.d === r.d ? ' admin-panel__row--selected' : '')
                  + (usable(r) ? '' : ' admin-panel__row--offline')}
                onClick={() => setForm({ ...form, race: r.d })}
                onDoubleClick={() => {
                  setForm({ ...form, race: r.d });
                  transform(r);
                }}
              >
                <div className="admin-panel__zone-info admin-panel__race-info">
                  <span className="admin-panel__cell admin-panel__cell--name" title={r.n}>{r.n}</span>
                  {r.r || note ? (
                    <span className={'admin-panel__cell admin-panel__cell--status' + (r.r ? ' admin-panel__cell--risk' : '')} title={r.r || note}>
                      {[r.r ? loc('adminPanel.polymorph.crashRisk', { reason: r.r }) : '', note].filter(Boolean).join(' · ')}
                    </span>
                  ) : null}
                </div>
                <span className="admin-panel__cell admin-panel__cell--kind">{groupLabel(r.g)}</span>
                <span className="admin-panel__cell admin-panel__cell--edid" title={r.e}>{r.e}</span>
                <span className="admin-panel__cell admin-panel__cell--desc" title={r.d}>{r.d}</span>
              </div>
            );
          })
        )}
      </div>
      <div className="admin-panel__actions admin-panel__spawn">
        <span className="admin-panel__spawn-item" title={pick ? pick.d : undefined}>
          {pick ? pick.n + ' (' + pick.e + ')' : loc('adminPanel.polymorph.selectRace')}
        </span>
        <label className="admin-panel__checkbox">
          <input type="radio" name="polymorph-target" checked={!toPlayer} onChange={() => setForm({ ...form, toPlayer: false })} />
          {loc('adminPanel.common.you')}
        </label>
        <label className="admin-panel__checkbox">
          <input type="radio" name="polymorph-target" checked={toPlayer} disabled={!selected} onChange={() => setForm({ ...form, toPlayer: true })} />
          {selected ? selected.n || loc('adminPanel.common.noName') : loc('adminPanel.common.selectedPlayer')}
        </label>
        <Button text={loc('adminPanel.polymorph.transform')} width={104} height={32} disabled={!canTransform} onClick={() => transform(pick)} />
        <Button text={loc('adminPanel.common.revert')} width={104} height={32} disabled={!ev.polymorphRevert} onClick={() => send(ev.polymorphRevert, target)} />
      </div>
      {active.length ? (
        <div className="admin-panel__list admin-panel__list--effects">
          {active.map((x) => (
            <div key={x.a} className={'admin-panel__row admin-panel__row--zone' + (x.a === targetId ? ' admin-panel__row--selected' : '')}>
              <div className="admin-panel__zone-info">
                <span className="admin-panel__cell admin-panel__cell--name" title={x.a}>{x.a === selfActorId ? loc('adminPanel.common.nameYou', { name: x.n }) : x.n}</span>
                <span className="admin-panel__cell admin-panel__cell--status" title={x.race}>{loc('adminPanel.polymorph.activeBy', { race: x.race, profile: x.by })}</span>
              </div>
              <div className="admin-panel__zone-buttons">
                <Button text={loc('adminPanel.common.revert')} width={72} height={24} disabled={!ev.polymorphRevert} onClick={() => send(ev.polymorphRevert, x.a === selfActorId ? '' : x.a)} />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      <span className="admin-panel__hint">
        {current ? loc('adminPanel.polymorph.current', { race: current.race }) + ' ' : ''}
        {loc('adminPanel.polymorph.hint')}
      </span>
    </div>
  );
};

export default PolymorphTab;
