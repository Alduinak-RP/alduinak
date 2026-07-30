import React, { useState } from 'react';

import Button from '../../constructorComponents/button';
import './styles.scss';

// One roster row as merged by the server (online actor data + backend record).
interface PanelPlayer {
  a?: string; // actor/form id hex, online only
  p: number; // profileId
  n: string; // character name
  d: string; // discordId
  dn: string; // discord name
  ip: string; // masked server-side
  hwid: string;
  online: boolean;
  ping: number | null;
}

interface PanelLocation {
  name: string;
}

interface PanelMode {
  id: string;
  label: string;
  active: boolean;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface AdminPanelData {
  players: PanelPlayer[];
  locations: PanelLocation[];
  modes: PanelMode[];
  events: Record<string, string>;
}

const send = (key: string, ...args: unknown[]): void => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).skyrimPlatform.sendMessage(key, ...args);
  } catch (e) {
    // Running outside the game (e.g. Storybook) - log instead.
    // eslint-disable-next-line no-console
    console.log('adminPanel sendMessage', key, args);
  }
};

type Tab = 'players' | 'teleport' | 'modes';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'players', label: 'Players' },
  { id: 'teleport', label: 'Teleport' },
  { id: 'modes', label: 'Modes' },
];

const AdminPanel = ({ data }: { data: AdminPanelData }) => {
  const [tab, setTab] = useState<Tab>('players');
  const [search, setSearch] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [locSearch, setLocSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);

  const ev = data.events || {};
  const players = data.players || [];
  const locations = data.locations || [];
  const modes = data.modes || [];

  const filter = search.trim().toLowerCase();
  const shownPlayers = players.filter((pl) => {
    if (onlineOnly && !pl.online) return false;
    if (!filter) return true;
    const hay = [pl.n, pl.dn, pl.d, String(pl.p), pl.a || '', pl.ip, pl.hwid].join(' ').toLowerCase();
    return hay.indexOf(filter) !== -1;
  });

  const selectedPlayer = players.find((pl) => pl.p === selected) || null;
  // TP/Summon/Kick/Ban all target the live actor; offline rows only display identity
  const actionsEnabled = !!(selectedPlayer && selectedPlayer.online && selectedPlayer.a);

  const act = (key: string): void => {
    if (selectedPlayer && selectedPlayer.a) send(key, selectedPlayer.a);
  };

  const locFilter = locSearch.trim().toLowerCase();
  const shownLocations = locations.filter((l) => !locFilter || l.name.toLowerCase().indexOf(locFilter) !== -1);

  return (
    <div className="admin-panel">
      <div className="admin-panel__window">
        <div className="admin-panel__header">
          <span className="admin-panel__title">Admin Panel</span>
          <div className="admin-panel__header-buttons">
            <Button text="Refresh" width={104} height={32} onClick={() => send(ev.refresh)} />
            <Button text="Close" width={104} height={32} onClick={() => send(ev.close)} />
          </div>
        </div>

        <div className="admin-panel__tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={'admin-panel__tab' + (tab === t.id ? ' admin-panel__tab--active' : '')}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'players' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__actions">
              <Button text="TP to" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.tp)} />
              <Button text="Summon" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.summon)} />
              <Button text="Kick" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.kick)} />
              <Button text="Ban" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.ban)} />
            </div>
            <div className="admin-panel__filters">
              <input
                className="admin-panel__search"
                placeholder="Search players"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="admin-panel__checkbox">
                <input
                  type="checkbox"
                  checked={onlineOnly}
                  onChange={(e) => setOnlineOnly(e.target.checked)}
                />
                Online only
              </label>
            </div>
            <div className="admin-panel__row admin-panel__row--head">
              <span className="admin-panel__dot" />
              <span className="admin-panel__cell admin-panel__cell--ping">Ping</span>
              <span className="admin-panel__cell admin-panel__cell--profile">Profile</span>
              <span className="admin-panel__cell admin-panel__cell--name">Character</span>
              <span className="admin-panel__cell admin-panel__cell--form">Form ID</span>
              <span className="admin-panel__cell admin-panel__cell--discord">Discord</span>
              <span className="admin-panel__cell admin-panel__cell--discord-id">Discord ID</span>
              <span className="admin-panel__cell admin-panel__cell--ip">IP</span>
              <span className="admin-panel__cell admin-panel__cell--hwid">HWID</span>
            </div>
            <div className="admin-panel__list">
              {shownPlayers.length === 0 ? (
                <div className="admin-panel__empty">No players found</div>
              ) : (
                shownPlayers.map((pl) => (
                  <div
                    key={pl.p + '|' + pl.d}
                    className={
                      'admin-panel__row admin-panel__row--clickable' +
                      (pl.online ? '' : ' admin-panel__row--offline') +
                      (pl.p === selected ? ' admin-panel__row--selected' : '')
                    }
                    onClick={() => setSelected(pl.p)}
                  >
                    <span className={'admin-panel__dot' + (pl.online ? ' admin-panel__dot--online' : '')} />
                    <span className="admin-panel__cell admin-panel__cell--ping">
                      {pl.online && pl.ping != null ? pl.ping + 'ms' : '-'}
                    </span>
                    <span className="admin-panel__cell admin-panel__cell--profile">{pl.p}</span>
                    <span className="admin-panel__cell admin-panel__cell--name">{pl.n || '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--form">{pl.a ? '0x' + pl.a : '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--discord">{pl.dn || '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--discord-id">{pl.d || '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--ip">{pl.ip || '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--hwid" title={pl.hwid}>{pl.hwid || '-'}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {tab === 'teleport' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__filters">
              <input
                className="admin-panel__search"
                placeholder="Search locations"
                value={locSearch}
                onChange={(e) => setLocSearch(e.target.value)}
              />
            </div>
            <div className="admin-panel__list">
              {shownLocations.length === 0 ? (
                <div className="admin-panel__empty">No locations configured</div>
              ) : (
                shownLocations.map((l) => (
                  <div key={l.name} className="admin-panel__row admin-panel__row--location">
                    <span className="admin-panel__cell admin-panel__cell--name">{l.name}</span>
                    <Button text="Teleport" width={112} height={30} onClick={() => send(ev.tpLoc, l.name)} />
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {tab === 'modes' ? (
          <div className="admin-panel__modes">
            {modes.map((m) => (
              <button
                key={m.id}
                className={'admin-panel__mode' + (m.active ? ' admin-panel__mode--active' : '')}
                onClick={() => send(ev.mode, m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AdminPanel;
