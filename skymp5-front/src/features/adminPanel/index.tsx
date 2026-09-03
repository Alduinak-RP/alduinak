import React, { useEffect, useState } from 'react';

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

// One NPC spawn zone as summarised by the server (npcSpawnSystem.ts ZoneSummary).
interface PanelNpcZone {
  name: string;
  active: boolean; // NPCs currently placed
  alive: number;
  total: number;
  inside: number; // players inside the zone
  readyInSec: number; // seconds until every slot may spawn, 0 = ready, -1 = never until reset
}

// Server identity from the debugInfo packet (adminMenuService.ts DebugServer).
interface DebugServer {
  name: string;
  offsetMs: number; // server clock minus client clock at receipt
  tzOffsetMin: number; // server-side Date.getTimezoneOffset()
}

// Read-outs the client gathers every 5 s while the panel is open (adminMenuService.ts DebugData).
interface DebugData {
  account: string;
  character: string;
  formId: string; // server-side actor id hex
  actorId: string;
  profileId: number;
  server: DebugServer | null;
  pos: number[];
  cell: { id: string; name: string; interior: boolean; world: string; location: string } | null;
  heading: { deg: number; compass: string };
  target: { name: string; id: string; dist: number } | null;
  av: { health: number[]; magicka: number[]; stamina: number[] }; // [cur, max]
  gameTime: { hour: number; day: number; month: number; year: number; weekday: number } | null; // month 0-based
  hoursOffset: number;
  localTime: number;
  effects: Array<{ id: string; name: string; elapsedSec: number }>;
  updatedAt: number;
}

// The widget object the client pushes through window.skyrimPlatform.widgets.
export interface AdminPanelData {
  players: PanelPlayer[];
  locations: PanelLocation[];
  modes: PanelMode[];
  events: Record<string, string>;
  admin?: boolean; // true once the server answered adminMenuRequest
  debug?: DebugData | null;
  npcZones?: PanelNpcZone[]; // absent on older clients
  npcZonesAt?: number; // Date.now() when npcZones arrived, the countdown base
  caps?: { ban?: boolean }; // server-resolved tier capabilities, absent on older servers
  tier?: string; // "senior" | "developer" | "gm", absent on older servers
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

type Tab = 'debug' | 'players' | 'teleport' | 'modes' | 'npcs';

// Debug is open to every player; the rest render only while data.admin is true
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'debug', label: 'Debug' },
  { id: 'players', label: 'Players' },
  { id: 'teleport', label: 'Teleport' },
  { id: 'modes', label: 'Modes' },
  { id: 'npcs', label: 'NPCs' },
];

type NpcSub = 'list' | 'add';

const NPC_SUBS: Array<{ id: NpcSub; label: string }> = [
  { id: 'list', label: 'Zones' },
  { id: 'add', label: 'Add' },
];

// Field names follow NPC-Spawns.json; the server applies its own defaults to a blank Size, Despawn or Respawn.
const EMPTY_ZONE_FORM = { name: '', id: '', x: '', y: '', z: '', size: '2000', npc: '', despawn: '120', respawn: '1800' };
type ZoneForm = typeof EMPTY_ZONE_FORM;

const ZONE_FIELDS: Array<{ key: keyof ZoneForm; label: string; placeholder: string }> = [
  { key: 'name', label: 'Name', placeholder: 'Kagrenzel Falmer' },
  { key: 'id', label: 'ID', placeholder: 'Kagrenzel01, Tamriel or 0x0001A26F' },
  { key: 'x', label: 'X', placeholder: '191763' },
  { key: 'y', label: 'Y', placeholder: '-29429' },
  { key: 'z', label: 'Z', placeholder: '8280' },
  { key: 'size', label: 'Size', placeholder: '2000' },
  { key: 'despawn', label: 'Despawn (s)', placeholder: '120' },
  { key: 'respawn', label: 'Respawn (s)', placeholder: '1800' },
];

const isNum = (text: string): boolean => text.trim() !== '' && Number.isFinite(Number(text));

const isBlankOrNum = (text: string): boolean => text.trim() === '' || isNum(text);

const optionalNumber = (text: string): number | undefined => (text.trim() === '' ? undefined : Number(text));

const pad2 = (n: number): string => (n < 10 ? '0' : '') + n;

// m:ss, or h:mm:ss past an hour
const formatCountdown = (totalSec: number): string => {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
};

const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
const WEEKDAYS = ['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas'];

const hexId = (id: string): string => (id ? '0x' + id.toUpperCase() : '-');

const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return n + 'th';
  const ones = n % 10;
  return n + (ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th');
};

// MM/DD/YY HH:MM; the epoch is shifted by the zone offset first so any zone reads out of the UTC fields
const formatClock = (ms: number, tzOffsetMin: number): string => {
  const d = new Date(ms - tzOffsetMin * 60000);
  return pad2(d.getUTCMonth() + 1) + '/' + pad2(d.getUTCDate()) + '/' + pad2(d.getUTCFullYear() % 100)
    + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes());
};

const gameClock = (gt: DebugData['gameTime']): string => {
  if (!gt) return 'unknown';
  const h = Math.floor(gt.hour);
  return pad2(h) + ':' + pad2(Math.floor((gt.hour - h) * 60));
};

const gameDate = (gt: DebugData['gameTime']): string | undefined => {
  if (!gt) return undefined;
  const month = MONTHS[Math.round(gt.month)] || '?';
  const weekday = WEEKDAYS[Math.round(gt.weekday)] || '?';
  return weekday + ', ' + ordinal(Math.round(gt.day)) + ' of ' + month + ', 4E ' + Math.round(gt.year);
};

interface DebugCell {
  label: string;
  value: string;
  sub?: string; // second value line
  hint?: string;
}

// The twelve read-out cells in display order, three rows of four
const debugCells = (d: DebugData, now: number): DebugCell[] => {
  const server = d.server;
  const cell = d.cell;
  const place = cell ? [cell.name || cell.location, !cell.interior && cell.world ? '(' + cell.world + ')' : ''].filter(Boolean).join(' ') : '';
  const av = d.av || { health: [], magicka: [], stamina: [] };
  const pair = (v: number[]): string => (v && v.length ? Math.round(v[0]) + '/' + Math.round(v[1] || 0) : '-');
  return [
    { label: 'Account Name', value: d.account || '-' },
    { label: 'Character Name', value: d.character || '-' },
    { label: 'FormID', value: hexId(d.formId || d.actorId) },
    { label: 'Server Name', value: server ? server.name || '-' : 'unknown' },
    { label: 'Character POS (X Y Z)', value: (d.pos || []).map((n) => Math.round(n)).join(' ') || '-' },
    { label: 'LocationID (Cell ID)', value: cell ? hexId(cell.id) : 'unknown', sub: place || undefined },
    { label: 'Direction Facing', value: d.heading ? d.heading.compass + ' ' + Math.round(d.heading.deg) + '°' : '-' },
    {
      label: 'Target Distance',
      value: d.target ? (d.target.name || hexId(d.target.id)) + ' ' + Math.round(d.target.dist) + ' u' : 'no target',
      hint: 'Activatable references only',
    },
    { label: 'Magicka / Health / Stamina', value: [av.magicka, av.health, av.stamina].map(pair).join(' | ') },
    { label: 'Game Time/Date', value: gameClock(d.gameTime), sub: gameDate(d.gameTime) },
    { label: 'Local Time/Date', value: formatClock(now, new Date(now).getTimezoneOffset()) },
    { label: 'Server Time/Date', value: server ? formatClock(now + server.offsetMs, server.tzOffsetMin) : 'unknown' },
  ];
};

const AdminPanel = ({ data }: { data: AdminPanelData }) => {
  const [tab, setTab] = useState<Tab>('debug');
  const [search, setSearch] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [locSearch, setLocSearch] = useState('');
  const [selected, setSelected] = useState<number | null>(null);
  const [npcSub, setNpcSub] = useState<NpcSub>('list');
  const [zoneForm, setZoneForm] = useState<ZoneForm>(EMPTY_ZONE_FORM);
  const [now, setNow] = useState(Date.now());

  // The zone countdown and the debug clocks tick locally between server pushes
  useEffect(() => {
    if (tab !== 'npcs' && tab !== 'debug') return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [tab]);

  // A demoted or not yet confirmed admin never stays on a hidden tab
  useEffect(() => {
    if (!data.admin && tab !== 'debug') setTab('debug');
  }, [data.admin, tab]);

  const ev = data.events || {};
  const players = data.players || [];
  const locations = data.locations || [];
  const modes = data.modes || [];
  const npcZones = data.npcZones || [];
  const debug = data.debug || null;
  const shownTabs = data.admin ? TABS : TABS.filter((t) => t.id === 'debug');
  // Seconds since the client gathered the debug block, added to each effect's elapsed time
  const debugDrift = debug ? Math.max(0, Math.round((now - (debug.updatedAt || now)) / 1000)) : 0;

  const refresh = (): void => {
    if (ev.debugRefresh) send(ev.debugRefresh);
    if (data.admin) send(ev.refresh);
  };

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
  // Hidden rather than greyed so a tier without ban never sees a dead button; the server enforces it anyway
  const canBan = !data.caps || data.caps.ban !== false;

  const act = (key: string): void => {
    if (selectedPlayer && selectedPlayer.a) send(key, selectedPlayer.a);
  };

  const locFilter = locSearch.trim().toLowerCase();
  const shownLocations = locations.filter((l) => !locFilter || l.name.toLowerCase().indexOf(locFilter) !== -1);

  const openTab = (id: Tab): void => {
    setTab(id);
    if (id === 'npcs' && ev.npcList) send(ev.npcList);
  };

  // Seconds left until the zone can fully respawn, -1 when it never will without a reset
  const zoneLeft = (z: PanelNpcZone): number => {
    if (z.readyInSec < 0) return -1;
    const elapsed = Math.round((now - (data.npcZonesAt || now)) / 1000);
    return Math.max(0, z.readyInSec - elapsed);
  };

  const zoneStatus = (z: PanelNpcZone): string => {
    const left = zoneLeft(z);
    const ready = left === 0 ? 'Ready' : left < 0 ? 'No respawn' : 'Ready in ' + formatCountdown(left);
    if (!z.active) return ready;
    const alive = z.alive + '/' + z.total + ' alive';
    return left === 0 ? alive : alive + ', ' + ready.toLowerCase();
  };

  const setField = (key: keyof ZoneForm, value: string): void => setZoneForm({ ...zoneForm, [key]: value });

  const canAddZone = !!(zoneForm.name.trim() && zoneForm.id.trim() && zoneForm.npc.trim())
    && isNum(zoneForm.x) && isNum(zoneForm.y) && isNum(zoneForm.z)
    && isBlankOrNum(zoneForm.size) && isBlankOrNum(zoneForm.despawn) && isBlankOrNum(zoneForm.respawn);

  const addZone = (): void => {
    if (!canAddZone) return;
    send(ev.npcAdd, JSON.stringify({
      Name: zoneForm.name.trim(),
      ID: zoneForm.id.trim(),
      POS: { x: Number(zoneForm.x), y: Number(zoneForm.y), z: Number(zoneForm.z) },
      Size: optionalNumber(zoneForm.size),
      NPC: zoneForm.npc.split('\n').map((s) => s.trim()).filter(Boolean),
      Despawn: optionalNumber(zoneForm.despawn),
      Respawn: optionalNumber(zoneForm.respawn),
    }));
    // The server toast reports success or the reason; the list refreshes on the npcZones push
    setZoneForm(EMPTY_ZONE_FORM);
    setNpcSub('list');
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel__window">
        <div className="admin-panel__header">
          <span className="admin-panel__title">
            {data.admin ? 'Admin Panel' : 'Debug'}
            {data.admin && data.tier ? <span style={{ fontSize: 14, opacity: 0.7, marginLeft: 6 }}>({data.tier})</span> : null}
          </span>
          <div className="admin-panel__header-buttons">
            <Button text="Refresh" width={104} height={32} onClick={refresh} />
            <Button text="Close" width={104} height={32} onClick={() => send(ev.close)} />
          </div>
        </div>

        <div className="admin-panel__tabs">
          {shownTabs.map((t) => (
            <button
              key={t.id}
              className={'admin-panel__tab' + (tab === t.id ? ' admin-panel__tab--active' : '')}
              onClick={() => openTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'debug' ? (
          <div className="admin-panel__body">
            {debug ? (
              <div className="admin-panel__form admin-panel__form--debug">
                {debugCells(debug, now).map((c) => (
                  <div key={c.label} className="admin-panel__field">
                    {c.label}
                    <span className="admin-panel__value" title={c.value}>{c.value}</span>
                    {c.sub ? <span className="admin-panel__value admin-panel__value--sub" title={c.sub}>{c.sub}</span> : null}
                    {c.hint ? <span className="admin-panel__hint">{c.hint}</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <div className="admin-panel__empty">Waiting for game data</div>
            )}
            <div className="admin-panel__row admin-panel__row--head">
              <span className="admin-panel__cell admin-panel__cell--name">Active effects</span>
              <span className="admin-panel__cell admin-panel__cell--form">Form ID</span>
              <span className="admin-panel__cell admin-panel__cell--elapsed">Elapsed</span>
            </div>
            <div className="admin-panel__list admin-panel__list--effects">
              {!debug || debug.effects.length === 0 ? (
                <div className="admin-panel__empty">No active effects</div>
              ) : (
                debug.effects.map((fx) => (
                  <div key={fx.id} className="admin-panel__row">
                    <span className="admin-panel__cell admin-panel__cell--name">{fx.name || '-'}</span>
                    <span className="admin-panel__cell admin-panel__cell--form">{hexId(fx.id)}</span>
                    <span className="admin-panel__cell admin-panel__cell--elapsed">{formatCountdown(fx.elapsedSec + debugDrift)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {tab === 'players' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__actions">
              <Button text="TP to" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.tp)} />
              <Button text="Summon" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.summon)} />
              <Button text="Kick" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.kick)} />
              {canBan ? <Button text="Ban" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.ban)} /> : null}
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

        {tab === 'npcs' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__tabs admin-panel__tabs--sub">
              {NPC_SUBS.map((t) => (
                <button
                  key={t.id}
                  className={'admin-panel__tab' + (npcSub === t.id ? ' admin-panel__tab--active' : '')}
                  onClick={() => setNpcSub(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {npcSub === 'list' ? (
              <div className="admin-panel__list">
                {npcZones.length === 0 ? (
                  <div className="admin-panel__empty">No zones configured</div>
                ) : (
                  npcZones.map((z) => (
                    <div key={z.name} className="admin-panel__row admin-panel__row--zone">
                      <div className="admin-panel__zone-info">
                        <span className="admin-panel__cell admin-panel__cell--name">{z.name}</span>
                        <span className="admin-panel__cell admin-panel__cell--status">
                          <span className={'admin-panel__dot' + (z.active ? ' admin-panel__dot--online' : '')} />
                          {zoneStatus(z)}
                        </span>
                      </div>
                      <div className="admin-panel__zone-buttons">
                        <Button text="TP" width={72} height={30} onClick={() => send(ev.npcTp, z.name)} />
                        <Button text="Reset" width={84} height={30} onClick={() => send(ev.npcReset, z.name)} />
                        <Button text="Delete" width={92} height={30} onClick={() => send(ev.npcDelete, z.name)} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <div className="admin-panel__body">
                <div className="admin-panel__form">
                  {ZONE_FIELDS.map((f) => (
                    <label key={f.key} className={'admin-panel__field' + (f.key === 'name' || f.key === 'id' ? ' admin-panel__field--half' : '')}>
                      {f.label}
                      <input
                        className="admin-panel__input"
                        placeholder={f.placeholder}
                        value={zoneForm[f.key]}
                        onChange={(e) => setField(f.key, e.target.value)}
                      />
                    </label>
                  ))}
                  <label className="admin-panel__field admin-panel__field--wide">
                    NPC entries, one per line: base id and count
                    <textarea
                      className="admin-panel__textarea"
                      placeholder={'00023A99 4\n23a99:Skyrim.esm 2'}
                      value={zoneForm.npc}
                      onChange={(e) => setField('npc', e.target.value)}
                    />
                  </label>
                </div>
                <div className="admin-panel__actions">
                  <Button text="Add" width={104} height={32} disabled={!canAddZone} onClick={addZone} />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AdminPanel;
