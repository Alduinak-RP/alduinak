import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';
import { copyText } from '../../utils/copyText';
import MasteryMenu, { MasteryData } from '../masteryMenu';
import ItemSpawner, { ItemResults } from './itemSpawner';
import FactionTab, { FactionMenuData } from './factionTab';
import Dropdown from './dropdown';
import Jobs, { AdminPos, JobRow } from './jobs';
import WeatherTab, { WeatherMenuData } from './weatherTab';
import { formatCountdown, isBlankOrNum, isNum, optionalNumber, pad2 } from './util';
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
  m?: PanelMastery; // online rows only, absent on older servers
  av?: PanelAttrs; // online rows only, absent on older servers
}

// Permanent max attribute change of one character (adminSystem.ts attrBonus)
interface PanelAttrs {
  health: number;
  magicka: number;
  stamina: number;
}

// One character's profession standing (masterySystem.ts MasterySummary).
interface PanelMastery {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
}

interface PanelLocation {
  name: string;
  kind?: string; // map marker type label, absent on older servers
  group?: string; // Teleport section id (LOC_GROUPS), absent on older servers
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

// One grantable pet base from the petBases packet (petSystem.ts baseList).
interface PetBase {
  desc: string;
  editorId: string;
  name?: string; // display name, absent on an older server
}

// Server identity from the debugInfo packet (adminMenuService.ts DebugServer).
interface DebugServer {
  name: string;
  offsetMs: number; // server clock minus client clock at receipt
  tzOffsetMin: number; // server-side Date.getTimezoneOffset()
}

// The crosshair target (adminMenuService.ts DebugTarget); ref and server ids arrive empty on another player's character unless staff.
interface DebugTarget {
  name: string;
  dist: number;
  live: boolean; // false once the crosshair left it while the menu stayed open
  player: boolean;
  refId: string;
  refDesc: string; // "hex:Plugin", empty for a ref created in game
  serverId: string; // empty for a client-only ref
  baseId: string;
  baseDesc: string;
  localBaseId: string; // the client's own base when it differs from baseId
  localBaseDesc: string;
  cell: string;
  cellName: string;
  pos: number[];
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
  target: DebugTarget | null;
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
  caps?: Partial<Record<AdminSub | 'kick' | 'ban' | 'factions', boolean>>; // server-resolved tier capabilities, absent on older servers
  tier?: string; // "senior" | "developer" | "gm", absent on older servers
  mastery?: PanelMastery | null; // the admin's own standing, absent on older servers
  npcPos?: AdminPos | null; // the admin's server-side location for the Add form or one end of the job form
  skills?: Omit<MasteryData, 'events'> | null; // the player's own masteryMenu payload
  items?: ItemResults | null; // the latest adminItems reply
  petBases?: Partial<Record<PetKind, PetBase[]>> | null; // the petBases reply, absent until it arrives
  faction?: FactionMenuData | null; // the factionMenu reply, absent until it arrives
  jobs?: JobRow[] | null; // the adminJobs reply, absent until it arrives
  weather?: WeatherMenuData | null; // the adminWeather reply, absent until it arrives
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

type TopTab = 'admin' | 'faction' | 'skills' | 'debug';
type AdminSub = 'players' | 'teleport' | 'modes' | 'npcs' | 'items' | 'weather';

// Admin shows only to confirmed staff; the other three are open to every player
const TOP_TABS: Array<{ id: TopTab; label: string }> = [
  { id: 'admin', label: 'Admin' },
  { id: 'faction', label: 'Faction' },
  { id: 'skills', label: 'Skills' },
  { id: 'debug', label: 'Debug' },
];

// Each sub-tab needs its server-sent cap; Item Spawner and Weather need it explicitly true
const ADMIN_SUBS: Array<{ id: AdminSub; label: string }> = [
  { id: 'players', label: 'Players' },
  { id: 'teleport', label: 'Teleport' },
  { id: 'modes', label: 'Modes' },
  { id: 'npcs', label: 'NPCs' },
  { id: 'items', label: 'Item Spawner' },
  { id: 'weather', label: 'Weather' },
];

// Teleport sections in display order; a missing or unknown group lands in Other
const LOC_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'cities', label: 'Cities' },
  { id: 'villages', label: 'Villages' },
  { id: 'forts', label: 'Forts' },
  { id: 'temples', label: 'Temples' },
  { id: 'other', label: 'Other' }
];

// The widget remounts on every open; the tabs and Teleport sections last opened this session survive it
let lastTop: TopTab | null = null;
let lastSub: AdminSub | null = null;
let openLocGroups: string[] = [];

const toggled = (list: string[], id: string): string[] => (list.indexOf(id) === -1 ? list.concat(id) : list.filter((x) => x !== id));

const tabButtons = <T extends string>(tabs: Array<{ id: T; label: string }>, active: T, pick: (id: T) => void) =>
  tabs.map((t) => (
    <button
      key={t.id}
      className={'admin-panel__tab' + (active === t.id ? ' admin-panel__tab--active' : '')}
      onClick={() => pick(t.id)}
    >
      {t.label}
    </button>
  ));

type NpcSub = 'list' | 'add' | 'pets' | 'jobs';

const NPC_SUBS: Array<{ id: NpcSub; label: string }> = [
  { id: 'list', label: 'Zones' },
  { id: 'add', label: 'Add' },
  { id: 'pets', label: 'Pets' },
  { id: 'jobs', label: 'Jobs' },
];

type PetKind = 'horse' | 'livestock' | 'dog';

const PET_KINDS: Array<{ id: PetKind; label: string }> = [
  { id: 'horse', label: 'Horse' },
  { id: 'livestock', label: 'Livestock' },
  { id: 'dog', label: 'Dog' },
];

// Same bound the server's cleanDisplayName applies to a pet name
const MAX_PET_NAME = 24;

type ZoneFilter = 'cooldown' | 'active' | 'none';

const ZONE_FILTERS: Array<{ id: ZoneFilter; label: string }> = [
  { id: 'cooldown', label: 'On cooldown' },
  { id: 'active', label: 'Active' },
  { id: 'none', label: 'None' },
];

// Field names follow NPC-Spawns.json; the server applies its own defaults to a blank Size, Spread, Despawn or Respawn.
const EMPTY_ZONE_FORM = { name: '', id: '', x: '', y: '', z: '', size: '2100', spread: '', npc: '', despawn: '120', respawn: '1800' };
type ZoneForm = typeof EMPTY_ZONE_FORM;

const ZONE_FIELDS: Array<{ key: keyof ZoneForm; label: string; placeholder: string }> = [
  { key: 'name', label: 'Name', placeholder: 'Kagrenzel Falmer' },
  { key: 'id', label: 'ID', placeholder: 'Kagrenzel01, Tamriel or 0x0001A26F' },
  { key: 'x', label: 'X', placeholder: '191763' },
  { key: 'y', label: 'Y', placeholder: '-29429' },
  { key: 'z', label: 'Z', placeholder: '8280' },
  { key: 'size', label: 'Size', placeholder: '2000' },
  { key: 'spread', label: 'Spread', placeholder: 'blank: anywhere in Size, 0: rings' },
  { key: 'despawn', label: 'Despawn (s)', placeholder: '120' },
  { key: 'respawn', label: 'Respawn (s)', placeholder: '1800' },
];

// Same bounds the server enforces for a mastery grant
const MAX_GRANT_HOURS = 1000;

const isGrantAmount = (text: string): boolean =>
  isNum(text) && Number.isInteger(Number(text)) && Number(text) !== 0 && Math.abs(Number(text)) <= MAX_GRANT_HOURS;

const ATTR_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'health', label: 'Health' },
  { key: 'magicka', label: 'Magicka' },
  { key: 'stamina', label: 'Stamina' },
];

// Same bounds the server enforces for a max attribute change
const MAX_ATTR_BONUS = 1000;

const isAttrAmount = (text: string): boolean =>
  isNum(text) && Number.isInteger(Number(text)) && Math.abs(Number(text)) <= MAX_ATTR_BONUS;

const attrForm = (av: PanelAttrs | null | undefined): Record<string, string> =>
  ({ health: String(av ? av.health : 0), magicka: String(av ? av.magicka : 0), stamina: String(av ? av.stamina : 0) });

const masteryText = (m: PanelMastery | null | undefined): string => {
  if (!m) return 'unknown';
  if (!m.profession) return 'No craft chosen' + (m.hours ? ' (' + m.hours + ' h banked)' : '');
  return m.label + ' \u00b7 ' + m.rankName + ' \u00b7 ' + m.hours + (m.hours === 1 ? ' hour' : ' hours');
};

const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
const WEEKDAYS = ['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas'];

const hexId = (id: string): string => (id ? '0x' + id.toUpperCase() : '-');

const withDesc = (id: string, desc: string): string => hexId(id) + (desc ? ' (' + desc + ')' : '');

// One line for bug reports; the descs paste straight into the Item Spawner search
const targetReport = (t: DebugTarget): string => {
  const parts = [t.name || '(no name)'];
  if (t.refId) parts.push('ref ' + withDesc(t.refId, t.refDesc));
  if (t.serverId && t.serverId !== t.refId) parts.push('server ' + hexId(t.serverId));
  if (t.baseId) parts.push('base ' + withDesc(t.baseId, t.baseDesc));
  if (t.localBaseId) parts.push('local base ' + withDesc(t.localBaseId, t.localBaseDesc));
  if (t.cell) parts.push('cell ' + hexId(t.cell) + (t.cellName ? ' ' + t.cellName : ''));
  parts.push('pos ' + (t.pos || []).join(' '));
  return parts.join(' | ');
};

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

// The fifteen read-out cells in display order, four to a row; the target report button closes the fourth row
const debugCells = (d: DebugData, now: number): DebugCell[] => {
  const server = d.server;
  const cell = d.cell;
  const t = d.target;
  const hidden = !!t && t.player && !t.refId;
  const inGame = (desc: string): string => desc || 'created in game';
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
      value: t ? (t.name || hexId(t.baseId)) + ' ' + Math.round(t.dist) + ' u' : 'no target',
      hint: t && !t.live ? 'Last seen' : 'Whatever you face, objects included',
    },
    { label: 'Magicka / Health / Stamina', value: [av.magicka, av.health, av.stamina].map(pair).join(' | ') },
    { label: 'Game Time/Date', value: gameClock(d.gameTime), sub: gameDate(d.gameTime) },
    { label: 'Local Time/Date', value: formatClock(now, new Date(now).getTimezoneOffset()) },
    { label: 'Server Time/Date', value: server ? formatClock(now + server.offsetMs, server.tzOffsetMin) : 'unknown' },
    { label: 'Target Ref ID', value: !t ? '-' : hidden ? 'Staff only' : hexId(t.refId), sub: t && !hidden ? inGame(t.refDesc) : undefined },
    { label: 'Target Server ID', value: !t ? '-' : hidden ? 'Staff only' : !t.serverId ? 'client only' : t.serverId === t.refId ? 'same as ref' : hexId(t.serverId) },
    {
      label: 'Target Base ID',
      value: t ? hexId(t.baseId) : '-',
      sub: t && t.baseId ? inGame(t.baseDesc) : undefined,
      hint: t && t.localBaseId ? 'Local ' + withDesc(t.localBaseId, t.localBaseDesc) : undefined,
    },
  ];
};

const AdminPanel = ({ data }: { data: AdminPanelData }) => {
  const [top, setTop] = useState<TopTab | null>(lastTop);
  const [sub, setSub] = useState<AdminSub | null>(lastSub);
  const [search, setSearch] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [locSearch, setLocSearch] = useState('');
  const [openGroups, setOpenGroups] = useState<string[]>(openLocGroups);
  // Sections collapsed during the current search; every section with a match starts expanded
  const [searchClosed, setSearchClosed] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [npcSub, setNpcSub] = useState<NpcSub>('list');
  const [zoneFilter, setZoneFilter] = useState<ZoneFilter>('none');
  const [zoneForm, setZoneForm] = useState<ZoneForm>(EMPTY_ZONE_FORM);
  const [grantHours, setGrantHours] = useState('1');
  const [attrs, setAttrs] = useState<Record<string, string>>(attrForm(null));
  const [factionRank, setFactionRank] = useState('');
  const [petKind, setPetKind] = useState<PetKind>('horse');
  const [petBase, setPetBase] = useState('');
  const [petName, setPetName] = useState('');
  const [now, setNow] = useState(Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);

  const ev = data.events || {};
  const caps: NonNullable<AdminPanelData['caps']> = data.caps || {};
  const subVisible = (id: AdminSub): boolean => (id === 'items' || id === 'weather' ? caps[id] === true : caps[id] !== false);
  const shownSubs = ADMIN_SUBS.filter((t) => subVisible(t.id));
  const adminVisible = !!data.admin && shownSubs.length > 0;
  const shownTops = TOP_TABS.filter((t) => t.id !== 'admin' || adminVisible);
  // A hidden or never picked tab falls back to Admin for staff and Skills for everyone else
  const topTab: TopTab = top && (top !== 'admin' || adminVisible) ? top : adminVisible ? 'admin' : 'skills';
  const subTab: AdminSub = sub && subVisible(sub) ? sub : shownSubs.length ? shownSubs[0].id : 'players';
  const view = topTab === 'admin' ? subTab : topTab;

  // The zone and weather countdowns and the debug clocks tick locally between server pushes
  const ticking = view === 'npcs' || view === 'debug' || view === 'weather';
  useEffect(() => {
    if (!ticking) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // The client refreshes Debug only while it is the visible tab
  useEffect(() => {
    if (ev.tab) send(ev.tab, topTab);
  }, [topTab, ev.tab]);

  // Get current pos: the server's answer overwrites ID and X/Y/Z, the other fields stay
  const npcPosAt = data.npcPos ? data.npcPos.at : 0;
  useEffect(() => {
    const p = data.npcPos;
    if (!p || p.end || !p.id || !p.pos || p.pos.length !== 3) return;
    setZoneForm((f) => ({ ...f, id: p.id, x: String(p.pos[0]), y: String(p.pos[1]), z: String(p.pos[2]) }));
  }, [npcPosAt]);

  const players = data.players || [];
  const locations = data.locations || [];
  const modes = data.modes || [];
  const npcZones = data.npcZones || [];
  const debug = data.debug || null;
  const skills = data.skills || null;
  // Seconds since the client gathered the debug block, added to each effect's elapsed time
  const debugDrift = debug ? Math.max(0, Math.round((now - (debug.updatedAt || now)) / 1000)) : 0;

  const report = debug && debug.target ? targetReport(debug.target) : '';
  const copyReport = (): void => {
    if (report) copyText(report).then((ok) => setCopied({ text: report, ok }));
  };
  const copyHint = !report
    ? 'Face something and press X, or press F6 and look around'
    : copied && copied.text === report
      ? copied.ok ? 'Copied' : 'Copy failed, select the ids instead'
      : 'Name, ids, cell and position';

  const refresh = (): void => {
    if (topTab === 'debug' && ev.debugRefresh) send(ev.debugRefresh);
    if (topTab === 'admin') {
      send(ev.refresh);
      setRefreshKey((k) => k + 1);
      if (view === 'npcs' && npcSub === 'jobs' && ev.jobList) send(ev.jobList);
      if (view === 'weather' && ev.weatherList) send(ev.weatherList);
    }
    if (topTab === 'skills' && ev.skills) send(ev.skills);
    if (topTab === 'faction' && ev.factionMenu) send(ev.factionMenu, data.faction ? data.faction.selected : '');
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
  // Hidden rather than greyed so a tier without kick or ban never sees a dead button; the server enforces it anyway
  const canKick = caps.kick !== false;
  const canBan = caps.ban !== false;

  const act = (key: string, ...args: unknown[]): void => {
    if (selectedPlayer && selectedPlayer.a) send(key, selectedPlayer.a, ...args);
  };

  useEffect(() => { setAttrs(attrForm(selectedPlayer ? selectedPlayer.av : null)); }, [selected]);

  // Mastery rows stay tied to the selected character.
  const masteryRows: Array<{ key: string; who: string; target: string; m: PanelMastery | null | undefined }> = [];
  if (actionsEnabled && selectedPlayer && selectedPlayer.a) masteryRows.push({ key: 'sel', who: selectedPlayer.n || '(no name)', target: selectedPlayer.a, m: selectedPlayer.m });
  const canGrant = !!ev.masteryGrant && isGrantAmount(grantHours);
  // Filled from the selected row, so the fields show what the character carries now
  const canSetAttrs = !!ev.attrSet && actionsEnabled && ATTR_FIELDS.every((f) => isAttrAmount(attrs[f.key]));
  const factionDetail = data.faction?.detail || null;
  const factionRankOptions = factionDetail?.ranks || [];
  const pickedFactionRank = factionRankOptions.some((r) => r.slug === factionRank) ? factionRank : factionRankOptions[factionRankOptions.length - 1]?.slug || '';

  const locFilter = locSearch.trim().toLowerCase();
  const shownLocations = locations.filter((l) => !locFilter || (l.name + ' ' + (l.kind || '')).toLowerCase().indexOf(locFilter) !== -1);
  const groupOf = (l: PanelLocation): string => (l.group && LOC_GROUPS.some((g) => g.id === l.group) ? l.group : 'other');
  const locSections = LOC_GROUPS.map((g) => ({ ...g, rows: shownLocations.filter((l) => groupOf(l) === g.id) })).filter((g) => g.rows.length > 0);
  const groupOpen = (id: string): boolean => (locFilter ? searchClosed.indexOf(id) === -1 : openGroups.indexOf(id) !== -1);

  const toggleGroup = (id: string): void => {
    if (locFilter) {
      setSearchClosed(toggled(searchClosed, id));
      return;
    }
    openLocGroups = toggled(openGroups, id);
    setOpenGroups(openLocGroups);
  };

  const openTop = (id: TopTab): void => {
    lastTop = id;
    setTop(id);
    if (id === 'skills' && ev.skills) send(ev.skills);
    if (id === 'faction' && ev.factionMenu) send(ev.factionMenu, data.faction ? data.faction.selected : '');
    if (id === 'admin' && subTab === 'npcs' && ev.npcList) send(ev.npcList);
    if (id === 'admin' && subTab === 'weather' && ev.weatherList) send(ev.weatherList);
  };

  const openSub = (id: AdminSub): void => {
    lastSub = id;
    setSub(id);
    if (id === 'npcs' && ev.npcList) send(ev.npcList);
    if (id === 'weather' && ev.weatherList) send(ev.weatherList);
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

  // On cooldown: any slot still waiting to respawn, "No respawn" included
  const shownZones = npcZones.filter((z) => zoneFilter === 'none' || (zoneFilter === 'active' ? z.active : zoneLeft(z) !== 0));

  const setField = (key: keyof ZoneForm, value: string): void => setZoneForm({ ...zoneForm, [key]: value });

  const canAddZone = !!(zoneForm.name.trim() && zoneForm.id.trim() && zoneForm.npc.trim())
    && isNum(zoneForm.x) && isNum(zoneForm.y) && isNum(zoneForm.z)
    && isBlankOrNum(zoneForm.size) && isBlankOrNum(zoneForm.spread) && isBlankOrNum(zoneForm.despawn) && isBlankOrNum(zoneForm.respawn);

  const addZone = (): void => {
    if (!canAddZone) return;
    send(ev.npcAdd, JSON.stringify({
      Name: zoneForm.name.trim(),
      ID: zoneForm.id.trim(),
      POS: { x: Number(zoneForm.x), y: Number(zoneForm.y), z: Number(zoneForm.z) },
      Size: optionalNumber(zoneForm.size),
      Spread: optionalNumber(zoneForm.spread),
      NPC: zoneForm.npc.split('\n').map((s) => s.trim()).filter(Boolean),
      Despawn: optionalNumber(zoneForm.despawn),
      Respawn: optionalNumber(zoneForm.respawn),
    }));
    // The server toast reports success or the reason; the list refreshes on the npcZones push
    setZoneForm(EMPTY_ZONE_FORM);
    setNpcSub('list');
  };

  // The bases arrive with the panel; the Pets sub-tab asks again only when they never came
  const openNpcSub = (id: NpcSub): void => {
    setNpcSub(id);
    if (id === 'pets' && !data.petBases && ev.petBases) send(ev.petBases);
    if (id === 'jobs' && ev.jobList) send(ev.jobList);
  };

  const petBaseList: PetBase[] = (data.petBases && data.petBases[petKind]) || [];
  // The picked base follows the kind: an unknown pick falls back to the first base
  const petPick = petBaseList.some((b) => b.desc === petBase) ? petBase : petBaseList.length ? petBaseList[0].desc : '';

  const grantPet = (): void => {
    if (!petPick) return;
    send(ev.petGrant, JSON.stringify({ kind: petKind, base: petPick, name: petName.trim() }));
    setPetName('');
  };

  return (
    <div className="admin-panel">
      <div className="admin-panel__window">
        <div className="admin-panel__header">
          <span className="admin-panel__title">
            Personal Menu
            {data.admin && data.tier ? <span style={{ fontSize: 14, opacity: 0.7, marginLeft: 6 }}>({data.tier})</span> : null}
          </span>
          <div className="admin-panel__header-buttons">
            <Button text="Refresh" width={104} height={32} onClick={refresh} />
            <Button text="Close" width={104} height={32} onClick={() => send(ev.close)} />
          </div>
        </div>

        <div className="admin-panel__tabs">{tabButtons(shownTops, topTab, openTop)}</div>

        {topTab === 'admin' ? (
          <div className="admin-panel__tabs admin-panel__tabs--sub">{tabButtons(shownSubs, subTab, openSub)}</div>
        ) : null}

        {view === 'faction' ? (
          <div className="admin-panel__body">
            <FactionTab data={data.faction || null} ev={ev} send={send} />
          </div>
        ) : null}

        {view === 'skills' ? (
          <div className="admin-panel__body">
            {skills && skills.professions && skills.professions.length ? (
              <MasteryMenu embedded data={{ ...skills, events: { choose: ev.skillChoose, close: ev.close } }} />
            ) : (
              <div className="admin-panel__empty">Loading skills</div>
            )}
          </div>
        ) : null}

        {view === 'debug' ? (
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
                <div className="admin-panel__field">
                  Target Report
                  <Button text="Copy IDs" width={104} height={32} disabled={!report} onClick={copyReport} />
                  <span className="admin-panel__hint">{copyHint}</span>
                </div>
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

        {view === 'players' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__actions">
              <Button text="TP to" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.tp)} />
              <Button text="Summon" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.summon)} />
              {canKick ? <Button text="Kick" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.kick)} /> : null}
              {canBan ? <Button text="Ban" width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.ban)} /> : null}
            </div>
            {ev.masteryGrant && selectedPlayer ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">Mastery hours</span>
                  <input
                    className="admin-panel__input admin-panel__mastery-amount"
                    value={grantHours}
                    onChange={(e) => setGrantHours(e.target.value)}
                  />
                  <span className="admin-panel__hint">Whole hours to grant; negative takes them back, rank and recipes follow</span>
                </div>
                {masteryRows.length === 0 ? (
                  <span className="admin-panel__hint">Select an online player to grant mastery hours</span>
                ) : (
                  masteryRows.map((r) => (
                    <div key={r.key} className="admin-panel__mastery-row">
                      <span className="admin-panel__mastery-who" title={r.who}>{r.who}</span>
                      <span className="admin-panel__mastery-info" title={masteryText(r.m)}>{masteryText(r.m)}</span>
                      <Button text="Grant" width={96} height={30} disabled={!canGrant} onClick={() => send(ev.masteryGrant, r.target, Number(grantHours))} />
                      <Button text="Reset craft" width={116} height={30} disabled={!(r.m && r.m.profession)} onClick={() => send(ev.masteryReset, r.target)} />
                    </div>
                  ))
                )}
              </div>
            ) : null}
            {ev.attrSet && selectedPlayer ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">Max attributes</span>
                  {ATTR_FIELDS.map((f) => (
                    <input
                      key={f.key}
                      className="admin-panel__input admin-panel__mastery-amount"
                      placeholder={f.label}
                      title={f.label}
                      value={attrs[f.key]}
                      onChange={(e) => setAttrs({ ...attrs, [f.key]: e.target.value })}
                    />
                  ))}
                  <Button
                    text="Apply"
                    width={96}
                    height={30}
                    disabled={!canSetAttrs}
                    onClick={() => act(ev.attrSet, Number(attrs.health), Number(attrs.magicka), Number(attrs.stamina))}
                  />
                </div>
                <span className="admin-panel__hint">
                  {actionsEnabled
                    ? 'Health, magicka and stamina, permanent and kept through relogs; 0 leaves the character on its base values'
                    : 'Select an online player to change their max attributes'}
                </span>
              </div>
            ) : null}
            {selectedPlayer && caps.factions !== false ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">Faction</span>
                  <Dropdown
                    className="admin-panel__faction-pick"
                    value={factionDetail?.id || ''}
                    placeholder={data.faction?.factions?.length ? 'Choose a faction' : 'Loading factions'}
                    disabled={!data.faction?.factions?.length}
                    options={(data.faction?.factions || []).map((f) => ({ value: f.id, label: f.name }))}
                    onChange={(id) => ev.factionMenu && send(ev.factionMenu, id)}
                  />
                  <Dropdown
                    className="admin-panel__faction-pick"
                    value={pickedFactionRank}
                    disabled={!factionDetail}
                    options={factionRankOptions.map((r) => ({ value: r.slug, label: r.name }))}
                    onChange={setFactionRank}
                  />
                  <Button
                    text="Add"
                    width={72}
                    height={30}
                    disabled={!actionsEnabled || !factionDetail || !pickedFactionRank}
                    onClick={() => selectedPlayer.a && send(ev.faction, JSON.stringify({ action: 'adminAdd', factionId: factionDetail?.id, rank: pickedFactionRank, target: parseInt(selectedPlayer.a, 16) }))}
                  />
                  <Button
                    text="Remove"
                    width={88}
                    height={30}
                    disabled={!actionsEnabled || !factionDetail}
                    onClick={() => selectedPlayer.a && send(ev.faction, JSON.stringify({ action: 'adminRemove', factionId: factionDetail?.id, target: parseInt(selectedPlayer.a, 16) }))}
                  />
                </div>
                <span className="admin-panel__hint">Choose a faction and role, then add or remove the selected online character.</span>
              </div>
            ) : null}
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

        {view === 'teleport' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__filters">
              <input
                className="admin-panel__search"
                placeholder="Search locations"
                value={locSearch}
                onChange={(e) => {
                  setLocSearch(e.target.value);
                  setSearchClosed([]);
                }}
              />
            </div>
            <div className="admin-panel__list">
              {locSections.length === 0 ? (
                <div className="admin-panel__empty">{locations.length === 0 ? 'No locations configured' : 'No locations match the search'}</div>
              ) : (
                locSections.map((g) => (
                  <React.Fragment key={g.id}>
                    <div className="admin-panel__row admin-panel__row--head admin-panel__row--clickable" onClick={() => toggleGroup(g.id)}>
                      <span className="admin-panel__cell admin-panel__cell--name">
                        {(groupOpen(g.id) ? '▾ ' : '▸ ') + g.label + ' (' + g.rows.length + ')'}
                      </span>
                    </div>
                    {groupOpen(g.id)
                      ? g.rows.map((l) => (
                        <div key={l.name} className="admin-panel__row admin-panel__row--location">
                          <span className="admin-panel__cell admin-panel__cell--name">{l.name}</span>
                          {l.kind ? <span className="admin-panel__cell admin-panel__cell--kind">{l.kind}</span> : null}
                          <Button text="Teleport" width={112} height={30} onClick={() => send(ev.tpLoc, l.name)} />
                        </div>
                      ))
                      : null}
                  </React.Fragment>
                ))
              )}
            </div>
          </div>
        ) : null}

        {view === 'modes' ? (
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

        {view === 'items' ? (
          <ItemSpawner
            items={data.items || null}
            ev={ev}
            send={send}
            selfActorId={debug ? debug.actorId : ''}
            selected={actionsEnabled && selectedPlayer && selectedPlayer.a ? { a: selectedPlayer.a, n: selectedPlayer.n } : null}
            refreshKey={refreshKey}
          />
        ) : null}

        {view === 'weather' ? <WeatherTab data={data.weather || null} now={now} ev={ev} send={send} /> : null}


        {view === 'npcs' ? (
          <div className="admin-panel__body">
            <div className="admin-panel__tabs admin-panel__tabs--sub">
              {NPC_SUBS.filter((t) => t.id !== 'jobs' || !!ev.jobList).map((t) => (
                <button
                  key={t.id}
                  className={'admin-panel__tab' + (npcSub === t.id ? ' admin-panel__tab--active' : '')}
                  onClick={() => openNpcSub(t.id)}
                >
                  {t.label}
                </button>
              ))}
              {npcSub === 'list' ? (
                <div className="admin-panel__filters admin-panel__filters--end">
                  {ZONE_FILTERS.map((f) => (
                    <label key={f.id} className="admin-panel__checkbox">
                      <input type="radio" name="npc-zone-filter" checked={zoneFilter === f.id} onChange={() => setZoneFilter(f.id)} />
                      {f.label}
                    </label>
                  ))}
                </div>
              ) : null}
            </div>

            {npcSub === 'list' ? (
              <div className="admin-panel__list">
                {shownZones.length === 0 ? (
                  <div className="admin-panel__empty">{npcZones.length === 0 ? 'No zones configured' : 'No zones match the filter'}</div>
                ) : (
                  shownZones.map((z) => (
                    <div key={z.name} className="admin-panel__row admin-panel__row--zone">
                      <div className="admin-panel__zone-info">
                        <span className="admin-panel__cell admin-panel__cell--name">{z.name}</span>
                        <span className="admin-panel__cell admin-panel__cell--status">
                          <span className={'admin-panel__dot' + (z.active ? ' admin-panel__dot--online' : '')} />
                          {zoneStatus(z)}
                        </span>
                      </div>
                      <div className="admin-panel__zone-buttons">
                        <Button text="TP" width={48} height={24} onClick={() => send(ev.npcTp, z.name)} />
                        {ev.npcActivate ? <Button text="Activate" width={84} height={24} onClick={() => send(ev.npcActivate, z.name)} /> : null}
                        {ev.npcDeactivate ? <Button text="Deactivate" width={100} height={24} onClick={() => send(ev.npcDeactivate, z.name)} /> : null}
                        <Button text="Reset" width={64} height={24} onClick={() => send(ev.npcReset, z.name)} />
                        <Button text="Delete" width={68} height={24} onClick={() => send(ev.npcDelete, z.name)} />
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : npcSub === 'jobs' ? (
              <Jobs jobs={data.jobs || null} pos={data.npcPos || null} ev={ev} send={send} />
            ) : npcSub === 'pets' ? (
              <div className="admin-panel__body">
                <div className="admin-panel__form">
                  <div className="admin-panel__field admin-panel__field--half">
                    Kind
                    <div className="admin-panel__filters">
                      {PET_KINDS.map((k) => (
                        <label key={k.id} className="admin-panel__checkbox">
                          <input type="radio" name="pet-kind" checked={petKind === k.id} onChange={() => setPetKind(k.id)} />
                          {k.label}
                        </label>
                      ))}
                    </div>
                  </div>
                  <div className="admin-panel__field admin-panel__field--half">
                    Base
                    <div className="admin-panel__filters admin-panel__filters--grid">
                      {petBaseList.length === 0 ? (
                        <span className="admin-panel__hint">{data.petBases ? 'No bases configured' : 'Loading...'}</span>
                      ) : petBaseList.map((b) => (
                        <label key={b.desc} className="admin-panel__checkbox" title={b.editorId}>
                          <input type="radio" name="pet-base" checked={petPick === b.desc} onChange={() => setPetBase(b.desc)} />
                          <span className="admin-panel__cell">{b.name || b.editorId}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="admin-panel__field admin-panel__field--half">
                    Name (optional)
                    <input
                      className="admin-panel__input"
                      placeholder="blank: the species name"
                      maxLength={MAX_PET_NAME}
                      value={petName}
                      onChange={(e) => setPetName(e.target.value)}
                    />
                  </label>
                </div>
                <div className="admin-panel__actions">
                  <Button text="Add to my pets" width={168} height={32} disabled={!petPick} onClick={grantPet} />
                </div>
                <span className="admin-panel__hint">Stored for your own character; bring it out with the Pets option at a stable, farm or home door.</span>
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
                  {ev.npcPos ? <Button text="Get current pos" width={168} height={32} onClick={() => send(ev.npcPos)} /> : null}
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
