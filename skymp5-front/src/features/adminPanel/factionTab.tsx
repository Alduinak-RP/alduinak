import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';
import Dropdown from './dropdown';
import ConfirmDialog from '../../components/ConfirmDialog/ConfirmDialog';
import { loc } from '../../loc';

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
  canRegent: boolean;
}

// One Main tab column: this character's standing in one faction
export interface FactionColumn {
  id: string;
  name: string;
  type: FactionType;
  province: string;
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
  province: string;
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
  factions: Array<{ id: string; name: string; type: FactionType; province: string; color: string; rank: string }>;
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

// The hold type reads Territory everywhere a player or staff member sees it
export const TYPE_LABEL: Record<FactionType, string> = {
  hold: loc('adminPanel.faction.typeHold'),
  military: loc('adminPanel.faction.typeMilitary'),
  guild: loc('adminPanel.faction.typeGuild'),
};

const TYPE_TABS: Array<{ id: FactionType; label: string }> = [
  { id: 'hold', label: TYPE_LABEL.hold },
  { id: 'military', label: TYPE_LABEL.military },
  { id: 'guild', label: TYPE_LABEL.guild },
];

const memberName = (m: FactionMember): string => {
  const name = m.self ? loc('adminPanel.common.nameYou', { name: m.name }) : m.name;
  if (m.acting) return loc('adminPanel.faction.memberActing', { name });
  return m.regent ? loc('adminPanel.faction.memberRegent', { name }) : name;
};

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

  if (!data) return <div className="admin-panel__empty">{loc('adminPanel.faction.loading')}</div>;
  if (!data.available) return <div className="admin-panel__empty">{loc('adminPanel.faction.unavailable')}</div>;

  const main = data.main || [];
  const detail = data.detail;
  const regency = data.regency;
  const act = (factionId: string, payload: Record<string, unknown>): void => {
    setConfirm('');
    setMenu(null);
    send(ev.faction, JSON.stringify(Object.assign({ factionId }, payload)));
  };
  const leaving = main.find((c) => confirm === 'leave:' + c.id);
  const target = (m: FactionMember) => ({ profileId: m.profileId, slot: m.slot });

  // A type tab is shown while the character belongs to that type, and to staff so they can browse every faction
  const shownTabs: Array<{ id: Tab; label: string }> = [{ id: 'main', label: loc('adminPanel.faction.tabMain') }];
  for (const t of TYPE_TABS) if (data.byType[t.id] || data.staff) shownTabs.push(t);
  if (regency) shownTabs.push({ id: 'regency', label: loc('adminPanel.faction.tabRegency') });
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
            {loc('adminPanel.faction.removeRegent')}
          </button>
        );
      }
    } else if (m) {
      for (const r of m.promote) {
        items.push(
          <button key={'r' + r.slug} className="admin-panel__menu-item" onClick={() => act(factionId, Object.assign({ action: 'promote', rank: r.slug }, target(m)))}>
            {loc('adminPanel.faction.setRank', { rank: r.name })}
          </button>
        );
      }
      if (m.canRegent) {
        items.push(
          <button key="regent" className="admin-panel__menu-item" onClick={() => act(factionId, Object.assign({ action: 'regentAdd' }, target(m)))}>
            {loc('adminPanel.faction.addRegent')}
          </button>
        );
      }
      if (m.canRemove) {
        items.push(
          confirm === m.key ? (
            <button key="remove" className="admin-panel__menu-item admin-panel__menu-item--danger" onClick={() => act(factionId, Object.assign({ action: 'remove' }, target(m)))}>
              {loc('adminPanel.faction.confirmRemoval')}
            </button>
          ) : (
            <button key="remove" className="admin-panel__menu-item admin-panel__menu-item--danger" onMouseDown={(e) => e.stopPropagation()} onClick={() => setConfirm(m.key)}>
              {loc('adminPanel.faction.removeFromFaction')}
            </button>
          )
        );
      }
    }
    if (!items.length) items.push(<span key="none" className="admin-panel__menu-empty">{loc('adminPanel.faction.nothingToDo')}</span>);
    return (
      <div className="admin-panel__menu" style={{ left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
        {items}
      </div>
    );
  };

  const mainTab = (): React.ReactNode => {
    if (!main.length) return <div className="admin-panel__empty admin-panel__empty--placeholder">{loc('adminPanel.faction.noFactions')}</div>;
    return (
      <div className="admin-panel__columns">
        {main.map((c) => (
          <div key={c.id} className="admin-panel__column">
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colName')}</span><span style={{ color: '#' + c.color }}>{c.name}</span></div>
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colType')}</span><span>{c.province ? loc('adminPanel.faction.typeProvince', { type: TYPE_LABEL[c.type] || c.type, province: c.province }) : TYPE_LABEL[c.type] || c.type}</span></div>
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colRank')}</span><span>{c.rankName}</span></div>
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colLeader')}</span><span>{c.leaderName}</span></div>
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colMembers')}</span><span>{c.members}</span></div>
            <div className="admin-panel__column-row"><span>{loc('adminPanel.faction.colTenure')}</span><span>{c.tenure}</span></div>
            <label className="admin-panel__check">
              <input
                type="checkbox"
                checked={data.titleFactionId === c.id}
                onChange={() => act(c.id, { action: 'title' })}
              />
              {c.title ? loc('adminPanel.faction.showTitleNamed', { title: c.title }) : loc('adminPanel.faction.showTitle')}
            </label>
            <Button text={loc('adminPanel.faction.leaveFaction')} width={150} height={32} onClick={() => setConfirm('leave:' + c.id)} />
          </div>
        ))}
      </div>
    );
  };

  const rosterTab = (type: FactionType): React.ReactNode => {
    if (!detail || detail.type !== type) return <div className="admin-panel__empty">{loc('adminPanel.faction.loadingMembers')}</div>;
    return (
      <>
        <div className="admin-panel__filters">
          {data.staff && data.factions.filter((f) => f.type === type).length > 1 ? (
            <Dropdown
              className="admin-panel__faction-pick"
              value={detail.id}
              options={data.factions.filter((f) => f.type === type).map((f) => ({ value: f.id, label: f.name }))}
              onChange={(id) => send(ev.factionMenu, id)}
            />
          ) : null}
          <span className="admin-panel__faction-name" style={{ color: '#' + detail.color }}>{detail.name}</span>
          <span className="admin-panel__hint">
            {detail.myRank ? loc(detail.acting ? 'adminPanel.faction.yourRankActing' : 'adminPanel.faction.yourRank', { rank: detail.myRank }) : loc('adminPanel.faction.staffView')}
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
          <span className="admin-panel__cell admin-panel__cell--name">{loc('adminPanel.common.name')}</span>
          <span className="admin-panel__cell admin-panel__cell--rank">{loc('adminPanel.faction.rank')}</span>
          <span className="admin-panel__cell admin-panel__cell--status">{loc('adminPanel.faction.tenure')}</span>
        </div>
        <div className="admin-panel__list">
          {detail.members.length === 0 ? (
            <div className="admin-panel__empty">{loc('adminPanel.faction.noMembers')}</div>
          ) : (
            detail.members.map((m) => (
              <div
                key={m.key}
                className={'admin-panel__row admin-panel__row--faction' + (m.online ? '' : ' admin-panel__row--offline')}
                onClick={(e) => openMenu(e, m, '')}
                onContextMenu={(e) => openMenu(e, m, '')}
              >
                <span className={'admin-panel__dot' + (m.online ? ' admin-panel__dot--online' : '')} />
                <span className="admin-panel__cell admin-panel__cell--name" title={m.slot === null ? loc('adminPanel.faction.everyCharacter') : loc('adminPanel.faction.character', { n: m.slot + 1 })}>
                  {memberName(m)}
                </span>
                <span className="admin-panel__cell admin-panel__cell--rank">{m.rankName}</span>
                <span className="admin-panel__cell admin-panel__cell--status">{m.tenure}</span>
              </div>
            ))
          )}
        </div>
        {detail.recruitRank ? (
          <div className="admin-panel__mastery">
            <span className="admin-panel__hint">{loc('adminPanel.faction.recruitAs', { rank: detail.recruitRank.name })}</span>
            {detail.nearby.length === 0 ? (
              <span className="admin-panel__hint">{loc('adminPanel.faction.nobodyNear')}</span>
            ) : (
              detail.nearby.map((p) => (
                <div key={p.target} className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-info">{p.name}</span>
                  <Button text={loc('adminPanel.faction.recruit')} width={96} height={30} onClick={() => act(detail.id, { action: 'recruit', target: p.target })} />
                </div>
              ))
            )}
          </div>
        ) : null}
        <span className="admin-panel__hint">
          {loc('adminPanel.faction.rosterHint')}
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
    if (!regency) return <div className="admin-panel__empty">{loc('adminPanel.faction.notLeader')}</div>;
    const seats = order.length === regency.seats.length
      ? (order.map((k) => regency.seats.find((s) => s.key === k)).filter(Boolean) as FactionRegency['seats'])
      : regency.seats;
    return (
      <>
        <div className="admin-panel__filters">
          <span className="admin-panel__faction-name">{regency.name}</span>
          <span className="admin-panel__hint">{loc('adminPanel.faction.regentsActAs', { title: regency.regentTitle })}</span>
          <div className="admin-panel__filters admin-panel__filters--end admin-panel__actions">
            <Button
              text={regency.enabled ? loc('adminPanel.faction.disableRegency') : loc('adminPanel.faction.enableRegency')}
              width={170}
              height={32}
              onClick={() => act(regency.factionId, { action: 'regency', enabled: !regency.enabled })}
            />
          </div>
        </div>
        <div className="admin-panel__list">
          {seats.length === 0 ? (
            <div className="admin-panel__empty">{loc('adminPanel.faction.noRegents')}</div>
          ) : (
            seats.map((s, i) => (
              <div
                key={s.key}
                className={'admin-panel__row admin-panel__row--faction admin-panel__row--drag' + (s.online ? '' : ' admin-panel__row--offline')}
                draggable
                onDragStart={() => setDrag(s.key)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => dropSeat(s.key)}
                onClick={(e) => openMenu(e, null, s.key)}
                onContextMenu={(e) => openMenu(e, null, s.key)}
              >
                <span className={'admin-panel__dot' + (s.online ? ' admin-panel__dot--online' : '')} />
                <span className="admin-panel__cell admin-panel__cell--name">{loc(s.acting ? 'adminPanel.faction.seatActing' : 'adminPanel.faction.seat', { n: i + 1, name: s.name })}</span>
                <span className="admin-panel__cell admin-panel__cell--rank">{s.rankName}</span>
              </div>
            ))
          )}
        </div>
        <span className="admin-panel__hint">{loc('adminPanel.faction.regencyHint')}</span>
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
      {leaving ? (
        <ConfirmDialog
          title={loc('adminPanel.faction.leaveTitle', { name: leaving.name })}
          body={loc('adminPanel.faction.leaveBody')}
          confirmLabel={loc('adminPanel.faction.leave')}
          onConfirm={() => act(leaving.id, { action: 'leave' })}
          onCancel={() => setConfirm('')}
        />
      ) : null}
    </div>
  );
};

export default FactionTab;
