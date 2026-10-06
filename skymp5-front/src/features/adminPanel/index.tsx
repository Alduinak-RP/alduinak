import React, { useEffect, useState } from 'react';

import Button from '../../constructorComponents/button';
import { copyText } from '../../utils/copyText';
import MasteryMenu, { MasteryData, MasterySlot, slotName } from '../masteryMenu';
import ItemSpawner, { ItemResults } from './itemSpawner';
import FactionTab, { FactionMenuData } from './factionTab';
import FactionAssign from './factionAssign';
import Dropdown from './dropdown';
import Jobs, { AdminPos, JobRow } from './jobs';
import WeatherTab, { WeatherMenuData } from './weatherTab';
import PolymorphTab, { RaceMenuData } from './polymorphTab';
import { diseaseStageName } from '../survivalReadout';
import { formatCountdown, formatTimeLeft, isBlankOrNum, isNum, optionalNumber, pad2 } from './util';
import { loc } from '../../loc';
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
  sv?: PanelSurvival; // online rows once survival settled on the character, absent with survival off
  f?: PanelFallen[]; // the profile's fallen characters, absent when none or on older servers
  ok?: boolean; // a revive is allowed: the profile's living characters are below the limit
}

// One character in Sovngarde, the Soul Cairn or perma-dead (adminSystem.ts fallenRows)
interface PanelFallen {
  a: string; // actor id hex
  n: string;
  s: number | null; // character slot
  r: string; // realm label or perma-dead
}

// Permanent max attribute change of one character (adminSystem.ts attrBonus)
interface PanelAttrs {
  health: number;
  magicka: number;
  stamina: number;
}

// One character's survival state (survivalSystem.ts SurvivalSummary); epochs in server ms
interface PanelSurvival {
  cold: number; // -1 with cold off
  stage: string; // cold stage name, '' with cold off
  area: string; // '' until the first cold step
  level: number;
  warmth: number;
  freezingArea: boolean;
  diseases: Array<{ id: string; name: string; stage: number; nextAt: number }>; // nextAt 0 at the last stage
  afflictions: Array<{ name: string; until: number }>;
  foodPoisonUntil: number;
}

// What the survival row may give (survivalSystem.ts SurvivalCatalog)
interface SurvivalCatalog {
  diseases: Array<{ id: string; name: string; contagious: boolean }>;
  coldMax: number;
  coldStages: number[];
}

// One character's profession standing (masterySystem.ts MasterySummary).
interface PanelMastery {
  profession: string | null;
  label: string;
  rank: number;
  rankName: string;
  hours: number;
  slots?: MasterySlot[]; // every configured craft slot, primary first; absent on older servers
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
  type?: string; // Wildlife, Monster or Dungeon; absent from older servers
  entry?: PanelZoneEntry; // what Edit fills the Add form with; absent from older servers
}

// One NPC-Spawns.json entry (npcSpawnSystem.ts ZoneEntry).
interface PanelZoneEntry {
  Name: string;
  Type?: string;
  ID: string;
  POS: { x: number; y: number; z: number };
  Size?: number;
  Spread?: number;
  NPC: string[];
  Despawn?: number;
  Respawn?: number;
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

// The crosshair target (adminMenuService.ts DebugTarget); the ref id arrives empty on another player's character unless staff.
interface DebugTarget {
  name: string;
  dist: number;
  live: boolean; // false once the crosshair left it while the menu stayed open
  player: boolean;
  body: boolean; // the body a PK leaves, which wears the victim's look under its own id
  refId: string; // the server's id (a player's character id), the client's own id only when clientOnly
  refDesc: string; // "hex:Plugin", empty for a ref created in game
  clientOnly: boolean; // a ref the server does not know
  baseId: string;
  baseDesc: string;
  localBaseId: string; // the client's own plugin base when it differs from baseId
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
  npcZoneResult?: { ok: boolean; at: number } | null; // the server's latest answer to Add or Save, absent on older clients
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
  survival?: SurvivalCatalog | null; // null with survival off, absent on older clients
  races?: RaceMenuData | null; // the adminRaces reply, absent until it arrives
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
type AdminSub = 'players' | 'teleport' | 'modes' | 'npcs' | 'items' | 'weather' | 'polymorph';

// Admin shows only to confirmed staff; the other three are open to every player
const TOP_TABS: Array<{ id: TopTab; label: string }> = [
  { id: 'admin', label: loc('adminPanel.tabs.admin') },
  { id: 'faction', label: loc('adminPanel.tabs.faction') },
  { id: 'skills', label: loc('adminPanel.tabs.skills') },
  { id: 'debug', label: loc('adminPanel.tabs.debug') },
];

// Each sub-tab needs its server-sent cap; Item Spawner, Weather and Polymorph need it explicitly true
const ADMIN_SUBS: Array<{ id: AdminSub; label: string }> = [
  { id: 'players', label: loc('adminPanel.tabs.players') },
  { id: 'teleport', label: loc('adminPanel.tabs.teleport') },
  { id: 'modes', label: loc('adminPanel.tabs.modes') },
  { id: 'npcs', label: loc('adminPanel.tabs.npcs') },
  { id: 'items', label: loc('adminPanel.tabs.items') },
  { id: 'weather', label: loc('adminPanel.tabs.weather') },
  { id: 'polymorph', label: loc('adminPanel.tabs.polymorph') },
];

// Teleport sections in display order; a missing or unknown group lands in Other
const LOC_GROUPS: Array<{ id: string; label: string }> = [
  { id: 'cities', label: loc('adminPanel.teleport.cities') },
  { id: 'villages', label: loc('adminPanel.teleport.villages') },
  { id: 'forts', label: loc('adminPanel.teleport.forts') },
  { id: 'temples', label: loc('adminPanel.teleport.temples') },
  { id: 'oblivion', label: loc('adminPanel.teleport.oblivion') },
  { id: 'other', label: loc('adminPanel.teleport.other') }
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
  { id: 'list', label: loc('adminPanel.npcs.tabZones') },
  { id: 'add', label: loc('adminPanel.common.add') },
  { id: 'pets', label: loc('adminPanel.npcs.tabPets') },
  { id: 'jobs', label: loc('adminPanel.npcs.tabJobs') },
];

type PetKind = 'horse' | 'livestock' | 'dog';

const PET_KINDS: Array<{ id: PetKind; label: string }> = [
  { id: 'horse', label: loc('adminPanel.pets.horse') },
  { id: 'livestock', label: loc('adminPanel.pets.livestock') },
  { id: 'dog', label: loc('adminPanel.pets.dog') },
];

// Same bound the server's cleanDisplayName applies to a pet name
const MAX_PET_NAME = 24;

type ZoneFilter = 'cooldown' | 'active' | 'none';

const ZONE_FILTERS: Array<{ id: ZoneFilter; label: string }> = [
  { id: 'cooldown', label: loc('adminPanel.npcs.filterCooldown') },
  { id: 'active', label: loc('adminPanel.npcs.filterActive') },
  { id: 'none', label: loc('common.none') },
];

// Field names follow NPC-Spawns.json; the server applies its own defaults to a blank Size, Spread, Despawn or Respawn.
const EMPTY_ZONE_FORM = { name: '', id: '', x: '', y: '', z: '', size: '2100', spread: '', npc: '', despawn: '120', respawn: '1800', type: '' };
type ZoneForm = typeof EMPTY_ZONE_FORM;

const ZONE_TYPES = ['Wildlife', 'Monster', 'Dungeon'];
// Auto leaves Type blank, so the server infers it from the zone's cell and NPCs
const ZONE_TYPE_CHOICES = [{ value: '', label: loc('adminPanel.npcs.typeAuto') }].concat(ZONE_TYPES.map((t) => ({ value: t, label: t })));
const ZONE_TYPE_FILTERS = [{ value: '', label: loc('adminPanel.npcs.allTypes') }].concat(ZONE_TYPES.map((t) => ({ value: t, label: t })));

const ZONE_FIELDS: Array<{ key: keyof ZoneForm; label: string; placeholder: string }> = [
  { key: 'name', label: loc('adminPanel.common.name'), placeholder: loc('adminPanel.zone.namePlaceholder') },
  { key: 'id', label: loc('adminPanel.zone.id'), placeholder: loc('adminPanel.zone.idPlaceholder') },
  { key: 'x', label: loc('adminPanel.zone.x'), placeholder: '191763' },
  { key: 'y', label: loc('adminPanel.zone.y'), placeholder: '-29429' },
  { key: 'z', label: loc('adminPanel.zone.z'), placeholder: '8280' },
  { key: 'size', label: loc('adminPanel.zone.size'), placeholder: '2000' },
  { key: 'spread', label: loc('adminPanel.zone.spread'), placeholder: loc('adminPanel.zone.spreadPlaceholder') },
  { key: 'despawn', label: loc('adminPanel.zone.despawn'), placeholder: '120' },
  { key: 'respawn', label: loc('adminPanel.zone.respawn'), placeholder: '1800' },
];

// Same bounds the server enforces for a mastery grant
const MAX_GRANT_HOURS = 1000;

const isGrantAmount = (text: string): boolean =>
  isNum(text) && Number.isInteger(Number(text)) && Number(text) !== 0 && Math.abs(Number(text)) <= MAX_GRANT_HOURS;

const ATTR_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'health', label: loc('adminPanel.attrs.health') },
  { key: 'magicka', label: loc('adminPanel.attrs.magicka') },
  { key: 'stamina', label: loc('adminPanel.attrs.stamina') },
];

// Same bounds the server enforces for a max attribute change
const MAX_ATTR_BONUS = 1000;

const isAttrAmount = (text: string): boolean =>
  isNum(text) && Number.isInteger(Number(text)) && Math.abs(Number(text)) <= MAX_ATTR_BONUS;

const attrForm = (av: PanelAttrs | null | undefined): Record<string, string> =>
  ({ health: String(av ? av.health : 0), magicka: String(av ? av.magicka : 0), stamina: String(av ? av.stamina : 0) });

// The craft slots when the server configures more than one, null otherwise
const craftSlots = (m: PanelMastery | null | undefined): MasterySlot[] | null => (m && m.slots && m.slots.length > 1 ? m.slots : null);

const masteryText = (m: PanelMastery | null | undefined): string => {
  if (!m) return loc('adminPanel.common.unknown');
  const slots = craftSlots(m);
  if (slots) return slots.map((s) => (s.profession ? loc('adminPanel.mastery.slotLine', { craft: s.label || s.profession, rank: s.rankName, hours: s.hours }) : loc('adminPanel.mastery.slotNone', { slot: slotName(s).toLowerCase() }))).join(' \u00b7 ');
  if (!m.profession) return m.hours ? loc('adminPanel.mastery.noCraftBanked', { hours: m.hours }) : loc('adminPanel.mastery.noCraft');
  return loc(m.hours === 1 ? 'adminPanel.mastery.lineOne' : 'adminPanel.mastery.lineMany', { craft: m.label, rank: m.rankName, hours: m.hours });
};

// survivalClimate.ts COLD_STAGE_NAMES
const COLD_STAGE_NAMES = ['Warm', 'Comfortable', 'Chilly', 'Very Cold', 'Freezing', 'Numb'];

// survivalClimate.ts coldStageOf without the hot food bonus
const coldStageName = (cold: number, stages: number[]): string => COLD_STAGE_NAMES[1 + stages.slice(1).filter((s) => cold >= s).length] || '';

const AREA_NAMES: Record<string, string> = { none: loc('adminPanel.survival.areaNone'), interior: loc('adminPanel.survival.areaInterior'), chillyInterior: loc('adminPanel.survival.areaChillyInterior') };

const DISEASE_STAGE_CHOICES = [1, 2, 3].map((n) => ({ value: String(n), label: diseaseStageName(loc('adminPanel.survival.stage', { n }), n) }));

const survivalText = (sv: PanelSurvival): string => {
  const cold = sv.cold < 0 ? loc('adminPanel.survival.coldOff') : loc('adminPanel.survival.cold', { cold: sv.cold, stage: sv.stage, warmth: sv.warmth });
  const areaVars = { area: AREA_NAMES[sv.area] || sv.area, level: sv.level };
  const area = sv.area ? loc(sv.freezingArea ? 'adminPanel.survival.areaFreezing' : 'adminPanel.survival.area', areaVars) : loc('adminPanel.survival.areaUnknown');
  return cold + ' \u00b7 ' + area;
};

// Diseases with their next stage, then afflictions and food poisoning with the time they have left
const sicknessText = (sv: PanelSurvival, now: number): string => {
  const sick = sv.diseases.map((d) => (d.nextAt ? loc('adminPanel.survival.diseaseWorse', { disease: diseaseStageName(d.name, d.stage), time: formatTimeLeft(d.nextAt, now) }) : diseaseStageName(d.name, d.stage)))
    .concat(sv.afflictions.map((a) => loc('adminPanel.survival.afflictionLeft', { name: a.name, time: formatTimeLeft(a.until, now) })))
    .concat(sv.foodPoisonUntil > now ? [loc('adminPanel.survival.foodPoison', { time: formatTimeLeft(sv.foodPoisonUntil, now) })] : []);
  return sick.length ? loc('adminPanel.survival.sick', { list: sick.join('; ') }) : loc('adminPanel.survival.noSickness');
};

const MONTHS = ['Morning Star', "Sun's Dawn", 'First Seed', "Rain's Hand", 'Second Seed', 'Midyear', "Sun's Height", 'Last Seed', 'Hearthfire', 'Frostfall', "Sun's Dusk", 'Evening Star'];
const WEEKDAYS = ['Sundas', 'Morndas', 'Tirdas', 'Middas', 'Turdas', 'Fredas', 'Loredas'];

const hexId = (id: string): string => (id ? '0x' + id.toUpperCase() : '-');

const withDesc = (id: string, desc: string): string => hexId(id) + (desc ? ' (' + desc + ')' : '');

// One line for bug reports; the descs paste straight into the Item Spawner search
const targetReport = (t: DebugTarget): string => {
  const parts = [t.name || loc('adminPanel.common.noName')];
  const ref = withDesc(t.refId, t.refDesc) + (t.clientOnly ? ' ' + loc('adminPanel.debug.clientOnly') : '');
  if (t.refId) parts.push(loc(t.body ? 'adminPanel.debug.reportBody' : t.player ? 'adminPanel.debug.reportCharacter' : 'adminPanel.debug.reportRef', { id: ref }));
  if (t.baseId) parts.push(loc('adminPanel.debug.reportBase', { id: withDesc(t.baseId, t.baseDesc) }));
  if (t.localBaseId) parts.push(loc('adminPanel.debug.reportLocalBase', { id: withDesc(t.localBaseId, t.localBaseDesc) }));
  if (t.cell) parts.push(loc('adminPanel.debug.reportCell', { id: hexId(t.cell) + (t.cellName ? ' ' + t.cellName : '') }));
  parts.push(loc('adminPanel.debug.reportPos', { pos: (t.pos || []).join(' ') }));
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
  if (!gt) return loc('adminPanel.common.unknown');
  const h = Math.floor(gt.hour);
  return pad2(h) + ':' + pad2(Math.floor((gt.hour - h) * 60));
};

const gameDate = (gt: DebugData['gameTime']): string | undefined => {
  if (!gt) return undefined;
  const month = MONTHS[Math.round(gt.month)] || '?';
  const weekday = WEEKDAYS[Math.round(gt.weekday)] || '?';
  return loc('adminPanel.debug.gameDate', { weekday, day: ordinal(Math.round(gt.day)), month, year: Math.round(gt.year) });
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
  const inGame = (desc: string): string => desc || loc('adminPanel.debug.createdInGame');
  const place = cell ? [cell.name || cell.location, !cell.interior && cell.world ? '(' + cell.world + ')' : ''].filter(Boolean).join(' ') : '';
  const av = d.av || { health: [], magicka: [], stamina: [] };
  const pair = (v: number[]): string => (v && v.length ? Math.round(v[0]) + '/' + Math.round(v[1] || 0) : '-');
  return [
    { label: loc('adminPanel.debug.accountName'), value: d.account || '-' },
    { label: loc('adminPanel.debug.characterName'), value: d.character || '-' },
    { label: loc('adminPanel.debug.formId'), value: hexId(d.formId || d.actorId) },
    { label: loc('adminPanel.debug.serverName'), value: server ? server.name || '-' : loc('adminPanel.common.unknown') },
    { label: loc('adminPanel.debug.characterPos'), value: (d.pos || []).map((n) => Math.round(n)).join(' ') || '-' },
    { label: loc('adminPanel.debug.locationId'), value: cell ? hexId(cell.id) : loc('adminPanel.common.unknown'), sub: place || undefined },
    { label: loc('adminPanel.debug.direction'), value: d.heading ? d.heading.compass + ' ' + Math.round(d.heading.deg) + '°' : '-' },
    {
      label: loc('adminPanel.debug.targetDistance'),
      value: t ? loc('adminPanel.debug.targetAt', { name: t.name || hexId(t.baseId), dist: Math.round(t.dist) }) : loc('adminPanel.debug.noTarget'),
      hint: t && !t.live ? loc('adminPanel.debug.lastSeen') : loc('adminPanel.debug.targetHint'),
    },
    { label: loc('adminPanel.debug.vitals'), value: [av.magicka, av.health, av.stamina].map(pair).join(' | ') },
    { label: loc('adminPanel.debug.gameTime'), value: gameClock(d.gameTime), sub: gameDate(d.gameTime) },
    { label: loc('adminPanel.debug.localTime'), value: formatClock(now, new Date(now).getTimezoneOffset()) },
    { label: loc('adminPanel.debug.serverTime'), value: server ? formatClock(now + server.offsetMs, server.tzOffsetMin) : loc('adminPanel.common.unknown') },
    {
      label: loc('adminPanel.debug.targetRefId'),
      value: !t ? '-' : hidden ? loc('adminPanel.debug.staffOnly') : hexId(t.refId),
      sub: !t || hidden ? undefined : t.clientOnly ? loc('adminPanel.debug.clientOnly') : t.body ? loc('adminPanel.debug.body') : t.player ? loc('adminPanel.debug.character') : inGame(t.refDesc),
    },
    {
      label: loc('adminPanel.debug.targetPos'),
      value: t ? (t.pos || []).map((n) => Math.round(n)).join(' ') || '-' : '-',
      sub: t && t.cell ? hexId(t.cell) + (t.cellName ? ' ' + t.cellName : '') : undefined,
    },
    {
      label: loc('adminPanel.debug.targetBaseId'),
      value: t ? hexId(t.baseId) : '-',
      sub: t && t.baseId ? inGame(t.baseDesc) : undefined,
      hint: t && t.localBaseId ? loc('adminPanel.debug.localBase', { id: withDesc(t.localBaseId, t.localBaseDesc) }) : undefined,
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
  const [zoneSearch, setZoneSearch] = useState('');
  const [zoneType, setZoneType] = useState('');
  // Name of the zone the Add form is editing; null while it adds a new one
  const [editingZone, setEditingZone] = useState<string | null>(null);
  // An Add or Save waits for the server's answer; a refusal keeps the form as it was
  const [zonePending, setZonePending] = useState(false);
  const [grantHours, setGrantHours] = useState('1');
  // Craft slot index the grant and reset act on
  const [grantSlot, setGrantSlot] = useState('0');
  const [attrs, setAttrs] = useState<Record<string, string>>(attrForm(null));
  // Survival row: the cold to set, the picked disease and its stage
  const [coldText, setColdText] = useState('');
  const [sickPick, setSickPick] = useState('');
  const [sickStage, setSickStage] = useState('1');
  const [petKind, setPetKind] = useState<PetKind>('horse');
  const [petBase, setPetBase] = useState('');
  const [petName, setPetName] = useState('');
  const [now, setNow] = useState(Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [copied, setCopied] = useState<{ text: string; ok: boolean } | null>(null);
  // The actor a first PK click armed; a second click on the same selection sends it
  const [pkArmed, setPkArmed] = useState('');

  const ev = data.events || {};
  const caps: NonNullable<AdminPanelData['caps']> = data.caps || {};
  const subVisible = (id: AdminSub): boolean => (id === 'items' || id === 'weather' || id === 'polymorph' ? caps[id] === true : caps[id] !== false);
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
    ? loc('adminPanel.debug.copyNoTarget')
    : copied && copied.text === report
      ? copied.ok ? loc('adminPanel.debug.copied') : loc('adminPanel.debug.copyFailed')
      : loc('adminPanel.debug.copyHint');

  const refresh = (): void => {
    if (topTab === 'debug' && ev.debugRefresh) send(ev.debugRefresh);
    if (topTab === 'admin') {
      send(ev.refresh);
      setRefreshKey((k) => k + 1);
      if (view === 'npcs' && npcSub === 'jobs' && ev.jobList) send(ev.jobList);
      if (view === 'weather' && ev.weatherList) send(ev.weatherList);
      if (view === 'polymorph' && ev.polymorphList) send(ev.polymorphList);
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
  // TP/Summon/Kick/PK/Ban all target the live actor; offline rows only display identity
  const actionsEnabled = !!(selectedPlayer && selectedPlayer.online && selectedPlayer.a);
  // Hidden rather than greyed so a tier without kick or ban never sees a dead button; the server enforces it anyway. PK shares the kick cap
  const canKick = caps.kick !== false;
  const canBan = caps.ban !== false;

  const act = (key: string, ...args: unknown[]): void => {
    if (selectedPlayer && selectedPlayer.a) send(key, selectedPlayer.a, ...args);
  };

  useEffect(() => {
    setAttrs(attrForm(selectedPlayer ? selectedPlayer.av : null));
    setPkArmed('');
    setGrantSlot('0');
    const selectedSv = selectedPlayer ? selectedPlayer.sv : undefined;
    setColdText(selectedSv && selectedSv.cold >= 0 ? String(selectedSv.cold) : '');
    setSickPick('');
    setSickStage('1');
  }, [selected]);

  // Mastery rows stay tied to the selected character.
  const masteryRows: Array<{ key: string; who: string; target: string; m: PanelMastery | null | undefined }> = [];
  if (actionsEnabled && selectedPlayer && selectedPlayer.a) masteryRows.push({ key: 'sel', who: selectedPlayer.n || loc('adminPanel.common.noName'), target: selectedPlayer.a, m: selectedPlayer.m });
  const canGrant = !!ev.masteryGrant && isGrantAmount(grantHours);
  // Filled from the selected row, so the fields show what the character carries now
  const canSetAttrs = !!ev.attrSet && actionsEnabled && ATTR_FIELDS.every((f) => isAttrAmount(attrs[f.key]));

  // The survival row shows once the server sends its catalog or a row carries a state; the actions need a client that forwards them
  const catalog = data.survival || null;
  const showSurvival = !!selectedPlayer && (!!catalog || players.some((pl) => !!pl.sv));
  const survivalActs = !!ev.survival && !!catalog;
  const sv = actionsEnabled && selectedPlayer ? selectedPlayer.sv : undefined;
  const heldDisease = (id: string) => (sv ? sv.diseases.find((d) => d.id === id) : undefined);
  // Held diseases first, so a cure is one click away
  const diseaseOptions = (catalog ? catalog.diseases : []).slice()
    .sort((x, y) => Number(!!heldDisease(y.id)) - Number(!!heldDisease(x.id)) || x.name.localeCompare(y.name))
    .map((d) => {
      const held = heldDisease(d.id);
      const name = d.contagious ? loc('adminPanel.survival.contagious', { name: d.name }) : d.name;
      return { value: d.id, label: held ? loc('adminPanel.survival.hasStage', { name, stage: held.stage }) : name };
    });
  const diseaseId = diseaseOptions.some((o) => o.value === sickPick) ? sickPick : diseaseOptions.length ? diseaseOptions[0].value : '';
  const diseaseHeld = heldDisease(diseaseId);
  const coldMax = catalog ? catalog.coldMax : 0;
  const coldNumber = isNum(coldText) ? Number(coldText) : NaN;
  const coldOk = !!sv && sv.cold >= 0 && Number.isInteger(coldNumber) && coldNumber >= 0 && coldNumber <= coldMax;
  const survivalNow = Date.now();
  const hasSickness = !!sv && (sv.diseases.length > 0 || sv.afflictions.length > 0 || sv.foodPoisonUntil > survivalNow);
  const survivalHint = !actionsEnabled
    ? loc('adminPanel.survival.selectHint')
    : !sv
      ? loc('adminPanel.survival.notSettled')
      : sicknessText(sv, survivalNow) + (coldOk && coldNumber !== sv.cold && catalog ? ' · ' + loc('adminPanel.survival.coldPreview', { cold: coldNumber, stage: coldStageName(coldNumber, catalog.coldStages) }) : '');
  const survivalAct = (action: string, fields?: Record<string, unknown>): void => {
    if (selectedPlayer && selectedPlayer.a) send(ev.survival, JSON.stringify({ action, target: selectedPlayer.a, ...fields }));
  };

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
    if (id === 'admin' && subTab === 'polymorph' && ev.polymorphList) send(ev.polymorphList);
  };

  const openSub = (id: AdminSub): void => {
    lastSub = id;
    setSub(id);
    if (id === 'npcs' && ev.npcList) send(ev.npcList);
    if (id === 'weather' && ev.weatherList) send(ev.weatherList);
    if (id === 'polymorph' && ev.polymorphList) send(ev.polymorphList);
  };

  // Seconds left until the zone can fully respawn, -1 when it never will without a reset
  const zoneLeft = (z: PanelNpcZone): number => {
    if (z.readyInSec < 0) return -1;
    const elapsed = Math.round((now - (data.npcZonesAt || now)) / 1000);
    return Math.max(0, z.readyInSec - elapsed);
  };

  const zoneStatus = (z: PanelNpcZone): string => {
    const left = zoneLeft(z);
    const ready = left === 0 ? loc('adminPanel.npcs.ready') : left < 0 ? loc('adminPanel.npcs.noRespawn') : loc('adminPanel.npcs.readyIn', { time: formatCountdown(left) });
    if (!z.active) return ready;
    const counts = { alive: z.alive, total: z.total };
    return left === 0 ? loc('adminPanel.npcs.alive', counts) : loc('adminPanel.npcs.aliveWaiting', { ...counts, ready: ready.toLowerCase() });
  };

  // On cooldown: any slot still waiting to respawn, "No respawn" included
  const zoneQuery = zoneSearch.trim().toLowerCase();
  const shownZones = npcZones.filter((z) => (zoneFilter === 'none' || (zoneFilter === 'active' ? z.active : zoneLeft(z) !== 0))
    && (!zoneType || z.type === zoneType) && (!zoneQuery || z.name.toLowerCase().indexOf(zoneQuery) !== -1));

  const setField = (key: keyof ZoneForm, value: string): void => setZoneForm({ ...zoneForm, [key]: value });

  const canAddZone = !!(zoneForm.name.trim() && zoneForm.id.trim() && zoneForm.npc.trim())
    && isNum(zoneForm.x) && isNum(zoneForm.y) && isNum(zoneForm.z)
    && isBlankOrNum(zoneForm.size) && isBlankOrNum(zoneForm.spread) && isBlankOrNum(zoneForm.despawn) && isBlankOrNum(zoneForm.respawn);

  const clearZoneForm = (): void => {
    setZoneForm(EMPTY_ZONE_FORM);
    setEditingZone(null);
    setZonePending(false);
  };

  const zoneResultAt = data.npcZoneResult ? data.npcZoneResult.at : 0;
  useEffect(() => {
    if (!zonePending || !data.npcZoneResult) return;
    setZonePending(false);
    if (!data.npcZoneResult.ok) return;
    clearZoneForm();
    setNpcSub('list');
  }, [zoneResultAt]);

  const editZone = (z: PanelNpcZone): void => {
    const e = z.entry;
    if (!e) return;
    const text = (v?: number): string => (v === undefined || v === null ? '' : String(v));
    setZoneForm({
      name: e.Name, id: e.ID, x: text(e.POS.x), y: text(e.POS.y), z: text(e.POS.z), size: text(e.Size), spread: text(e.Spread),
      npc: e.NPC.join('\n'), despawn: text(e.Despawn), respawn: text(e.Respawn), type: e.Type || '',
    });
    setEditingZone(z.name);
    setZonePending(false);
    setNpcSub('add');
  };

  // Save names the edited zone in Edit and the server replaces that entry in place; Add appends a new one
  const submitZone = (save: boolean): void => {
    if (!canAddZone) return;
    send(ev.npcAdd, JSON.stringify({
      Name: zoneForm.name.trim(),
      Type: zoneForm.type || undefined,
      ID: zoneForm.id.trim(),
      POS: { x: Number(zoneForm.x), y: Number(zoneForm.y), z: Number(zoneForm.z) },
      Size: optionalNumber(zoneForm.size),
      Spread: optionalNumber(zoneForm.spread),
      NPC: zoneForm.npc.split('\n').map((s) => s.trim()).filter(Boolean),
      Despawn: optionalNumber(zoneForm.despawn),
      Respawn: optionalNumber(zoneForm.respawn),
      Edit: save && editingZone ? editingZone : undefined,
    }));
    // The server toast reports success or the reason; success empties the form and shows the list, which refreshes on the npcZones push
    setZonePending(true);
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
            {loc('adminPanel.header.title')}
            {data.admin && data.tier ? <span style={{ fontSize: 14, opacity: 0.7, marginLeft: 6 }}>({data.tier})</span> : null}
          </span>
          <div className="admin-panel__header-buttons">
            <Button text={loc('adminPanel.header.refresh')} width={104} height={32} onClick={refresh} />
            <Button text={loc('common.close')} width={104} height={32} onClick={() => send(ev.close)} />
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
              <MasteryMenu embedded data={{ ...skills, events: { choose: ev.skillChoose, reset: ev.skillReset, close: ev.close } }} />
            ) : (
              <div className="admin-panel__empty">{loc('adminPanel.skills.loading')}</div>
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
                  {loc('adminPanel.debug.targetReport')}
                  <Button text={loc('adminPanel.debug.copyIds')} width={104} height={32} disabled={!report} onClick={copyReport} />
                  <span className="admin-panel__hint">{copyHint}</span>
                </div>
              </div>
            ) : (
              <div className="admin-panel__empty">{loc('adminPanel.debug.waiting')}</div>
            )}
            <div className="admin-panel__row admin-panel__row--head">
              <span className="admin-panel__cell admin-panel__cell--name">{loc('adminPanel.debug.effects')}</span>
              <span className="admin-panel__cell admin-panel__cell--form">{loc('adminPanel.common.formId')}</span>
              <span className="admin-panel__cell admin-panel__cell--elapsed">{loc('adminPanel.debug.elapsed')}</span>
            </div>
            <div className="admin-panel__list admin-panel__list--effects">
              {!debug || debug.effects.length === 0 ? (
                <div className="admin-panel__empty">{loc('adminPanel.debug.noEffects')}</div>
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
              <Button text={loc('adminPanel.players.tpTo')} width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.tp)} />
              <Button text={loc('adminPanel.players.summon')} width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.summon)} />
              {ev.needsReset ? <Button text={loc('adminPanel.players.resetNeeds')} width={124} height={32} disabled={!actionsEnabled} onClick={() => act(ev.needsReset)} /> : null}
              {canKick ? <Button text={loc('adminPanel.players.kick')} width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.kick)} /> : null}
              {canKick && ev.pk ? (
                selectedPlayer && selectedPlayer.a && pkArmed === selectedPlayer.a ? (
                  <Button text={loc('adminPanel.players.confirmPk')} width={104} height={32} disabled={!actionsEnabled} onClick={() => { setPkArmed(''); act(ev.pk); }} />
                ) : (
                  <Button text={loc('adminPanel.players.pk')} width={104} height={32} disabled={!actionsEnabled} onClick={() => setPkArmed(selectedPlayer?.a || '')} />
                )
              ) : null}
              {canBan ? <Button text={loc('adminPanel.players.ban')} width={104} height={32} disabled={!actionsEnabled} onClick={() => act(ev.ban)} /> : null}
            </div>
            {ev.masteryGrant && selectedPlayer ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">{loc('adminPanel.mastery.hours')}</span>
                  <input
                    className="admin-panel__input admin-panel__mastery-amount"
                    value={grantHours}
                    onChange={(e) => setGrantHours(e.target.value)}
                  />
                  <span className="admin-panel__hint">{loc('adminPanel.mastery.hoursHint')}</span>
                </div>
                {masteryRows.length === 0 ? (
                  <span className="admin-panel__hint">{loc('adminPanel.mastery.selectHint')}</span>
                ) : (
                  masteryRows.map((r) => {
                    const slots = craftSlots(r.m);
                    const picked = slots ? slots.filter((s) => String(s.slot) === grantSlot)[0] || slots[0] : null;
                    const slot = picked ? picked.slot : 0;
                    // A sub-slot takes hours only once its craft is chosen; the primary banks them either way
                    const grantOk = canGrant && !(picked && slot > 0 && !picked.profession);
                    const resetOk = picked ? !!picked.profession : !!(r.m && r.m.profession);
                    return (
                      <div key={r.key} className="admin-panel__mastery-row">
                        <span className="admin-panel__mastery-who" title={r.who}>{r.who}</span>
                        <span className="admin-panel__mastery-info" title={masteryText(r.m)}>{masteryText(r.m)}</span>
                        {slots ? (
                          <Dropdown
                            className="admin-panel__mastery-slot"
                            value={String(slot)}
                            options={slots.map((s) => ({ value: String(s.slot), label: s.profession ? loc('adminPanel.mastery.slotOption', { slot: slotName(s), craft: s.label || s.profession }) : loc('adminPanel.mastery.slotEmpty', { slot: slotName(s) }) }))}
                            onChange={setGrantSlot}
                          />
                        ) : null}
                        <Button text={loc('adminPanel.mastery.grant')} width={96} height={30} disabled={!grantOk} onClick={() => send(ev.masteryGrant, r.target, Number(grantHours), slot)} />
                        <Button text={loc('adminPanel.mastery.resetCraft')} width={116} height={30} disabled={!resetOk} onClick={() => send(ev.masteryReset, r.target, slot)} />
                      </div>
                    );
                  })
                )}
              </div>
            ) : null}
            {ev.attrSet && selectedPlayer ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">{loc('adminPanel.attrs.title')}</span>
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
                    text={loc('adminPanel.attrs.apply')}
                    width={96}
                    height={30}
                    disabled={!canSetAttrs}
                    onClick={() => act(ev.attrSet, Number(attrs.health), Number(attrs.magicka), Number(attrs.stamina))}
                  />
                </div>
                <span className="admin-panel__hint">
                  {actionsEnabled
                    ? loc('adminPanel.attrs.hint')
                    : loc('adminPanel.attrs.selectHint')}
                </span>
              </div>
            ) : null}
            {showSurvival ? (
              <div className="admin-panel__mastery">
                <div className="admin-panel__mastery-row">
                  <span className="admin-panel__mastery-who">{loc('adminPanel.survival.title')}</span>
                  <span className="admin-panel__mastery-info" title={sv ? survivalText(sv) : ''}>{sv ? survivalText(sv) : '-'}</span>
                  {survivalActs ? (
                    <>
                      <input
                        className="admin-panel__input admin-panel__survival-cold"
                        placeholder={loc('adminPanel.survival.coldPlaceholder')}
                        title={loc('adminPanel.survival.coldRange', { max: coldMax })}
                        value={coldText}
                        disabled={!sv || sv.cold < 0}
                        onChange={(e) => setColdText(e.target.value)}
                      />
                      <Button text={loc('adminPanel.survival.setCold')} width={96} height={30} disabled={!coldOk} onClick={() => survivalAct('survivalCold', { cold: coldNumber })} />
                      <Button text={loc('adminPanel.survival.details')} width={96} height={30} disabled={!actionsEnabled} onClick={() => survivalAct('survivalInfo')} />
                      <Button text={loc('adminPanel.common.reset')} width={96} height={30} disabled={!sv} onClick={() => survivalAct('survivalReset')} />
                    </>
                  ) : null}
                </div>
                {survivalActs ? (
                  <div className="admin-panel__mastery-row">
                    <span className="admin-panel__mastery-who">{loc('adminPanel.survival.disease')}</span>
                    <Dropdown
                      className="admin-panel__survival-disease"
                      value={diseaseId}
                      options={diseaseOptions}
                      placeholder={loc('adminPanel.survival.noDiseases')}
                      disabled={!sv || !diseaseOptions.length}
                      onChange={setSickPick}
                    />
                    <Dropdown className="admin-panel__survival-stage" value={sickStage} options={DISEASE_STAGE_CHOICES} disabled={!sv} onChange={setSickStage} />
                    <Button
                      text={diseaseHeld ? loc('adminPanel.survival.setStage') : loc('adminPanel.survival.give')}
                      width={104}
                      height={30}
                      disabled={!sv || !diseaseId || (!!diseaseHeld && diseaseHeld.stage === Number(sickStage))}
                      onClick={() => survivalAct('survivalDisease', { disease: diseaseId, stage: Number(sickStage) })}
                    />
                    <Button text={loc('adminPanel.survival.cure')} width={80} height={30} disabled={!diseaseHeld} onClick={() => survivalAct('survivalCure', { disease: diseaseId })} />
                    <Button text={loc('adminPanel.survival.cureAll')} width={96} height={30} disabled={!hasSickness} onClick={() => survivalAct('survivalCure')} />
                  </div>
                ) : null}
                <span className="admin-panel__hint">{survivalHint}</span>
              </div>
            ) : null}
            {ev.revive && selectedPlayer && selectedPlayer.f && selectedPlayer.f.length ? (
              <div className="admin-panel__mastery">
                {selectedPlayer.f.map((c) => (
                  <div key={c.a} className="admin-panel__mastery-row">
                    <span className="admin-panel__mastery-who" title={c.n}>{c.n}</span>
                    <span className="admin-panel__mastery-info">{c.s != null ? loc('adminPanel.revive.slot', { realm: c.r, n: c.s + 1 }) : c.r}</span>
                    <Button text={loc('adminPanel.revive.revive')} width={96} height={30} disabled={selectedPlayer.ok === false} onClick={() => send(ev.revive, c.a)} />
                  </div>
                ))}
                <span className="admin-panel__hint">
                  {selectedPlayer.ok === false
                    ? loc('adminPanel.revive.limitHint')
                    : loc('adminPanel.revive.hint')}
                </span>
              </div>
            ) : null}
            {selectedPlayer && caps.factions !== false ? (
              <FactionAssign faction={data.faction} ev={ev} send={send} target={selectedPlayer.a} enabled={actionsEnabled} />
            ) : null}
            <div className="admin-panel__filters">
              <input
                className="admin-panel__search"
                placeholder={loc('adminPanel.players.search')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="admin-panel__checkbox">
                <input
                  type="checkbox"
                  checked={onlineOnly}
                  onChange={(e) => setOnlineOnly(e.target.checked)}
                />
                {loc('adminPanel.players.onlineOnly')}
              </label>
            </div>
            <div className="admin-panel__row admin-panel__row--head">
              <span className="admin-panel__dot" />
              <span className="admin-panel__cell admin-panel__cell--ping">{loc('adminPanel.players.ping')}</span>
              <span className="admin-panel__cell admin-panel__cell--profile">{loc('adminPanel.players.profile')}</span>
              <span className="admin-panel__cell admin-panel__cell--name">{loc('adminPanel.players.character')}</span>
              <span className="admin-panel__cell admin-panel__cell--form">{loc('adminPanel.common.formId')}</span>
              <span className="admin-panel__cell admin-panel__cell--discord">{loc('adminPanel.players.discord')}</span>
              <span className="admin-panel__cell admin-panel__cell--discord-id">{loc('adminPanel.players.discordId')}</span>
              <span className="admin-panel__cell admin-panel__cell--ip">{loc('adminPanel.players.ip')}</span>
              <span className="admin-panel__cell admin-panel__cell--hwid">{loc('adminPanel.players.hwid')}</span>
            </div>
            <div className="admin-panel__list">
              {shownPlayers.length === 0 ? (
                <div className="admin-panel__empty">{loc('adminPanel.players.none')}</div>
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
                      {pl.online && pl.ping != null ? loc('adminPanel.players.pingMs', { ms: pl.ping }) : '-'}
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
                placeholder={loc('adminPanel.teleport.search')}
                value={locSearch}
                onChange={(e) => {
                  setLocSearch(e.target.value);
                  setSearchClosed([]);
                }}
              />
            </div>
            <div className="admin-panel__list">
              {locSections.length === 0 ? (
                <div className="admin-panel__empty">{locations.length === 0 ? loc('adminPanel.teleport.none') : loc('adminPanel.teleport.noMatch')}</div>
              ) : (
                locSections.map((g) => (
                  <React.Fragment key={g.id}>
                    <div className="admin-panel__row admin-panel__row--head admin-panel__row--clickable" onClick={() => toggleGroup(g.id)}>
                      <span className="admin-panel__cell admin-panel__cell--name">
                        {(groupOpen(g.id) ? '▾ ' : '▸ ') + loc('adminPanel.teleport.group', { group: g.label, n: g.rows.length })}
                      </span>
                    </div>
                    {groupOpen(g.id)
                      ? g.rows.map((l) => (
                        <div key={l.name} className="admin-panel__row admin-panel__row--location">
                          <span className="admin-panel__cell admin-panel__cell--name">{l.name}</span>
                          {l.kind ? <span className="admin-panel__cell admin-panel__cell--kind">{l.kind}</span> : null}
                          <Button text={loc('adminPanel.teleport.go')} width={112} height={30} onClick={() => send(ev.tpLoc, l.name)} />
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

        {view === 'polymorph' ? (
          <PolymorphTab
            data={data.races || null}
            ev={ev}
            send={send}
            selfActorId={debug ? debug.actorId : ''}
            selected={actionsEnabled && selectedPlayer && selectedPlayer.a ? { a: selectedPlayer.a, n: selectedPlayer.n } : null}
          />
        ) : null}


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
              <div className="admin-panel__filters">
                <input
                  className="admin-panel__search"
                  placeholder={loc('adminPanel.npcs.search')}
                  value={zoneSearch}
                  onChange={(e) => setZoneSearch(e.target.value)}
                />
                <Dropdown className="admin-panel__zone-type" value={zoneType} options={ZONE_TYPE_FILTERS} onChange={setZoneType} />
              </div>
            ) : null}

            {npcSub === 'list' ? (
              <div className="admin-panel__list">
                {shownZones.length === 0 ? (
                  <div className="admin-panel__empty">{npcZones.length === 0 ? loc('adminPanel.npcs.none') : loc('adminPanel.npcs.noMatch')}</div>
                ) : (
                  shownZones.map((z) => (
                    <div key={z.name} className="admin-panel__row admin-panel__row--zone">
                      <div className="admin-panel__zone-info">
                        <span className="admin-panel__cell admin-panel__cell--name">{z.name}</span>
                        <span className="admin-panel__cell admin-panel__cell--status">
                          <span className={'admin-panel__dot' + (z.active ? ' admin-panel__dot--online' : '')} />
                          {(z.type ? z.type + ' \u00b7 ' : '') + zoneStatus(z)}
                        </span>
                      </div>
                      <div className="admin-panel__zone-buttons">
                        <Button text={loc('adminPanel.npcs.tp')} width={48} height={24} onClick={() => send(ev.npcTp, z.name)} />
                        {ev.npcActivate ? <Button text={loc('adminPanel.npcs.activate')} width={84} height={24} onClick={() => send(ev.npcActivate, z.name)} /> : null}
                        {ev.npcDeactivate ? <Button text={loc('adminPanel.npcs.deactivate')} width={100} height={24} onClick={() => send(ev.npcDeactivate, z.name)} /> : null}
                        <Button text={loc('adminPanel.common.reset')} width={64} height={24} onClick={() => send(ev.npcReset, z.name)} />
                        {z.entry && ev.npcAdd ? <Button text={loc('adminPanel.common.edit')} width={52} height={24} onClick={() => editZone(z)} /> : null}
                        <Button text={loc('adminPanel.common.delete')} width={68} height={24} onClick={() => send(ev.npcDelete, z.name)} />
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
                    {loc('adminPanel.pets.kind')}
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
                    {loc('adminPanel.pets.base')}
                    <div className="admin-panel__filters admin-panel__filters--grid">
                      {petBaseList.length === 0 ? (
                        <span className="admin-panel__hint">{data.petBases ? loc('adminPanel.pets.noBases') : loc('adminPanel.pets.loading')}</span>
                      ) : petBaseList.map((b) => (
                        <label key={b.desc} className="admin-panel__checkbox" title={b.editorId}>
                          <input type="radio" name="pet-base" checked={petPick === b.desc} onChange={() => setPetBase(b.desc)} />
                          <span className="admin-panel__cell">{b.name || b.editorId}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                  <label className="admin-panel__field admin-panel__field--half">
                    {loc('adminPanel.pets.name')}
                    <input
                      className="admin-panel__input"
                      placeholder={loc('adminPanel.pets.namePlaceholder')}
                      maxLength={MAX_PET_NAME}
                      value={petName}
                      onChange={(e) => setPetName(e.target.value)}
                    />
                  </label>
                </div>
                <div className="admin-panel__actions">
                  <Button text={loc('adminPanel.pets.add')} width={168} height={32} disabled={!petPick} onClick={grantPet} />
                </div>
                <span className="admin-panel__hint">{loc('adminPanel.pets.hint')}</span>
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
                  <div className="admin-panel__field">
                    {loc('adminPanel.common.type')}
                    <Dropdown value={zoneForm.type} options={ZONE_TYPE_CHOICES} onChange={(v) => setField('type', v)} />
                  </div>
                  <label className="admin-panel__field admin-panel__field--wide">
                    {loc('adminPanel.zone.npcEntries')}
                    <textarea
                      className="admin-panel__textarea"
                      placeholder={'00023A99 4\n23a99:Skyrim.esm 2'}
                      value={zoneForm.npc}
                      onChange={(e) => setField('npc', e.target.value)}
                    />
                  </label>
                </div>
                <div className="admin-panel__actions">
                  {ev.npcPos ? <Button text={loc('adminPanel.zone.getPos')} width={168} height={32} onClick={() => send(ev.npcPos)} /> : null}
                  <Button text={loc('adminPanel.common.add')} width={104} height={32} disabled={!canAddZone} onClick={() => submitZone(false)} />
                  {editingZone ? <Button text={loc('common.save')} width={104} height={32} disabled={!canAddZone} onClick={() => submitZone(true)} /> : null}
                  {editingZone ? <Button text={loc('common.cancel')} width={104} height={32} onClick={clearZoneForm} /> : null}
                </div>
                {editingZone ? (
                  <span className="admin-panel__hint">{loc('adminPanel.zone.editing', { name: editingZone })}</span>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default AdminPanel;
