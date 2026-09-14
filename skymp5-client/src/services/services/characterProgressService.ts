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
const MARKER_SHOWN = 1;
const MARKER_DISCOVERED = 2;

// Desc to bits: MARKER_SHOWN and MARKER_DISCOVERED for markers, bit i for a known effect i of an ingredient
type Masks = Record<string, number>;

// Lives in sp.storage so a client hot reload keeps it; the seen sets span every character played since the last game load
interface State {
  actorId: number;
  markers: Masks;
  ingredients: Masks;
  pendingMarkers: Masks;
  pendingIngredients: Masks;
  // Engine state a character or the plugins already explain, so it is never recorded as a new discovery
  seenMarkers: Masks;
  seenIngredients: Masks;
  baselineDone: boolean;
}

// Server pairs of [desc, bits]
const toMasks = (raw: unknown): Masks => {
  const out: Masks = {};
  if (Array.isArray(raw)) {
    raw.forEach((p) => {
      if (Array.isArray(p) && typeof p[0] === "string") out[p[0]] = Number(p[1]) >>> 0;
    });
  }
  return out;
};

const addBits = (masks: Masks, desc: string, bits: number): void => {
  masks[desc] = (masks[desc] || 0) | bits;
};

// Adds the bits `known` lacks to it, to `seen` and to `pending`; true when any bit was new
const mergeMasks = (known: Masks, seen: Masks, pending: Masks | null, masks: Masks): boolean => {
  let added = false;
  for (const desc in masks) {
    const bits = masks[desc] & ~(known[desc] || 0);
    if (!bits) continue;
    addBits(known, desc, bits);
    addBits(seen, desc, bits);
    if (pending) addBits(pending, desc, bits);
    added = true;
  }
  return added;
};

// Removes up to MAX_SEND entries as [desc, bits] pairs
const take = (pending: Masks): [string, number][] =>
  Object.keys(pending).slice(0, MAX_SEND).map((desc) => {
    const bits = pending[desc];
    delete pending[desc];
    return [desc, bits];
  });

export class CharacterProgressService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("createActorMessage", (e) => {
      if (e.message.isMe) this.onMySpawn();
    });
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("update", () => this.guarded(() => this.onUpdate()));
    this.controller.on("loadGame", () => this.onLoadGame());
    this.controller.on("locationDiscovery", () => this.scanSoon());
    this.controller.on("cellFullyLoaded", () => this.scanSoon());
    this.controller.on("equip", (e) => this.onEquip(e));
    this.controller.on("menuOpen", (e) => {
      if (e.name === Menu.Crafting) this.trackCarried();
      // Both quits pass through the pause menu while the world is still loaded
      if (e.name === Menu.Journal) this.guarded(() => this.captureAll());
      if (e.name === Menu.Main) this.flush();
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
      s = { actorId: 0, markers: {}, ingredients: {}, pendingMarkers: {}, pendingIngredients: {}, seenMarkers: {}, seenIngredients: {}, baselineDone: false };
      this.sp.storage[STORAGE_KEY] = s;
    }
    return s;
  }

  private remoteId(): number {
    return this.controller.lookupListener(RemoteServer).getMyRemoteRefrId() >>> 0;
  }

  private onMySpawn(): void {
    this.flush();
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
    const prev = s.actorId === actorId ? { markers: s.markers, ingredients: s.ingredients } : null;
    s.actorId = actorId;
    s.markers = {};
    s.ingredients = {};
    s.pendingMarkers = {};
    s.pendingIngredients = {};
    this.learn(toMasks(content.markers), toMasks(content.ingredients), false);
    if (prev) this.learn(prev.markers, prev.ingredients, true);
    const legacy = this.legacyEntry(actorId);
    if (legacy) this.learn(legacy.markers, legacy.ingredients, true);
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

  // Retries the request while awaiting; true once the world has run SETTLE_MS since the spawn or the last load
  private ready(now: number): boolean {
    if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return false;
    const me = this.remoteId();
    if (!me) return false;
    if (!this.settleFrom) this.settleFrom = now;
    if (this.state.actorId !== me) this.awaiting = true;
    if (this.awaiting) {
      if (now >= this.requestAt) this.request(now);
      return false;
    }
    return now >= this.settleFrom + SETTLE_MS;
  }

  private onUpdate(): void {
    const now = Date.now();
    if (!this.ready(now)) return;
    this.scanMarkers(now);
    if (this.ingrQueue.length) {
      this.ingrQueue.splice(0, INGR_READ_BATCH).forEach((desc) => this.readIngredient(desc));
    } else if (now >= this.ingrPollAt) {
      this.ingrPollAt = now + INGR_POLL_MS;
      this.pollIngredients();
    }
    if (this.sendAt && now >= this.sendAt) this.send();
  }

  // Reads every marker and ingredient at once and sends the result, since updates stop once the player quits
  private captureAll(): void {
    const now = Date.now();
    if (!this.ready(now)) return;
    this.scanMarkers(now, true);
    this.pollIngredients();
    this.ingrQueue.splice(0).forEach((desc) => this.readIngredient(desc));
    this.flush();
  }

  private guarded(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (Date.now() - this.lastErrorAt < ERROR_LOG_MS) return;
      this.lastErrorAt = Date.now();
      logError(this, err);
    }
  }

  // Adds to the current character's sets; pending ones also go to the server
  private learn(markers: Masks, ingredients: Masks, pending: boolean): void {
    const s = this.state;
    const newMarkers = mergeMasks(s.markers, s.seenMarkers, pending ? s.pendingMarkers : null, markers);
    const newIngredients = mergeMasks(s.ingredients, s.seenIngredients, pending ? s.pendingIngredients : null, ingredients);
    if (pending && (newMarkers || newIngredients) && !this.sendAt) this.sendAt = Date.now() + SEND_DEBOUNCE_MS;
  }

  private send(): void {
    const s = this.state;
    this.sendAt = 0;
    if (!s.actorId) return;
    const markers = take(s.pendingMarkers);
    const ingredients = take(s.pendingIngredients);
    if (!markers.length && !ingredients.length) return;
    sendCustomPacket(this.controller, { customPacketType: "knowledgeAdd", actorId: s.actorId, markers, ingredients });
    if (Object.keys(s.pendingMarkers).length || Object.keys(s.pendingIngredients).length) this.sendAt = Date.now() + SEND_DEBOUNCE_MS;
  }

  // Sends the whole backlog now, when no later update would send the rest for this character
  private flush(): void {
    do {
      this.send();
    } while (this.sendAt);
  }

  // One pass re-applies every known marker flag the engine lost and records new ones; the first pass after a load is the baseline
  private scanMarkers(now: number, all = false): void {
    const s = this.state;
    if (all) {
      this.scanCursor = 0;
    } else if (this.scanCursor >= MAP_MARKER_REFS.length) {
      if (now < this.nextScanAt) return;
      this.scanCursor = 0;
      this.nextScanAt = now + MARKER_SCAN_MS;
    }
    const end = all ? MAP_MARKER_REFS.length : Math.min(this.scanCursor + SCAN_BATCH, MAP_MARKER_REFS.length);
    for (; this.scanCursor < end; ++this.scanCursor) {
      const [localId, plugin] = MAP_MARKER_REFS[this.scanCursor];
      const desc = localId.toString(16) + ":" + plugin;
      try {
        const ref = this.sp.ObjectReference.from(this.formFromDesc(desc));
        if (!ref) continue;
        const engine = ref.isMapMarkerVisible() ? MARKER_SHOWN | (ref.canFastTravelToMarker() ? MARKER_DISCOVERED : 0) : 0;
        const known = s.markers[desc] || 0;
        const missing = known & ~engine;
        // Revealed markers stay undiscovered, so a first visit still discovers them
        if (missing) ref.addToMap((missing & MARKER_DISCOVERED) !== 0);
        if (known) addBits(s.seenMarkers, desc, known);
        const fresh = engine & ~(s.seenMarkers[desc] || 0);
        if (!fresh) continue;
        if (s.baselineDone) this.learn({ [desc]: fresh }, {}, true);
        else addBits(s.seenMarkers, desc, fresh);
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
      if (learned) this.learn({}, { [desc]: learned }, true);
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
  private legacyEntry(actorId: number): { markers: Masks; ingredients: Masks } | null {
    try {
      const cfg = this.sp.settings["skymp5-client"] || {};
      // @ts-expect-error (TODO: Remove in 2.10.0)
      const data = this.sp.getPluginSourceCode(LEGACY_PLUGIN_NAME, "PluginsNoLoad");
      const entry = data ? JSON.parse(data.slice(2)).characters[`${cfg["server-ip"]}:${cfg["server-port"]}/${actorId.toString(16)}`] : null;
      if (!entry) return null;
      // The old file kept every visible marker without telling whether it was visited
      const markers: Masks = {};
      if (Array.isArray(entry.markers)) entry.markers.forEach((desc: unknown) => { if (typeof desc === "string") markers[desc] = MARKER_SHOWN; });
      const ingredients: Masks = {};
      for (const desc in entry.ingredients || {}) {
        const flags = entry.ingredients[desc];
        if (Array.isArray(flags)) ingredients[desc] = flags.reduce((m: number, f: unknown, i: number) => (f === true && i < MAX_EFFECTS ? m | (1 << i) : m), 0);
      }
      return { markers, ingredients };
    } catch (err) {
      return null;
    }
  }
}
