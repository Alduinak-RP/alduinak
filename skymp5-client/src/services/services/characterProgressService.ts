import { EquipEvent, FormType, Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";
import { RemoteServer } from "./remoteServer";
import { SinglePlayerService } from "./singlePlayerService";
import { getInventory } from "../../sync/inventory";
import { MAP_MARKER_REFS } from "../../data/mapMarkerRefs";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";

// Discovered map markers and learned ingredient effects per character, stored by the server's KnowledgeSystem and replayed here

const LEGACY_PLUGIN_NAME = "character-progress-no-load";
const STORAGE_KEY = "characterKnowledgeState";
const SETTLE_MS = 3000;
const REQUEST_RETRY_MS = 15000;
const MARKER_SCAN_MS = 10000;
const INGR_POLL_MS = 5000;
const INGR_EQUIP_DELAY_MS = 700;
const SEND_DEBOUNCE_MS = 1500;
const ERROR_LOG_MS = 5000;
const SCAN_BATCH = 60;
const INGR_READ_BATCH = 5;
const MAX_SEND = 200;
const MAX_EFFECTS = 4;
const PLAYER_FORM_ID = 0x14;
const LIGHT_MOD_HIGH = 0xfe;

// Lives in sp.storage so a client hot reload keeps it; the seen sets span every character played since the last game load
interface State {
  actorId: number;
  markers: Record<string, true>;
  ingredients: Record<string, number>;
  pendingMarkers: string[];
  pendingIngredients: Record<string, number>;
  // Engine state a character or the plugins already explain, so it is never recorded as a new discovery
  seenMarkers: Record<string, true>;
  seenIngredients: Record<string, number>;
  baselineDone: boolean;
}

// Server pairs of [desc, effect bitmask]
const toMasks = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {};
  if (Array.isArray(raw)) {
    raw.forEach((p) => {
      if (Array.isArray(p) && typeof p[0] === "string") out[p[0]] = Number(p[1]) >>> 0;
    });
  }
  return out;
};

export class CharacterProgressService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("createActorMessage", (e) => {
      if (e.message.isMe) this.onMySpawn();
    });
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("loadGame", () => this.onLoadGame());
    this.controller.on("locationDiscovery", () => this.scanSoon());
    this.controller.on("cellFullyLoaded", () => this.scanSoon());
    this.controller.on("equip", (e) => this.onEquip(e));
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Crafting) this.trackCarried();
      if (e.name === Menu.Main) this.send();
    });
    this.controller.on("menuClose", (e) => {
      if (e.name === Menu.Crafting) this.ingrPollAt = 0;
    });
  }

  private awaiting = false;
  private requestAt = 0;
  private settleFrom = 0;
  private scanCursor = MAP_MARKER_REFS.length;
  private nextScanAt = 0;
  private ingrPollAt = 0;
  private ingrQueue: string[] = [];
  private sendAt = 0;
  private lastErrorAt = 0;
  // Ingredients carried or eaten this session, still read after the last one is gone
  private tracked: Record<string, true> = {};
  private readonly descToId = new Map<string, number>();
  private readonly ingrDescs = new Map<number, string | null>();

  private get state(): State {
    let s = this.sp.storage[STORAGE_KEY] as State | undefined;
    if (!s || typeof s !== "object") {
      s = { actorId: 0, markers: {}, ingredients: {}, pendingMarkers: [], pendingIngredients: {}, seenMarkers: {}, seenIngredients: {}, baselineDone: false };
      this.sp.storage[STORAGE_KEY] = s;
    }
    return s;
  }

  private remoteId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
  }

  private onMySpawn(): void {
    this.send();
    this.awaiting = true;
    this.settleFrom = 0;
    this.request(Date.now());
  }

  // A load resets map markers and ingredient effects to the save's state, which becomes the new baseline
  private onLoadGame(): void {
    const s = this.state;
    s.seenMarkers = {};
    s.seenIngredients = {};
    s.baselineDone = false;
    this.settleFrom = 0;
    this.scanCursor = MAP_MARKER_REFS.length;
    this.nextScanAt = 0;
  }

  private request(now: number): void {
    this.requestAt = now + REQUEST_RETRY_MS;
    sendCustomPacket(this.controller, { customPacketType: "knowledgeRequest" });
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (content?.customPacketType !== "knowledgeState") return;
    const actorId = Number(content.actorId) >>> 0;
    if (!actorId || actorId !== this.remoteId()) return;
    const s = this.state;
    // A reconnect of the same character resends whatever the server never got
    const prev = s.actorId === actorId ? { markers: Object.keys(s.markers), masks: s.ingredients } : null;
    s.actorId = actorId;
    s.markers = {};
    s.ingredients = {};
    s.pendingMarkers = [];
    s.pendingIngredients = {};
    this.learn(Array.isArray(content.markers) ? content.markers : [], toMasks(content.ingredients), false);
    if (prev) this.learn(prev.markers, prev.masks, true);
    const legacy = this.legacyEntry(actorId);
    if (legacy) this.learn(legacy.markers, legacy.masks, true);
    this.awaiting = false;
    this.scanSoon();
    this.ingrPollAt = 0;
    logTrace(this, `Knowledge of ${actorId.toString(16)}: ${Object.keys(s.markers).length} markers, ${Object.keys(s.ingredients).length} ingredients`);
  }

  private onEquip(e: EquipEvent): void {
    try {
      if (e.actor.getFormID() !== PLAYER_FORM_ID || e.baseObj.getType() !== FormType.Ingredient) return;
      this.track(e.baseObj.getFormID());
      this.ingrPollAt = Math.min(this.ingrPollAt, Date.now() + INGR_EQUIP_DELAY_MS);
    } catch (err) { /* stale event object */ }
  }

  private scanSoon(): void {
    this.nextScanAt = 0;
  }

  private onUpdate(): void {
    try {
      if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return;
      const now = Date.now();
      const me = this.remoteId();
      if (!me) return;
      if (!this.settleFrom) this.settleFrom = now;
      if (this.state.actorId !== me) this.awaiting = true;
      if (this.awaiting) {
        if (now >= this.requestAt) this.request(now);
        return;
      }
      // Restore and capture start once the world has run for a while after a spawn or a load
      if (now < this.settleFrom + SETTLE_MS) return;
      this.scanMarkers(now);
      if (this.ingrQueue.length) {
        this.ingrQueue.splice(0, INGR_READ_BATCH).forEach((desc) => this.readIngredient(desc));
      } else if (now >= this.ingrPollAt) {
        this.ingrPollAt = now + INGR_POLL_MS;
        this.pollIngredients();
      }
      if (this.sendAt && now >= this.sendAt) this.send();
    } catch (err) {
      if (Date.now() - this.lastErrorAt < ERROR_LOG_MS) return;
      this.lastErrorAt = Date.now();
      logError(this, err);
    }
  }

  // Adds to the current character's sets; pending ones also go to the server
  private learn(markers: unknown[], masks: Record<string, number>, pending: boolean): void {
    const s = this.state;
    let added = false;
    markers.forEach((desc) => {
      if (typeof desc !== "string" || s.markers[desc]) return;
      s.markers[desc] = s.seenMarkers[desc] = true;
      if (pending) s.pendingMarkers.push(desc);
      added = true;
    });
    for (const desc in masks) {
      const bits = masks[desc] & ~(s.ingredients[desc] || 0);
      if (!bits) continue;
      s.ingredients[desc] = (s.ingredients[desc] || 0) | bits;
      s.seenIngredients[desc] = (s.seenIngredients[desc] || 0) | bits;
      if (pending) s.pendingIngredients[desc] = (s.pendingIngredients[desc] || 0) | bits;
      added = true;
    }
    if (pending && added && !this.sendAt) this.sendAt = Date.now() + SEND_DEBOUNCE_MS;
  }

  private send(): void {
    const s = this.state;
    this.sendAt = 0;
    if (!s.actorId) return;
    const markers = s.pendingMarkers.splice(0, MAX_SEND);
    const ingredients = Object.keys(s.pendingIngredients).slice(0, MAX_SEND).map((desc) => {
      const mask = s.pendingIngredients[desc];
      delete s.pendingIngredients[desc];
      return [desc, mask];
    });
    if (!markers.length && !ingredients.length) return;
    sendCustomPacket(this.controller, { customPacketType: "knowledgeAdd", actorId: s.actorId, markers, ingredients });
    if (s.pendingMarkers.length || Object.keys(s.pendingIngredients).length) this.sendAt = Date.now() + SEND_DEBOUNCE_MS;
  }

  // One pass re-shows every known marker the engine lost and records newly visible ones; the session's first pass is the baseline
  private scanMarkers(now: number): void {
    const s = this.state;
    if (this.scanCursor >= MAP_MARKER_REFS.length) {
      if (now < this.nextScanAt) return;
      this.scanCursor = 0;
      this.nextScanAt = now + MARKER_SCAN_MS;
    }
    const end = Math.min(this.scanCursor + SCAN_BATCH, MAP_MARKER_REFS.length);
    for (; this.scanCursor < end; ++this.scanCursor) {
      const [localId, plugin] = MAP_MARKER_REFS[this.scanCursor];
      const desc = localId.toString(16) + ":" + plugin;
      try {
        const ref = this.sp.ObjectReference.from(this.formFromDesc(desc));
        if (!ref) continue;
        const visible = ref.isMapMarkerVisible();
        if (s.markers[desc]) {
          if (!visible) ref.addToMap(true);
          s.seenMarkers[desc] = true;
        } else if (visible && !s.seenMarkers[desc]) {
          if (s.baselineDone) this.learn([desc], {}, true);
          else s.seenMarkers[desc] = true;
        }
      } catch (err) { /* form not loaded on this client */ }
    }
    if (this.scanCursor >= MAP_MARKER_REFS.length) s.baselineDone = true;
  }

  // Collects the descs to read; onUpdate then reads INGR_READ_BATCH of them per frame
  private pollIngredients(): void {
    this.trackCarried();
    const known = Object.keys(this.state.ingredients).filter((desc) => !this.tracked[desc]);
    this.ingrQueue = Object.keys(this.tracked).concat(known);
  }

  private trackCarried(): void {
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    getInventory(player).entries.forEach((e) => {
      if (e.count > 0) this.track(e.baseId);
    });
  }

  private track(baseId: number): void {
    let desc = this.ingrDescs.get(baseId);
    if (desc === undefined) {
      desc = null;
      try {
        if (this.sp.Ingredient.from(this.sp.Game.getFormEx(baseId))) desc = this.descOf(baseId);
      } catch (err) { /* unloaded base form */ }
      this.ingrDescs.set(baseId, desc);
    }
    if (desc) this.tracked[desc] = true;
  }

  // Re-teaches known effects the engine lost and records effects it learned since
  private readIngredient(desc: string): void {
    const s = this.state;
    try {
      const ing = this.sp.Ingredient.from(this.formFromDesc(desc));
      if (!ing) return;
      const n = Math.min(MAX_EFFECTS, ing.getNumEffects());
      const known = s.ingredients[desc] || 0;
      const seen = s.seenIngredients[desc] || 0;
      let learned = 0;
      for (let i = 0; i < n; ++i) {
        const bit = 1 << i;
        const engineKnows = ing.getIsNthEffectKnown(i);
        if (known & bit) {
          if (!engineKnows) ing.learnEffect(i);
        } else if (engineKnows && !(seen & bit)) {
          learned |= bit;
        }
      }
      if (known) s.seenIngredients[desc] = seen | known;
      if (learned) this.learn([], { [desc]: learned }, true);
    } catch (err) { /* form not loaded on this client */ }
  }

  private formFromDesc(desc: string) {
    let id = this.descToId.get(desc);
    if (id === undefined) {
      const sep = desc.indexOf(":");
      const form = sep > 0 ? this.sp.Game.getFormFromFile(parseInt(desc.slice(0, sep), 16), desc.slice(sep + 1)) : null;
      id = form ? form.getFormID() : 0;
      this.descToId.set(desc, id);
    }
    return id ? this.sp.Game.getFormEx(id) : null;
  }

  // Runtime form id to "hex:Plugin" using the client's own load order (light plugins live in the 0xFE space)
  private descOf(id: number): string | null {
    let desc: string | null = null;
    const high = id >>> 24;
    try {
      if (high === LIGHT_MOD_HIGH) {
        const idx = (id >>> 12) & 0xfff;
        if (idx < this.sp.Game.getLightModCount()) desc = (id & 0xfff).toString(16) + ":" + this.sp.Game.getLightModName(idx);
      } else if (high < this.sp.Game.getModCount()) {
        desc = (id & 0xffffff).toString(16) + ":" + this.sp.Game.getModName(high);
      }
    } catch (err) { /* keep null */ }
    return desc && !desc.endsWith(":") ? desc : null;
  }

  // The previous client's local save for this character, merged on login so nothing it kept is lost
  private legacyEntry(actorId: number): { markers: unknown[]; masks: Record<string, number> } | null {
    try {
      const cfg = this.sp.settings["skymp5-client"] || {};
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(LEGACY_PLUGIN_NAME, "PluginsNoLoad");
      const entry = data ? JSON.parse(data.slice(2)).characters[`${cfg["server-ip"]}:${cfg["server-port"]}/${actorId.toString(16)}`] : null;
      if (!entry) return null;
      const masks: Record<string, number> = {};
      for (const desc in entry.ingredients || {}) {
        const flags = entry.ingredients[desc];
        if (Array.isArray(flags)) masks[desc] = flags.reduce((m: number, f: unknown, i: number) => (f === true && i < MAX_EFFECTS ? m | (1 << i) : m), 0);
      }
      return { markers: Array.isArray(entry.markers) ? entry.markers : [], masks };
    } catch (err) {
      return null;
    }
  }
}
