import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { RemoteServer } from "./remoteServer";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { AuthGameData, authGameDataStorageKey } from "../../features/authModel";
import { ActiveEffectApplyRemoveEvent, BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";

declare const window: any;

// Tabbed admin panel (default Insert, launcher-configurable via adminMenuKeyCode); item spawning is via the server-granted in-game console.
// Every player gets the Debug tab at once; the admin tabs appear only when the server answers adminMenuRequest (Discord roles / profile ids).
// Renders as the dedicated 'adminPanel' widget (skymp5-front features/adminPanel), trade-style: pure data in, sendMessage events out.

const WIDGET_ID = 23;
const PLAYER_FORM_ID = 0x14;
const DEBUG_REFRESH_MS = 5000;
const EFFECTS_STORAGE_KEY = "adminDebugEffects";
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const GLOBAL_HOUR = 0x38;
const GLOBAL_DAY = 0x37;
const GLOBAL_MONTH = 0x36;
const GLOBAL_YEAR = 0x35;

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
};

interface DebugServer {
  name: string;
  offsetMs: number;
  tzOffsetMin: number;
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
  target: { name: string; id: string; dist: number } | null;
  av: { health: number[]; magicka: number[]; stamina: number[] };
  gameTime: { hour: number; day: number; month: number; year: number; weekday: number } | null;
  hoursOffset: number;
  localTime: number;
  effects: Array<{ id: string; name: string; elapsedSec: number }>;
  updatedAt: number;
}

type EffectMap = Map<number, { name: string; since: number }>;

// Injected into the browser-side widget setter (module scope, not this.*)
let panelData: any = { admin: false, debug: null as DebugData | null, players: [], locations: [], modes: [], npcZones: [], npcZonesAt: 0, caps: { ban: true }, tier: "", events };

function hex(id: number): string {
  return id.toString(16);
}

function safe<T>(fn: () => T | null | undefined, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null ? fallback : v;
  } catch {
    return fallback;
  }
}

export class AdminMenuService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.menuKey = readMenuKeyCode(sp, "adminMenuKeyCode", DxScanCode.Insert);
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("effectStart", (e) => this.onEffect(e, true));
    this.controller.on("effectFinish", (e) => this.onEffect(e, false));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
  }

  private onButtonEvent(e: ButtonEvent) {
    if (e.device !== InputDeviceType.Keyboard || !e.isDown) return;
    if (e.code === DxScanCode.Escape && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.code !== this.menuKey) return;
    if (this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) return;
    this.openMenu();
  }

  // Admin data is cleared on every open so a demoted admin never sees stale tabs
  private openMenu(): void {
    panelData.admin = false;
    panelData.players = [];
    panelData.locations = [];
    panelData.modes = [];
    panelData.npcZones = [];
    this.refreshDebug();
    this.showMenu();
    sendCustomPacket(this.controller, { customPacketType: "debugInfoRequest" });
    sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
  }

  private onUpdate(): void {
    if (!this.menuOpen || Date.now() - this.lastDebugAt < DEBUG_REFRESH_MS) return;
    this.refreshDebug();
    this.pushData();
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
        events,
      };
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
    }
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
      const ref = safe(() => sp.Game.getCurrentCrosshairRef(), null);
      if (ref) {
        d.target = {
          name: safe(() => ref.getDisplayName(), "") || safe(() => ref.getBaseObject()?.getName(), ""),
          id: hex(safe(() => ref.getFormID(), 0)),
          dist: Math.round(safe(() => player.getDistance(ref), 0)),
        };
      }
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
    // timeService mirrors the real UTC calendar shifted by hoursOffset into these globals, so the weekday follows the same clock
    const global = (id: number) => safe(() => sp.GlobalVariable.from(sp.Game.getFormEx(id))?.getValue(), NaN);
    const hour = global(GLOBAL_HOUR), day = global(GLOBAL_DAY), month = global(GLOBAL_MONTH), year = global(GLOBAL_YEAR);
    if ([hour, day, month, year].every(Number.isFinite)) {
      d.gameTime = { hour, day, month, year, weekday: new Date(now + d.hoursOffset * 3600000).getUTCDay() };
    }
    panelData.debug = d;
  }

  private onBrowserMessage(e: BrowserMessageEvent) {
    const kind = e.arguments[0];
    if (kind === events.close || (kind === "menu:escape" && this.menuOpen)) {
      this.closeMenu();
      return;
    }
    if (kind === events.refresh) {
      sendCustomPacket(this.controller, { customPacketType: "adminMenuRequest" });
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
    if (kind === events.npcAdd) {
      // The front sends one NPC-Spawns.json entry as a JSON string; the server pushes npcZones after every mutation
      sendCustomPacket(this.controller, { customPacketType: "adminAction", action: "npcZoneAdd", zone: typeof e.arguments[1] === "string" ? e.arguments[1] : "" });
      return;
    }
    if (kind === events.npcTp || kind === events.npcReset || kind === events.npcDelete) {
      const zoneAction = kind === events.npcTp ? "npcZoneTp" : kind === events.npcReset ? "npcZoneReset" : "npcZoneDelete";
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

  private menuKey: DxScanCode;
  private menuOpen = false;
  private lastDebugAt = 0;
  private server: DebugServer | null = null;
  private serverActorId = "";
  private serverProfileId = 0;
}
