import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';

export type FactionType = 'hold' | 'military' | 'guild';

// One roster row as built by the server (factionSystem.ts MemberView); every flag is the server's decision
export interface FactionMember {
  key: string;
  profileId: number;
  slot: number | null; // null: the rank is shared by every character of the account
  name: string;
  rankSlug: string;
  rankName: string;
  online: boolean;
  self: boolean;
  tenure: string;
  regent: boolean; // holds a regency seat
  acting: boolean; // standing in for an absent leader right now
  promote: Array<{ slug: string; name: string }>; // ranks the viewer may move them to, up or down
  canRemove: boolean;
  canUniform: boolean;
  canRegent: boolean;
}

// One Main tab column: this character's standing in one faction
export interface FactionColumn {
  id: string;
  name: string;
  type: FactionType;
  zone: string;
  color: string;
  rankName: string;
  title: string;
  leaderName: string;
  members: number;
  tenure: string;
  titleShown: boolean;
}

export interface FactionDetail {
  id: string;
  name: string;
  type: FactionType;
  zone: string;
  color: string;
  myRank: string; // '' when viewing as staff without a rank
  acting: boolean;
  staff: boolean;
  ranks: Array<{ slug: string; name: string; capacity: number | null; count: number }>;
  members: FactionMember[];
  canLeave: boolean;
  recruitRank: { slug: string; name: string } | null; // the rank Recruit grants, null when the viewer may not recruit
  nearby: Array<{ target: number; name: string }>; // players in range who are not members
}

export interface FactionRegency {
  factionId: string;
  name: string;
  type: FactionType;
  enabled: boolean;
  regentTitle: string;
  seats: Array<{ key: string; profileId: number; slot: number | null; name: string; rankName: string; online: boolean; acting: boolean }>;
}

// The factionMenu packet
export interface FactionMenuData {
  available: boolean;
  staff: boolean;
  titleFactionId: string; // the faction whose title is shown with the character's name, '' for none
  main: FactionColumn[];
  byType: Partial<Record<FactionType, string>>; // the character's faction of each type
  factions: Array<{ id: string; name: string; type: FactionType; zone: string; color: string; rank: string }>;
  selected: string;
  detail: FactionDetail | null;
  regency: FactionRegency | null; // present only while the viewer leads a faction
}

interface FactionTabProps {
  data: FactionMenuData | null;
  ev: Record<string, string>;
  send: (key: string, ...args: unknown[]) => void;
}

type Tab = FactionType | 'main' | 'regency';

const TYPE_TABS: Array<{ id: FactionType; label: string }> = [
  { id: 'hold', label: 'Hold' },
  { id: 'military', label: 'Military' },
  { id: 'guild', label: 'Guild' },
];

const TYPE_LABEL: Record<FactionType, string> = { hold: 'Hold', military: 'Military', guild: 'Guild' };
const ZONES: Record<string, string> = { west: 'West', east: 'East', neutral: 'Neutral' };

interface MenuState {
  x: number;
  y: number;
  member: FactionMember | null;
  seatKey: string; // regency tab: the seat the menu belongs to
}

const FactionTab = ({ data, ev, send }: FactionTabProps) => {
  const [tab, setTab] = useState<Tab>('main');
  const [confirm, setConfirm] = useState('');
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [drag, setDrag] = useState('');
  const [order, setOrder] = useState<string[]>([]);

  // Any click outside a context menu closes it, the same way the game's own menus behave
  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  if (!data) return <div className="admin-panel__empty">Loading factions</div>;
  if (!data.available) return <div className="admin-panel__empty">Factions are unavailable right now.</div>;

  const main = data.main || [];
  const detail = data.detail;
  const regency = data.regency;
  const act = (factionId: string, payload: Record<string, unknown>): void => {
    setConfirm('');
    setMenu(null);
    send(ev.faction, JSON.stringify(Object.assign({ factionId }, payload)));
  };
  const target = (m: FactionMember) => ({ profileId: m.profileId, slot: m.slot });

  // A type tab is shown while the character belongs to that type, and to staff so they can browse every faction
  const shownTabs: Array<{ id: Tab; label: string }> = [{ id: 'main', label: 'Main' }];
  for (const t of TYPE_TABS) if (data.byType[t.id] || data.staff) shownTabs.push(t);
  if (regency) shownTabs.push({ id: 'regency', label: 'Regency' });
  const activeTab: Tab = shownTabs.some((t) => t.id === tab) ? tab : 'main';

  // Switching to a type tab asks the server for that faction's roster
  const openTab = (id: Tab): void => {
    setTab(id);
    setMenu(null);
    setConfirm('');
    const wanted = id === 'regency' ? regency?.factionId : data.byType[id as FactionType] || data.factions.find((f) => f.type === id)?.id;
    if (wanted && wanted !== data.selected && ev.factionMenu) send(ev.factionMenu, wanted);
  };

  const openMenu = (e: React.MouseEvent, member: FactionMember | null, seatKey: string): void => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, member, seatKey });
  };

  const contextMenu = (): React.ReactNode => {
    if (!menu) return null;
    const m = menu.member;
    const factionId = menu.seatKey && regency ? regency.factionId : detail?.id || '';
    const items: React.ReactNode[] = [];
    if (menu.seatKey && regency) {
      const seat = regency.seats.find((s) => s.key === menu.seatKey);
      if (seat) {
        items.push(
          <button key="unseat" className="admin-panel__menu-item" onClick={() => act(factionId, { action: 'regentRemove', profileId: seat.profileId, slot: seat.slot })}>
            Remove regent
          </button>
        );
      }
    } else if (m) {
      for (const r of m.promote) {
        items.push(
          <button key={'r' + r.slug} className="admin-panel__menu-item" onClick={() => act(factionId, Object.assign({ action: 'promote', rank: r.slug }, target(m)))}>
            {'Set rank: ' + r.name}
          </button>
        );
      }
      if (m.canUniform && m.online) {
        items.push(
          <button key="uniform" className="admin-panel__menu-item" onClick={() => act(factionId, Object.assign({ action: 'uniform' }, target(m)))}>
            Issue uniform
          </button>
        );
      }
      if (m.canRegent) {
        items.push(
          <button key="regent" className="admin-panel__menu-item" onClick={() => act(factionId, Object.assign({ action: 'regentAdd' }, target(m)))}>
            Add Regent
          </button>
        );
      }
      if (m.canRemove) {
        items.push(
          confirm === m.key ? (
            <button key="remove" className="admin-panel__menu-item admin-panel__menu-item--danger" onClick={() => act(factionId, Object.assign({ action: 'remove' }, target(m)))}>
              Confirm removal
            </button>
          ) : (
            <button key="remove" className="admin-panel__menu-item admin-panel__menu-item--danger" onMouseDown={(e) => e.stopPropagation()} onClick={() => setConfirm(m.key)}>
              Remove from faction
            </button>
          )
        );
      }
    }
    if (!items.length) items.push(<span key="none" className="admin-panel__menu-empty">Nothing you may do here</span>);
    return (
      <div className="admin-panel__menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        {items}
      </div>
    );
  };

  const mainTab = (): React.ReactNode => {
    if (!main.length) return <div className="admin-panel__empty admin-panel__empty--placeholder">Not apart of any factions.</div>;
    return (
      <div className="admin-panel__columns">
        {main.map((c) => (
          <div key={c.id} className="admin-panel__column">
            <span className="admin-panel__faction-name" style={{ color: '#' + c.color }}>{c.name}</span>
            <div className="admin-panel__column-row"><span>Name:</span><span>{c.name}</span></div>
            <div className="admin-panel__column-row"><span>Type:</span><span>{TYPE_LABEL[c.type] || c.type}{ZONES[c.zone] ? ' (' + ZONES[c.zone] + ')' : ''}</span></div>
            <div className="admin-panel__column-row"><span>Rank:</span><span>{c.rankName}</span></div>
            <div className="admin-panel__column-row"><span>Leader:</span><span>{c.leaderName}</span></div>
            <div className="admin-panel__column-row"><span>Members:</span><span>{c.members}</span></div>
            <div className="admin-panel__column-row"><span>Tenure:</span><span>{c.tenure}</span></div>
            <label className="admin-panel__check">
              <input
                type="checkbox"
                checked={data.titleFactionId === c.id}
                onChange={() => act(c.id, { action: 'title' })}
              />
              {'Show Title' + (c.title ? ' (' + c.title + ')' : '')}
            </label>
            {confirm === 'leave:' + c.id ? (
              <Button text="Confirm leave" width={150} height={32} onClick={() => act(c.id, { action: 'leave' })} />
            ) : (
              <Button text="Leave Faction" width={150} height={32} onClick={() => setConfirm('leave:' + c.id)} />
            )}
          </div>
        ))}
      </div>
    );
  };

  const rosterTab = (type: FactionType): React.ReactNode => {
    if (!detail || detail.type !== type) return <div className="admin-panel__empty">Loading members</div>;
    return (
      <>
        <div className="admin-panel__filters">
          {data.staff && data.factions.filter((f) => f.type === type).length > 1 ? (
            <select className="admin-panel__input admin-panel__faction-pick" value={detail.id} onChange={(e) => send(ev.factionMenu, e.target.value)}>
              {data.factions.filter((f) => f.type === type).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          ) : null}
          <span className="admin-panel__faction-name" style={{ color: '#' + detail.color }}>{detail.name}</span>
          <span className="admin-panel__hint">
            {detail.myRank ? 'Your rank: ' + detail.myRank + (detail.acting ? ' (acting leader)' : '') : 'Staff view'}
          </span>
        </div>

        <div className="admin-panel__chips">
          {detail.ranks.map((r) => (
            <span key={r.slug} className="admin-panel__faction-badge">
              {r.name + ' ' + r.count + (r.capacity ? '/' + r.capacity : '')}
            </span>
          ))}
        </div>

        <div className="admin-panel__row admin-panel__row--head">
          <span className="admin-panel__dot" />
          <span className="admin-panel__cell admin-panel__cell--name">Name</span>
          <span className="admin-panel__cell admin-panel__cell--rank">Rank</span>
          <span className="admin-panel__cell admin-panel__cell--status">Tenure</span>
        </div>
        <div className="admin-panel__list">
          {detail.members.length === 0 ? (
            <div className="admin-panel__empty">No members yet</div>
          ) : (
            detail.members.map((m) => (
              <div
                key={m.key}
                className={'admin-panel__row admin-panel__row--faction' + (m.online ? '' : ' admin-panel__row--offline')}
                onContextMenu={(e) => openMenu(e, m, '')}
              >
                <span className={'admin-panel__dot' + (m.online ? ' admin-panel__dot--online' : '')} />
                <span className="admin-panel__cell admin-panel__cell--name" title={m.slot === null ? 'Every character of this account' : 'Character ' + (m.slot + 1)}>
                  {m.name + (m.self ? ' (you)' : '') + (m.acting ? ' - acting' : m.regent ? ' - regent' : '')}
                </span>
                <span className="admin-panel__cell admin-panel__cell--rank">{m.rankName}</span>
                <span className="admin-panel__cell admin-panel__cell--status">{m.tenure}</span>
              </div>
            ))
          )}
        </div>
        {detail.recruitRank ? (
          <div className="admin-panel__mastery">
            <span className="admin-panel__hint">{'Recruit brings them in as ' + detail.recruitRank.name + '.'}</span>
            {detail.nearby.length === 0 ? (
              <span className="admin-panel__hint">Nobody is close enough to recruit</span>
            ) : (
              detail.nearby.map((p) => (
                <div key={p.target} className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-info">{p.name}</span>
                  <Button text="Recruit" width={96} height={30} onClick={() => act(detail.id, { action: 'recruit', target: p.target })} />
                </div>
              ))
            )}
          </div>
        ) : null}
        <span className="admin-panel__hint">
          Right click a member to promote, remove or seat them. You can also look at a player and press the interact key to Recruit.
        </span>
      </>
    );
  };

  // Click and drag reorders the line of succession; the new order is sent once the row is dropped
  const dropSeat = (key: string): void => {
    if (!regency || !drag || drag === key) return;
    const keys = (order.length === regency.seats.length ? order : regency.seats.map((s) => s.key)).slice();
    const from = keys.indexOf(drag);
    const to = keys.indexOf(key);
    if (from === -1 || to === -1) return;
    keys.splice(to, 0, keys.splice(from, 1)[0]);
    setOrder(keys);
    setDrag('');
    const seats = keys.map((k) => regency.seats.find((s) => s.key === k)).filter(Boolean) as FactionRegency['seats'];
    act(regency.factionId, { action: 'regentOrder', order: seats.map((s) => ({ profileId: s.profileId, slot: s.slot })) });
  };

  const regencyTab = (): React.ReactNode => {
    if (!regency) return <div className="admin-panel__empty">You do not lead a faction.</div>;
    const seats = order.length === regency.seats.length
      ? (order.map((k) => regency.seats.find((s) => s.key === k)).filter(Boolean) as FactionRegency['seats'])
      : regency.seats;
    return (
      <>
        <div className="admin-panel__filters">
          <span className="admin-panel__faction-name">{regency.name}</span>
          <span className="admin-panel__hint">{'Regents act as ' + regency.regentTitle + ' while you are offline.'}</span>
          <div className="admin-panel__filters admin-panel__filters--end admin-panel__actions">
            <Button
              text={regency.enabled ? 'Disable regency' : 'Enable regency'}
              width={170}
              height={32}
              onClick={() => act(regency.factionId, { action: 'regency', enabled: !regency.enabled })}
            />
          </div>
        </div>
        <div className="admin-panel__list">
          {seats.length === 0 ? (
            <div className="admin-panel__empty">No regents yet. Right click a member on the roster and choose Add Regent.</div>
          ) : (
            seats.map((s, i) => (
              <div
                key={s.key}
                className={'admin-panel__row admin-panel__row--faction admin-panel__row--drag' + (s.online ? '' : ' admin-panel__row--offline')}
                draggable
                onDragStart={() => setDrag(s.key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropSeat(s.key)}
                onContextMenu={(e) => openMenu(e, null, s.key)}
              >
                <span className={'admin-panel__dot' + (s.online ? ' admin-panel__dot--online' : '')} />
                <span className="admin-panel__cell admin-panel__cell--name">{(i + 1) + '. ' + s.name + (s.acting ? ' - acting now' : '')}</span>
                <span className="admin-panel__cell admin-panel__cell--rank">{s.rankName}</span>
              </div>
            ))
          )}
        </div>
        <span className="admin-panel__hint">Drag a regent to change the order of succession, right click to remove them.</span>
      </>
    );
  };

  return (
    <div className="admin-panel__body">
      <div className="admin-panel__tabs admin-panel__tabs--sub">
        {shownTabs.map((t) => (
          <button
            key={t.id}
            className={'admin-panel__tab' + (activeTab === t.id ? ' admin-panel__tab--active' : '')}
            onClick={() => openTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {activeTab === 'main' ? mainTab() : null}
      {activeTab === 'regency' ? regencyTab() : null}
      {activeTab !== 'main' && activeTab !== 'regency' ? rosterTab(activeTab) : null}
      {contextMenu()}
    </div>
  );
};

export default FactionTab;
