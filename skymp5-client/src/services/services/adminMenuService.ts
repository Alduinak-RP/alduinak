import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, buttonEventKeyCode, onWidgetsCleared } from "./widgetMenuUtil";
import { RemoteServer } from "./remoteServer";
import { parseMasteryMenu } from "./masteryService";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { AuthGameData, authGameDataStorageKey } from "../../features/authModel";
import { knowsCharacter, localIdToRemoteId } from "../../view/worldViewMisc";
import { formDesc } from "../../lib/formDesc";
import { isPlayerCharacterId } from "./playerActionService";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { ActiveEffectApplyRemoveEvent, Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, FormType, ObjectReference } from "skyrimPlatform";

declare const window: any;

// Personal Menu: the interact key (default X) on nothing opens it through PlayerActionService, with Admin, Faction, Skills and Debug tabs.
// Faction, Skills and Debug show at once; the Admin tab appears only when the server answers adminMenuRequest (Discord roles / profile ids) and each sub-tab follows its server cap.
// Renders as the dedicated 'adminPanel' widget (skymp5-front features/adminPanel), trade-style: pure data in, sendMessage events out.
// Admin sub-tabs: Players (also mastery grants), Teleport, Modes, NPCs (zones, the Pets grant: adminAction petBases / petGrant, and passive Jobs: jobList / jobAdd / jobDelete / jobTp), the Item Spawner (adminAction itemSearch / itemSpawn) and Writings (writingStaff); the Skills tab embeds the mastery menu.

const WIDGET_ID = 23;
const PLAYER_FORM_ID = 0x14;
const DEBUG_REFRESH_MS = 5000;
const TARGET_REFRESH_MS = 250;
// Looking around off the crosshair raises no event, so the facing scan runs on its own beat
const FACING_REFRESH_MS = 1000;
// The crosshair only picks activatable refs; everything else is matched by projecting the cell's refs onto the screen centre
const FACING_TYPES = [FormType.Static, FormType.MovableStatic, FormType.Activator, FormType.Furniture, FormType.Door, FormType.Container, FormType.Tree, FormType.Flora, FormType.Light];
const FACING_MAX_DIST = 4096;
// Screen offset from the centre, as a fraction of the viewport
const FACING_MAX_OFFSET = 0.06;
const FACING_SCAN_LIMIT = 500;
const FIRST_DYNAMIC_ID = 0xff000000;
const EFFECTS_STORAGE_KEY = "adminDebugEffects";
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const GLOBAL_HOUR = 0x38;
const GLOBAL_DAY = 0x37;
const GLOBAL_MONTH = 0x36;
const GLOBAL_YEAR = 0x35;
const GLOBAL_DAYS_PASSED = 0x39;
const ITEM_QUERY_MAX = 64;

const events = {
  tp: "admin::tp",
  summon: "admin::summon",
  kick: "admin::kick",
  ban: "admin::ban",
  tpLoc: "admin::tploc",
  mode: "admin::mode",
  refresh: "admin::refresh",
  debugRefresh: "admin::debugrefresh",
  close: "admin::close",
  npcList: "admin::npclist",
  npcAdd: "admin::npcadd",
  npcTp: "admin::npctp",
  npcReset: "admin::npcreset",
  npcDelete: "admin::npcdelete",
  npcActivate: "admin::npcactivate",
  npcDeactivate: "admin::npcdeactivate",
  npcPos: "admin::npcpos",
  masteryGrant: "admin::masterygrant",
  masteryReset: "admin::masteryreset",
  tab: "admin::tab",
  skills: "admin::skills",
  skillChoose: "admin::skillchoose",
  itemSearch: "admin::itemsearch",
  itemSpawn: "admin::itemspawn",
  petBases: "admin::petbases",
  petGrant: "admin::petgrant",
  writingRead: "admin::writingread",
  writingRename: "admin::writingrename",
  writingDestroy: "admin::writingdestroy",
  factionMenu: "admin::factionmenu",
  faction: "admin::faction",
  jobList: "admin::joblist",
  jobSave: "admin::jobsave",
  jobDelete: "admin::jobdelete",
  jobTp: "admin::jobtp",
  jobPos: "admin::jobpos",
};

// Per-zone buttons -> adminAction; the target is the zone name
const ZONE_ACTIONS: Record<string, string> = {
  [events.npcTp]: "npcZoneTp",
  [events.npcReset]: "npcZoneReset",
  [events.npcDelete]: "npcZoneDelete",
  [events.npcActivate]: "npcZoneActivate",
  [events.npcDeactivate]: "npcZoneDeactivate",
};

// Writings tab buttons -> writingStaff ops (writingSystem.ts); the target is the document id
const WRITING_STAFF_OPS: Record<string, string> = {
  [events.writingRead]: "read",
  [events.writingRename]: "rename",
  [events.writingDestroy]: "destroy",
};

// Actions that move the admin; their success reply closes the menu
const SELF_TELEPORTS = ["teleportTo", "teleportLoc", "npcZoneTp", "jobTp"];

interface DebugServer {
  name: string;
  offsetMs: number;
  tzOffsetMin: number;
}

// Crosshair target read-outs; player marks another player's character or body
interface DebugTarget {
  name: string;
  dist: number;
  live: boolean;
  player: boolean;
  refId: string;
  refDesc: string;
  serverId: string;
  baseId: string;
  baseDesc: string;
  localBaseId: string;
  localBaseDesc: string;
  cell: string;
  cellName: string;
  pos: number[];
}

interface DebugData {
  account: string;
  character: string;
  formId: string;
  actorId: string;
  profileId: number;
  server: DebugServer | null;
  pos: number[];
  cell: { id: string; name: string; interior: boolean; world: string; location: string } | null;
  heading: { deg: number; compass: string };
  target: DebugTarget | null;
  av: { health: number[]; magicka: number[]; stamina: number[] };
  gameTime: { hour: number; day: number; month: number; year: number; weekday: number } | null;
  hoursOffset: number;
  localTime: number;
  effects: Array<{ id: string; name: string; elapsedSec: number }>;
  updatedAt: number;
}

type EffectMap = Map<number, { name: string; since: number }>;

// Injected into the browser-side widget setter (module scope, not this.*)
let panelData: any = { admin: false, debug: null as DebugData | null, players: [], locations: [], modes: [], npcZones: [], npcZonesAt: 0, caps: { ban: true }, tier: "", mastery: null, npcPos: null, skills: null, items: null, petBases: null, faction: null, jobs: null, events };

function hex(id: number): string {
  return id ? id.toString(16) : "";
}

function safe<T>(fn: () => T | null | undefined, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// The server's adminItems reply, reduced to the strings and numbers the Item Spawner renders
function parseItems(content: Record<string, unknown>) {
  const rows = Array.isArray(content["items"]) ? content["items"] : [];
  return {
    query: str(content["query"]),
    kind: str(content["kind"]),
    ready: content["ready"] !== false,
    total: Number(content["total"]) || 0,
    rows: rows
      .filter((r) => r && typeof r === "object")
      .map((r: any) => ({ desc: str(r.desc), name: str(r.name), edid: str(r.edid), type: str(r.type), plugin: str(r.plugin) })),
  };
}

export class AdminMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("crosshairRefChanged", () => { this.crosshairMoved = true; });
    this.controller.on("effectStart", (e) => this.onEffect(e, true));
    this.controller.on("effectFinish", (e) => this.onEffect(e, false));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    onWidgetsCleared(this.controller, () => { this.menuOpen = false; this.activeTab = ""; this.clearAdminData(); });
    // Staff status arrives before the first X so a remembered Admin tab never waits on the roster fetch
    this.controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" }); });
  }

  get isOpen(): boolean {
    return this.menuOpen;
  }

  // Staff data survives reopens and refreshes in place when the reply lands; faction data clears so a demoted member never sees a stale roster
  open(): void {
    panelData.faction = null;
    panelData.npcPos = null;
    panelData.items = null;
    this.activeTab = "";
    this.refreshDebug();
    this.showMenu();
    sendCustomPacket(this.controller, { customPacketType: "debugInfoRequest" });
    sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
    sendCustomPacket(this.controller, { customPacketType: "masteryInfoRequest" });
    sendCustomPacket(this.controller, { customPacketType: "factionMenuRequest" });
  }

  private onButtonEvent(e: ButtonEvent) {
    if (e.isDown && this.menuOpen && buttonEventKeyCode(e) === DxScanCode.Escape) {
      this.closeMenu();
    }
  }

  // The Debug tab reads the game every 5 s only while it is the visible tab; a crosshair move (F6 look-around) re-reads just the target
  private onUpdate(): void {
    if (!this.menuOpen || this.activeTab !== "debug") return;
    const now = Date.now();
    if (now - this.lastDebugAt >= DEBUG_REFRESH_MS) {
      this.refreshDebug();
      this.pushData();
    } else if (now - this.lastTargetAt >= (this.crosshairMoved ? TARGET_REFRESH_MS : FACING_REFRESH_MS)) {
      this.crosshairMoved = false;
      this.refreshTarget();
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;
    if (content["customPacketType"] === "adminMenu") {
      const caps = content["caps"];
      panelData = {
        admin: true,
        debug: panelData.debug,
        players: Array.isArray(content["players"]) ? content["players"] : [],
        locations: Array.isArray(content["locations"]) ? content["locations"] : [],
        modes: Array.isArray(content["modes"]) ? content["modes"] : [],
        npcZones: Array.isArray(content["npcZones"]) ? content["npcZones"] : [],
        // The front counts readyInSec down from the moment the list arrived
        npcZonesAt: Date.now(),
        // Older servers send no tier/caps (server and client deploy independently); the server still refuses bans
        caps: caps && typeof caps === "object" ? caps : { ban: true },
        tier: String(content["tier"] ?? ""),
        // The admin's own standing; absent on older servers
        mastery: content["mastery"] && typeof content["mastery"] === "object" ? content["mastery"] : null,
        skills: panelData.skills,
        items: panelData.items,
        petBases: panelData.petBases,
        faction: panelData.faction,
        jobs: panelData.jobs,
        events,
      };
      if (panelData.debug) panelData.debug.target = this.shownTarget();
      this.pushData();
      // The Pets sub-tab needs the grantable bases; only a server that resolves caps knows the action
      if (panelData.caps.npcs === true) sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "petBases" });
    } else if (content["customPacketType"] === "masteryMenu") {
      if (!this.menuOpen) return;
      panelData.skills = parseMasteryMenu(content);
      this.pushData();
    } else if (content["customPacketType"] === "factionMenu") {
      panelData.faction = content;
      this.pushData();
    } else if (content["customPacketType"] === "adminItems") {
      panelData.items = parseItems(content);
      this.pushData();
    } else if (content["customPacketType"] === "debugInfo") {
      // Natives throw in the packet-handler context; only data is stored here and the update loop reads the game
      const serverTime = Number(content["serverTime"]);
      this.server = {
        name: String(content["serverName"] ?? ""),
        offsetMs: Number.isFinite(serverTime) ? serverTime - Date.now() : 0,
        tzOffsetMin: Number(content["serverTzOffsetMin"]) || 0,
      };
      this.serverActorId = String(content["actorId"] ?? "");
      this.serverProfileId = Number(content["profileId"]) || 0;
      if (panelData.debug) {
        panelData.debug.server = this.server;
        panelData.debug.actorId = this.serverActorId;
        panelData.debug.profileId = this.serverProfileId;
        this.pushData();
      }
    } else if (content["customPacketType"] === "npcZones") {
      panelData.npcZones = Array.isArray(content["zones"]) ? content["zones"] : [];
      panelData.npcZonesAt = Date.now();
      this.pushData();
    } else if (content["customPacketType"] === "petBases") {
      const bases = content["bases"];
      // An empty object shows "No bases configured" instead of loading forever
      panelData.petBases = bases && typeof bases === "object" ? bases : {};
      this.pushData();
    } else if (content["customPacketType"] === "adminJobs") {
      panelData.jobs = Array.isArray(content["jobs"]) ? content["jobs"] : [];
      this.pushData();
    } else if (content["customPacketType"] === "adminPos") {
      // at lets a second press on the same spot refill a form edited in between; end names the job end asked for, "" for the zone form
      panelData.npcPos = { id: String(content["cellOrWorldDesc"] ?? ""), pos: Array.isArray(content["pos"]) ? content["pos"] : [], at: Date.now(), end: this.posEnd };
      this.pushData();
    } else if (content["customPacketType"] === "adminMode") {
      // Keep the Modes tab highlight in sync without a full roster refresh
      const mode = String(content["mode"] ?? "");
      const on = !!content["on"];
      for (const m of Array.isArray(panelData.modes) ? panelData.modes : []) {
        if (m && m.id === mode) m.active = on;
      }
      this.pushData();
    } else if (content["customPacketType"] === "adminActionResult") {
      notifyNextUpdate(this.controller, this.sp, String(content["text"] ?? ""));
      if (content["ok"] === true && this.menuOpen && SELF_TELEPORTS.includes(String(content["action"] ?? ""))) this.closeMenu();
    }
  }

  private clearAdminData(): void {
    panelData.admin = false;
    panelData.players = [];
    panelData.locations = [];
    panelData.modes = [];
    panelData.npcZones = [];
    panelData.mastery = null;
    panelData.petBases = null;
    panelData.jobs = null;
  }

  private showMenu(): void {
    openFormMenu(this.sp, this.browsersideWidgetSetter, { panelData, WIDGET_ID }, this.controller);
    this.menuOpen = true;
  }

  // Re-pushes data while open without re-taking focus or re-showing a browser a vanilla menu hid
  private pushData(): void {
    if (this.menuOpen) refreshFormMenu(this.sp, this.browsersideWidgetSetter, { panelData, WIDGET_ID });
  }

  private closeMenu(): void {
    closeFormMenu(this.sp, WIDGET_ID);
    this.menuOpen = false;
  }

  // SP has no active-effect enumeration, so only effects seen starting on the player after this script loaded are tracked
  private get effects(): EffectMap {
    let m = this.sp.storage[EFFECTS_STORAGE_KEY] as EffectMap | undefined;
    if (!(m instanceof Map)) {
      m = new Map();
      this.sp.storage[EFFECTS_STORAGE_KEY] = m;
    }
    return m;
  }

  private onEffect(e: ActiveEffectApplyRemoveEvent, started: boolean): void {
    try {
      if (!e.effect || !e.target || e.target.getFormID() !== PLAYER_FORM_ID) return;
      const id = e.effect.getFormID();
      if (started) this.effects.set(id, { name: e.effect.getName(), since: Date.now() });
      else this.effects.delete(id);
    } catch { }
  }

  // Update context only; every native is guarded so one missing form never blanks the whole tab
  private refreshDebug(): void {
    const sp = this.sp;
    const now = Date.now();
    this.lastDebugAt = now;
    const player = safe(() => sp.Game.getPlayer(), null);
    const auth = sp.storage[authGameDataStorageKey] as AuthGameData | undefined;
    const hoursOffset = safe(() => sp.settings["skymp5-client"]["hoursOffset"], 0);
    const d: DebugData = {
      account: auth?.remote?.discordUsername || (auth?.remote ? `id ${auth.remote.masterApiId}` : auth?.local ? `profile ${auth.local.profileId}` : ""),
      character: "",
      formId: safe(() => hex(this.controller.lookupListener(RemoteServer).getMyRemoteRefrId()), ""),
      actorId: this.serverActorId,
      profileId: this.serverProfileId,
      server: this.server,
      pos: [0, 0, 0],
      cell: null,
      heading: { deg: 0, compass: COMPASS[0] },
      target: null,
      av: { health: [0, 0], magicka: [0, 0], stamina: [0, 0] },
      gameTime: null,
      hoursOffset: typeof hoursOffset === "number" ? hoursOffset : 0,
      localTime: now,
      effects: [],
      updatedAt: now,
    };
    if (player) {
      d.character = safe(() => player.getBaseObject()?.getName(), "");
      d.pos = [safe(() => player.getPositionX(), 0), safe(() => player.getPositionY(), 0), safe(() => player.getPositionZ(), 0)].map(Math.round);
      const cell = safe(() => player.getParentCell(), null);
      if (cell) {
        d.cell = {
          id: hex(safe(() => cell.getFormID(), 0)),
          name: safe(() => cell.getName(), ""),
          interior: safe(() => cell.isInterior(), false),
          world: safe(() => player.getWorldSpace()?.getName(), ""),
          location: safe(() => player.getCurrentLocation()?.getName(), ""),
        };
      }
      const deg = Math.round(((safe(() => player.getAngleZ(), 0) % 360) + 360) % 360) % 360;
      d.heading = { deg, compass: COMPASS[Math.round(deg / 45) % 8] };
      this.readTarget(player);
      d.target = this.shownTarget();
      const av = (name: string) => [Math.round(safe(() => player.getActorValue(name), 0)), Math.round(safe(() => player.getActorValueMax(name), 0))];
      d.av = { health: av("Health"), magicka: av("Magicka"), stamina: av("Stamina") };
      // Pruned on every refresh so finished effects missed by effectFinish drop out
      const effects = this.effects;
      effects.forEach((info, id) => {
        if (!safe(() => player.hasMagicEffect(sp.MagicEffect.from(sp.Game.getFormEx(id))), true)) {
          effects.delete(id);
          return;
        }
        d.effects.push({ id: hex(id), name: info.name, elapsedSec: Math.round((now - info.since) / 1000) });
      });
    }
    // The engine's weekday is floor(GameDaysPassed) % 7 with Sundas as 0, so this shows what the game shows
    const global = (id: number) => safe(() => sp.GlobalVariable.from(sp.Game.getFormEx(id))?.getValue(), NaN);
    const hour = global(GLOBAL_HOUR), day = global(GLOBAL_DAY), month = global(GLOBAL_MONTH), year = global(GLOBAL_YEAR);
    const daysPassed = global(GLOBAL_DAYS_PASSED);
    if ([hour, day, month, year, daysPassed].every(Number.isFinite)) {
      d.gameTime = { hour, day, month, year, weekday: Math.floor(daysPassed) % 7 };
    }
    panelData.debug = d;
  }

  // A crosshair miss keeps the last target as last seen while the menu stays open
  private readTarget(player: Actor): void {
    const sp = this.sp;
    this.lastTargetAt = Date.now();
    const ref = safe(() => sp.Game.getCurrentCrosshairRef(), null) || this.facingRef(player);
    if (!ref) {
      if (this.target && this.menuOpen) this.target.live = false;
      else this.target = null;
      return;
    }
    const descOf = (id: number): string => (id && formDesc(id)) || "";
    const refId = safe(() => ref.getFormID(), 0) >>> 0;
    const serverId = safe(() => localIdToRemoteId(refId), 0) >>> 0;
    const character = safe(() => isPlayerCharacterId(this.controller, serverId), false);
    // Refs created in game read their base from the server's world model
    const serverBase = serverId >= FIRST_DYNAMIC_ID
      ? safe(() => this.controller.lookupListener(RemoteServer).getWorldModel().forms.find((f) => f?.refrId === serverId)?.baseId, 0) >>> 0
      : 0;
    const localBase = safe(() => ref.getBaseObject()?.getFormID(), 0) >>> 0;
    const baseId = serverBase || localBase;
    const localBaseId = localBase !== baseId ? localBase : 0;
    let name = safe(() => ref.getDisplayName(), "") || safe(() => ref.getBaseObject()?.getName(), "");
    if (character && !knowsCharacter(serverId)) name = safe(() => sp.Actor.from(ref)?.isDead(), false) ? "Body" : "Stranger";
    this.target = {
      name,
      dist: Math.round(safe(() => player.getDistance(ref), 0)),
      live: true,
      player: character,
      refId: hex(refId),
      refDesc: descOf(refId),
      serverId: hex(serverId),
      baseId: hex(baseId),
      baseDesc: descOf(baseId),
      localBaseId: hex(localBaseId),
      localBaseDesc: descOf(localBaseId),
      cell: hex(safe(() => ref.getParentCell()?.getFormID(), 0)),
      cellName: safe(() => ref.getParentCell()?.getName(), ""),
      pos: [safe(() => ref.getPositionX(), 0), safe(() => ref.getPositionY(), 0), safe(() => ref.getPositionZ(), 0)].map(Math.round),
    };
  }

  // Statics, trees and other scenery the crosshair ignores: the loaded cell's ref closest to the screen centre
  private facingRef(player: Actor): ObjectReference | null {
    const sp = this.sp;
    const cell = safe(() => player.getParentCell(), null);
    if (!cell) return null;
    const from = ObjectReferenceEx.getPos(player);
    let best: ObjectReference | null = null;
    let bestOffset = FACING_MAX_OFFSET;
    let scanned = 0;
    for (const type of FACING_TYPES) {
      const count = safe(() => cell.getNumRefs(type), 0);
      for (let i = 0; i < count && scanned < FACING_SCAN_LIMIT; i++) {
        scanned++;
        const ref = safe(() => cell.getNthRef(i, type), null);
        if (!ref) continue;
        const pos = safe(() => ObjectReferenceEx.getPos(ref), null);
        if (!pos || ObjectReferenceEx.getDistance(from, pos) > FACING_MAX_DIST) continue;
        const point = safe(() => sp.worldPointToScreenPoint(pos)[0], null);
        // A negative depth is behind the camera
        if (!point || point[2] <= 0) continue;
        const offset = Math.hypot(point[0] - 0.5, point[1] - 0.5);
        if (offset >= bestOffset) continue;
        bestOffset = offset;
        best = ref;
      }
    }
    return best;
  }

  // Pushes only when the target or its last seen state changed
  private refreshTarget(): void {
    const key = (t: DebugTarget | null): string => (t ? t.refId + ":" + t.live : "");
    const before = key(this.target);
    const player = safe(() => this.sp.Game.getPlayer(), null);
    if (!player) return;
    this.readTarget(player);
    if (!panelData.debug || key(this.target) === before) return;
    panelData.debug.target = this.shownTarget();
    this.pushData();
  }

  // A player character's ref and server ids stay the same across masks and sessions, so only staff see them
  private shownTarget(): DebugTarget | null {
    const t = this.target;
    return t && t.player && !panelData.admin ? { ...t, refId: "", refDesc: "", serverId: "" } : t;
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const kind = e.arguments[0];
    if (kind === events.close || (kind === "menu:escape" && this.menuOpen)) {
      this.closeMenu();
      return;
    }
    if (kind === events.tab) {
      this.activeTab = String(e.arguments[1] ?? "");
      return;
    }
    if (kind === events.skills) {
      sendCustomPacket(this.controller, { customPacketType: "masteryInfoRequest" });
      return;
    }
    if (kind === events.skillChoose) {
      const profession = str(e.arguments[1]);
      if (profession) sendCustomPacket(this.controller, { customPacketType: "masteryChoose", profession });
      return;
    }
    if (kind === events.factionMenu) {
      sendCustomPacket(this.controller, { customPacketType: "factionMenuRequest", factionId: str(e.arguments[1]) });
      return;
    }
    if (kind === events.faction) {
      // The front sends {action, factionId, profileId?, slot?, rank?, target?} as a JSON string; the server checks every right
      let req: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(str(e.arguments[1]));
        if (parsed && typeof parsed === "object") req = parsed;
      } catch {
        return;
      }
      sendCustomPacket(this.controller, {
        customPacketType: "factionRequest",
        action: str(req["action"]),
        factionId: str(req["factionId"]),
        profileId: Number(req["profileId"]) || 0,
        slot: Number.isInteger(req["slot"]) ? req["slot"] : null,
        rank: str(req["rank"]),
        target: Number(req["target"]) || 0,
      });
      return;
    }
    if (kind === events.itemSearch) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "itemSearch", query: String(e.arguments[1] ?? "").slice(0, ITEM_QUERY_MAX), kind: String(e.arguments[2] ?? "") });
      return;
    }
    if (kind === events.itemSpawn) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "itemSpawn", item: String(e.arguments[1] ?? ""), count: Number(e.arguments[2]), target: String(e.arguments[3] ?? "") });
      return;
    }
    if (kind === events.refresh) {
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
      return;
    }
    if (typeof kind === "string" && WRITING_STAFF_OPS[kind]) {
      sendCustomPacket(this.controller, { customPacketType: "writingStaff", op: WRITING_STAFF_OPS[kind], id: str(e.arguments[1]), title: str(e.arguments[2]) });
      return;
    }
    if (kind === events.debugRefresh) {
      this.controller.once("update", () => {
        this.refreshDebug();
        this.pushData();
      });
      sendCustomPacket(this.controller, { customPacketType: "debugInfoRequest" });
      return;
    }
    if (kind === events.tpLoc) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "teleportLoc", target: String(e.arguments[1] ?? "") });
      return;
    }
    if (kind === events.mode) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "toggleMode", mode: String(e.arguments[1] ?? "") });
      return;
    }
    if (kind === events.npcList) {
      sendCustomPacket(this.controller, { customPacketType: "npcZonesRequest" });
      return;
    }
    if (kind === events.npcPos || kind === events.jobPos) {
      this.posEnd = kind === events.jobPos ? str(e.arguments[1]) : "";
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "npcZonePos" });
      return;
    }
    if (kind === events.jobList) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "jobList" });
      return;
    }
    if (kind === events.jobSave) {
      // One Jobs.json entry as a JSON string; the server pushes adminJobs after every change
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "jobAdd", job: str(e.arguments[1]) });
      return;
    }
    if (kind === events.jobDelete || kind === events.jobTp) {
      const action = kind === events.jobDelete ? "jobDelete" : "jobTp";
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action, target: str(e.arguments[1]), end: str(e.arguments[2]) });
      return;
    }
    if (kind === events.npcAdd) {
      // The front sends one NPC-Spawns.json entry as a JSON string; the server pushes npcZones after every mutation
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "npcZoneAdd", zone: typeof e.arguments[1] === "string" ? e.arguments[1] : "" });
      return;
    }
    if (kind === events.petBases) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "petBases" });
      return;
    }
    if (kind === events.petGrant) {
      // The front sends {kind, base, name} as a JSON string; the reply is an adminActionResult toast
      let grant: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(str(e.arguments[1]));
        if (parsed && typeof parsed === "object") grant = parsed;
      } catch {
        // a bad payload grants nothing, the server refuses the empty kind
      }
      sendCustomPacket(this.controller, {
        customPacketType: "adminAction",
        action: "petGrant",
        kind: str(grant["kind"]),
        base: str(grant["base"]),
        name: str(grant["name"]),
      });
      return;
    }
    if (kind === events.masteryGrant || kind === events.masteryReset) {
      const target = String(e.arguments[1] ?? "");
      if (kind === events.masteryGrant) {
        sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "masteryGrant", target, amount: Number(e.arguments[2]) });
      } else {
        sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "masteryReset", target });
      }
      // The roster carries the standing; ask for a fresh one
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
      return;
    }
    const zoneAction = ZONE_ACTIONS[String(kind)];
    if (zoneAction) {
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: zoneAction, target: String(e.arguments[1] ?? "") });
      return;
    }
    if (kind !== events.tp && kind !== events.summon && kind !== events.kick && kind !== events.ban) return;
    const target = String(e.arguments[1] ?? "");
    const action =
      kind === events.tp ? "teleportTo" :
      kind === events.summon ? "summon" :
      kind === events.kick ? "kick" : "ban";
    sendCustomPacket(this.controller, { customPacketType: "adminAction", action, target });
    // Kick/ban changes the roster; ask for a fresh one
    if (action === "kick" || action === "ban") {
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
    }
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  // No spread syntax: it breaks after FunctionInfo stringification.
  private browsersideWidgetSetter = () => {
    const widget: any = Object.assign({ type: "adminPanel", id: WIDGET_ID }, panelData);
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private activeTab = "";
  private lastDebugAt = 0;
  private lastTargetAt = 0;
  private crosshairMoved = false;
  private target: DebugTarget | null = null;
  private server: DebugServer | null = null;
  private serverActorId = "";
  private serverProfileId = 0;
  private posEnd = "";
}
