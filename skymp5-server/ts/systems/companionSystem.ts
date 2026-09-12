import * as fs from "fs";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, WORLD_LOADED_EVENT } from "./system";
import { placeNpc, placeAtMe, NpcLocation } from "./npcPlacement";
import { toFormId } from "./formIdUtil";
import { userOf, isAlive, isNear, hex, destroyLeftovers, destroyRef } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Companion library: NPC allies owned by a player (summons, reanimated corpses, later pets such as dogs).
// API, protocol and lifecycle are documented in docs/docs_roleplay_companions.md; the owner's client side is companionService.ts.

export type CompanionKind = "summon" | "reanimated" | "companion";

export interface CompanionOptions {
  kind?: CompanionKind;
  // Where to stand; default is in front of the owner
  pos?: number[];
  rot?: number[];
  // Seconds until it ends on its own; 0 or omitted lasts until dismissed or killed
  durationSec?: number;
  // Stored when the owner logs out (and across restarts) and placed again at their next login
  persistent?: boolean;
  // Spell or other form that created it, for logs
  source?: number;
  // Ends or dies as a lootable ash pile holding its items instead of a body (vanilla Reanimate)
  ashPile?: boolean;
}

export interface CompanionInfo {
  id: number;
  ownerId: number;
  baseId: number;
  kind: CompanionKind;
  targetId: number;
  expiresAt: number;
  persistent: boolean;
  source: number;
}

interface Companion extends CompanionInfo {
  baseDesc: string;
  ashPile: boolean;
  createdAt: number;
  lastRetargetAt: number;
  ownerAwaySince: number;
}

interface Stored {
  ownerId: number;
  baseDesc: string;
  kind: CompanionKind;
}

interface Saved extends Stored {
  id: number;
  persistent: boolean;
}

// commanded: counts toward the owner's command limit; dieOnEnd: expiry and dismissal kill it instead of removing it; corpseSec null: NPC corpse rule
const KIND_RULES: Record<CompanionKind, { commanded: boolean; dieOnEnd: boolean; corpseSec: number | null; lootable: boolean }> = {
  summon: { commanded: true, dieOnEnd: false, corpseSec: 3, lootable: false },
  reanimated: { commanded: true, dieOnEnd: true, corpseSec: null, lootable: true },
  companion: { commanded: false, dieOnEnd: false, corpseSec: 120, lootable: true },
};

// NPC corpses and ash piles last this long; overridable via "npcCorpseSeconds", the zone NPC setting
const DEFAULT_CORPSE_SEC = 300;
// Vanilla ReanimateAshPile fDelay: the body lies this long before it turns to ash
const ASH_DELAY_MS = 1250;
// defaultGhostCorpse, the vanilla ash pile container; overridable via "reanimateAshPileBase"
const DEFAULT_ASH_PILE_BASE = 0xc674b;

const REGISTRY_FILE = "./companions.json";
const UPDATE_MS = 500;
const SPAWN_DISTANCE = 160;
const SPAWN_LIFT = 32;
const FOLLOW_OFFSET = -128;
// Farther than this from the owner, or in another cell, the companion is moved behind them
const FOLLOW_TELEPORT_DISTANCE = 4096;
const COMMAND_RANGE = 4096;
const TARGET_KEEP_RANGE = 6144;
const DEFEND_RETARGET_MS = 3000;
const OWNER_GONE_MS = 5000;
// Vanilla: one commanded actor, two with Twin Souls
const COMMAND_LIMIT = 1;
const TWIN_SOULS_LIMIT = 2;

// A container holds nothing worn: worn flags are dropped and stacks that become equal are merged, so every stack stays takeable
const looseEntries = (inventory: any): Record<string, unknown>[] => {
  const merged = new Map<string, Record<string, unknown>>();
  const entries: any[] = Array.isArray(inventory?.entries) ? inventory.entries : [];
  for (const e of entries) {
    if (!e || typeof e.baseId !== "number" || !(e.count > 0)) continue;
    const { count, worn, wornLeft, ...rest } = e;
    const key = JSON.stringify(rest);
    const m = merged.get(key);
    if (m) m.count = Number(m.count) + count;
    else merged.set(key, { ...rest, count });
  }
  return Array.from(merged.values());
};

export class CompanionSystem implements System {
  systemName = "CompanionSystem";
  constructor(private log: Log) { }

  private mp: Mp = null;
  private companions = new Map<number, Companion>();
  // Bodies of ended companions and ash piles, and when they are removed or turn to ash
  private corpses = new Map<number, number>();
  // Bodies that turn to ash when their corpses entry is due
  private ashing = new Set<number>();
  private corpseSec = DEFAULT_CORPSE_SEC;
  private ashPileDesc = "";
  private stored: Stored[] = [];
  private twinSouls = new Set<number>();
  // Actor ids of the previous run still to destroy
  private leftovers: number[] = [];

  async initAsync(ctx: SystemContext): Promise<void> {
    this.mp = ctx.svr as Mp;
    const all = (await Settings.get()).allSettings as Record<string, unknown> | null;
    const corpseSec = Number(all?.["npcCorpseSeconds"]);
    if (Number.isFinite(corpseSec) && corpseSec > 0) this.corpseSec = corpseSec;
    this.ashPileDesc = this.containerDesc(all?.["reanimateAshPileBase"] ?? DEFAULT_ASH_PILE_BASE);
    this.loadRegistry();
    ctx.gm.once(WORLD_LOADED_EVENT, () => this.removeLeftovers());
    this.installHooks();
    ctx.gm.on("userAssignActor", (_userId: number, actorId: number) => {
      try {
        this.onOwnerAssigned(actorId >>> 0);
      } catch (e) {
        this.log(`CompanionSystem: assign hook failed: ${e}`);
      }
    });
  }

  async updateAsync(): Promise<void> {
    await new Promise((r) => setTimeout(r, UPDATE_MS));
    if (!this.mp) return;
    const now = Date.now();
    this.removeCorpses(now);
    for (const c of Array.from(this.companions.values())) {
      try {
        this.check(c, now);
      } catch (e) {
        this.log(`CompanionSystem: check of ${hex(c.id)} failed: ${e}`);
      }
    }
  }

  disconnect(userId: number, ctx: SystemContext): void {
    let ownerId = 0;
    try { ownerId = ctx.svr.getUserActor(userId) >>> 0; } catch { return; }
    if (!ownerId) return;
    this.twinSouls.delete(ownerId);
    for (const c of this.ownedBy(ownerId)) this.release(c);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "companionCommand") return;
    let ownerId = 0;
    try { ownerId = ctx.svr.getUserActor(userId) >>> 0; } catch { return; }
    if (!ownerId) return;
    const action = String(content["action"] ?? "");
    if (action === "perks") {
      if (content["twinSouls"] === true) this.twinSouls.add(ownerId);
      else this.twinSouls.delete(ownerId);
      return;
    }
    const wanted = content["companionId"] === undefined ? 0 : toFormId(content["companionId"]);
    const mine = this.ownedBy(ownerId).filter((c) => !wanted || c.id === wanted);
    if (!mine.length) return;
    if (action === "attack") {
      const targetId = toFormId(content["targetId"]);
      for (const c of mine) this.orderAttack(c.id, targetId);
    } else if (action === "follow") {
      for (const c of mine) this.orderFollow(c.id);
    } else if (action === "dismiss" && wanted) {
      this.dismiss(wanted, "dismissed by owner");
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  spawn(ownerId: number, baseId: number, opts: CompanionOptions = {}): number | null {
    const mp = this.mp;
    const kind: CompanionKind = opts.kind ?? "companion";
    let baseDesc = "";
    try {
      if (mp.lookupEspmRecordById(baseId)?.record?.type === "NPC_") baseDesc = mp.getDescFromId(baseId);
    } catch { }
    if (!baseDesc) {
      this.log(`CompanionSystem: ${hex(baseId)} is not an NPC_ record, nothing spawned for ${hex(ownerId)}`);
      return null;
    }
    if (KIND_RULES[kind].commanded) this.makeRoom(ownerId);
    let id = 0;
    try {
      const loc = this.locationNear(ownerId, SPAWN_DISTANCE);
      if (opts.pos) loc.pos = opts.pos;
      if (opts.rot) loc.rot = opts.rot;
      id = placeNpc(mp, ownerId, baseDesc, loc) >>> 0;
    } catch (e) {
      this.log(`CompanionSystem: failed to spawn ${baseDesc} for ${hex(ownerId)}: ${e}`);
      return null;
    }
    const now = Date.now();
    const durationSec = opts.durationSec ?? 0;
    this.companions.set(id, {
      id, ownerId, baseId, baseDesc, kind,
      ashPile: !!opts.ashPile,
      targetId: 0,
      expiresAt: durationSec > 0 ? now + durationSec * 1000 : 0,
      persistent: !!opts.persistent,
      source: opts.source ?? 0,
      createdAt: now,
      lastRetargetAt: 0,
      ownerAwaySince: 0,
    });
    this.log(`CompanionSystem: ${kind} ${hex(id)} (${baseDesc}) spawned for ${hex(ownerId)}${opts.source ? ` by ${hex(opts.source)}` : ""}`);
    this.save();
    this.sendState(ownerId);
    return id;
  }

  // A summon vanishes, a reanimated corpse dies again
  dismiss(companionId: number, reason = "dismissed"): boolean {
    const c = this.companions.get(companionId >>> 0);
    if (!c) return false;
    this.end(c, reason, false);
    return true;
  }

  orderAttack(companionId: number, targetId: number): boolean {
    const c = this.companions.get(companionId >>> 0);
    if (!c || !this.isValidTarget(c.ownerId, targetId >>> 0, COMMAND_RANGE)) return false;
    if (c.targetId !== targetId >>> 0) {
      c.targetId = targetId >>> 0;
      c.lastRetargetAt = Date.now();
      this.sendState(c.ownerId);
    }
    return true;
  }

  orderFollow(companionId: number): boolean {
    const c = this.companions.get(companionId >>> 0);
    if (!c) return false;
    if (c.targetId) {
      c.targetId = 0;
      this.sendState(c.ownerId);
    }
    return true;
  }

  // Every companion of the owner turns on the aggressor; one already fighting switches at most every few seconds
  defend(ownerId: number, aggressorId: number): void {
    const mine = this.ownedBy(ownerId);
    if (!mine.length || !this.isValidTarget(ownerId, aggressorId, COMMAND_RANGE)) return;
    const now = Date.now();
    let changed = false;
    for (const c of mine) {
      if (c.targetId === aggressorId || (c.targetId && now - c.lastRetargetAt < DEFEND_RETARGET_MS)) continue;
      c.targetId = aggressorId;
      c.lastRetargetAt = now;
      changed = true;
    }
    if (changed) this.sendState(ownerId);
  }

  list(ownerId: number): CompanionInfo[] {
    return this.ownedBy(ownerId).map((c) => this.toInfo(c));
  }

  info(companionId: number): CompanionInfo | undefined {
    const c = this.companions.get(companionId >>> 0);
    return c ? this.toInfo(c) : undefined;
  }

  // A live companion or the body of one that ended
  isCompanionActor(actorId: number): boolean {
    return this.companions.has(actorId >>> 0) || this.corpses.has(actorId >>> 0);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private toInfo(c: Companion): CompanionInfo {
    const { id, ownerId, baseId, kind, targetId, expiresAt, persistent, source } = c;
    return { id, ownerId, baseId, kind, targetId, expiresAt, persistent, source };
  }

  private ownedBy(ownerId: number): Companion[] {
    return Array.from(this.companions.values()).filter((c) => c.ownerId === ownerId);
  }

  private isValidTarget(ownerId: number, targetId: number, range: number): boolean {
    if (!targetId || targetId === ownerId || this.companions.get(targetId)?.ownerId === ownerId) return false;
    return isAlive(this.mp, targetId) && isNear(this.mp, ownerId, targetId, range);
  }

  // The newest commanded actor replaces the oldest
  private makeRoom(ownerId: number): void {
    const limit = this.twinSouls.has(ownerId) ? TWIN_SOULS_LIMIT : COMMAND_LIMIT;
    const commanded = this.ownedBy(ownerId)
      .filter((c) => KIND_RULES[c.kind].commanded)
      .sort((a, b) => a.createdAt - b.createdAt);
    while (commanded.length >= limit) this.end(commanded.shift() as Companion, "replaced", false);
  }

  // distance > 0 is in front of the owner, < 0 behind
  private locationNear(ownerId: number, distance: number): NpcLocation {
    const mp = this.mp;
    const p = mp.getActorPos(ownerId);
    const angleZ = Number(mp.get(ownerId, "angle")?.[2]) || 0;
    const rad = (angleZ * Math.PI) / 180;
    return {
      cellOrWorldDesc: String(mp.get(ownerId, "worldOrCellDesc")),
      pos: [p[0] + distance * Math.sin(rad), p[1] + distance * Math.cos(rad), p[2] + SPAWN_LIFT],
      rot: [0, 0, angleZ],
    };
  }

  private check(c: Companion, now: number): void {
    const mp = this.mp;
    let dead = false;
    try {
      dead = mp.get(c.id, "isDead") === true;
    } catch {
      this.companions.delete(c.id);
      this.log(`CompanionSystem: ${hex(c.id)} of ${hex(c.ownerId)} is gone`);
      this.save();
      this.sendState(c.ownerId);
      return;
    }
    if (dead) return this.end(c, "died", true);
    if (c.expiresAt && now >= c.expiresAt) return this.end(c, "expired", false);
    if (userOf(mp, c.ownerId) < 0) {
      c.ownerAwaySince = c.ownerAwaySince || now;
      if (now - c.ownerAwaySince >= OWNER_GONE_MS) this.release(c);
      return;
    }
    c.ownerAwaySince = 0;
    if (KIND_RULES[c.kind].commanded && !isAlive(mp, c.ownerId)) return this.end(c, "owner died", false);
    if (!isNear(mp, c.id, c.ownerId, FOLLOW_TELEPORT_DISTANCE)) {
      const loc = this.locationNear(c.ownerId, FOLLOW_OFFSET);
      mp.set(c.id, "locationalData", loc);
      mp.set(c.id, "spawnPoint", loc);
    }
    if (c.targetId && !this.isValidTarget(c.ownerId, c.targetId, TARGET_KEEP_RANGE)) {
      c.targetId = 0;
      this.sendState(c.ownerId);
    }
  }

  private end(c: Companion, reason: string, died: boolean): void {
    const mp = this.mp;
    const rules = KIND_RULES[c.kind];
    this.companions.delete(c.id);
    this.log(`CompanionSystem: ${c.kind} ${hex(c.id)} of ${hex(c.ownerId)} ended (${reason})`);
    if (died || rules.dieOnEnd) {
      if (!rules.lootable) {
        try { mp.set(c.id, "inventory", { entries: [] }); } catch { }
      }
      if (!died) {
        try { mp.set(c.id, "isDead", true); } catch { }
      }
      if (c.ashPile) this.ashing.add(c.id);
      this.corpses.set(c.id, Date.now() + (c.ashPile ? ASH_DELAY_MS : (rules.corpseSec ?? this.corpseSec) * 1000));
    } else {
      try { mp.destroyActor(c.id); } catch { }
    }
    this.save();
    this.sendState(c.ownerId);
  }

  // The owner left: persistent companions wait for the next login, the rest end
  private release(c: Companion): void {
    if (!c.persistent) return this.end(c, "owner left", false);
    this.companions.delete(c.id);
    this.stored.push({ ownerId: c.ownerId, baseDesc: c.baseDesc, kind: c.kind });
    try { this.mp.destroyActor(c.id); } catch { }
    this.log(`CompanionSystem: ${hex(c.id)} stored until ${hex(c.ownerId)} logs in again`);
    this.save();
  }

  private onOwnerAssigned(ownerId: number): void {
    const waiting = this.stored.filter((s) => s.ownerId === ownerId);
    if (waiting.length) {
      this.stored = this.stored.filter((s) => s.ownerId !== ownerId);
      for (const s of waiting) {
        let baseId = 0;
        try { baseId = this.mp.getIdFromDesc(s.baseDesc) >>> 0; } catch { }
        if (baseId) this.spawn(ownerId, baseId, { kind: s.kind, persistent: true });
      }
      this.save();
    }
    this.sendState(ownerId);
  }

  private removeCorpses(now: number): void {
    let changed = false;
    for (const [id, at] of Array.from(this.corpses)) {
      if (now < at) continue;
      this.corpses.delete(id);
      changed = true;
      if (this.ashing.delete(id)) {
        // The ash pile, or the body when no pile could be placed, lasts as long as an NPC corpse
        this.corpses.set(this.turnToAsh(id) || id, now + this.corpseSec * 1000);
        continue;
      }
      try { destroyRef(this.mp, id); } catch { }
    }
    if (changed) this.save();
  }

  // The body becomes an ash pile container at its spot holding every item, so nothing is duplicated or lost; 0 when none was placed
  private turnToAsh(bodyId: number): number {
    const mp = this.mp;
    if (!this.ashPileDesc) return 0;
    let entries: Record<string, unknown>[];
    try { entries = looseEntries(mp.get(bodyId, "inventory")); } catch { return 0; }
    let pileId = 0;
    try {
      pileId = placeAtMe(mp, bodyId, this.ashPileDesc) >>> 0;
      mp.set(pileId, "inventory", { entries });
    } catch (e) {
      this.log(`CompanionSystem: ash pile for ${hex(bodyId)} failed, the body stays: ${e}`);
      if (pileId) {
        try { destroyRef(mp, pileId); } catch { }
      }
      return 0;
    }
    try { mp.set(bodyId, "inventory", { entries: [] }); } catch { }
    try { mp.destroyActor(bodyId); } catch { }
    this.log(`CompanionSystem: ${hex(bodyId)} turned to ash pile ${hex(pileId)} with ${entries.length} stack(s)`);
    return pileId;
  }

  // A CONT base as a desc ("c674b:Skyrim.esm") or a load-order id; empty when it is none, and reanimated bodies then stay
  private containerDesc(raw: unknown): string {
    const mp = this.mp;
    try {
      const desc = typeof raw === "string" && raw.includes(":") ? raw : mp.getDescFromId(toFormId(raw));
      if (mp.lookupEspmRecordById(mp.getIdFromDesc(desc))?.record?.type === "CONT") return desc;
    } catch { }
    this.log(`CompanionSystem: ash pile base ${String(raw)} is not a CONT record, reanimated bodies stay as corpses`);
    return "";
  }

  private sendState(ownerId: number): void {
    const user = userOf(this.mp, ownerId);
    if (user < 0) return;
    const companions = this.ownedBy(ownerId).map((c) => ({ id: c.id, target: c.targetId, kind: c.kind }));
    try { this.mp.sendCustomPacket(user, JSON.stringify({ customPacketType: "companionState", companions })); } catch { }
  }

  // Only the owner hosts a companion; companions never damage their owner or the owner's other companions; hits on an owner call defend
  private installHooks(): void {
    const mp = this.mp;
    const chain = (previous: ((...args: unknown[]) => unknown) | null, args: unknown[]): boolean => {
      if (!previous) return true;
      try {
        return previous.apply(mp, args) !== false;
      } catch {
        return true;
      }
    };

    const previousHost = typeof mp.onHostAttempt === "function" ? mp.onHostAttempt : null;
    mp.onHostAttempt = (requesterId: number, actorId: number): boolean => {
      const c = this.companions.get(actorId >>> 0);
      if (c) return requesterId >>> 0 === c.ownerId;
      return chain(previousHost, [requesterId, actorId]);
    };

    const previousHit = typeof mp.onHitDamageAttempt === "function" ? mp.onHitDamageAttempt : null;
    mp.onHitDamageAttempt = (aggressorId: number, targetId: number, sourceId: number, damage: number): boolean => {
      const aggressor = this.companions.get(aggressorId >>> 0);
      const targetOwner = this.companions.get(targetId >>> 0)?.ownerId ?? targetId >>> 0;
      if (aggressor && aggressor.ownerId === targetOwner) return false;
      try {
        this.defend(targetId >>> 0, aggressorId >>> 0);
      } catch (e) {
        this.log(`CompanionSystem: defend failed: ${e}`);
      }
      return chain(previousHit, [aggressorId, targetId, sourceId, damage]);
    };
  }

  // Companions from the previous run are removed once the world loads; persistent ones wait for their owner's next login
  private loadRegistry(): void {
    let saved: { active?: unknown; corpses?: unknown; stored?: unknown } = {};
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) ?? {}; } catch { }
    const isStored = (s: any): s is Stored =>
      !!s && typeof s.baseDesc === "string" && Number.isFinite(Number(s.ownerId)) && s.kind in KIND_RULES;
    const active = Array.isArray(saved.active) ? saved.active as Saved[] : [];
    const corpses = Array.isArray(saved.corpses) ? saved.corpses as number[] : [];
    this.stored = (Array.isArray(saved.stored) ? saved.stored : []).filter(isStored)
      .map((s: Stored) => ({ ownerId: Number(s.ownerId) >>> 0, baseDesc: s.baseDesc, kind: s.kind }));
    for (const a of active) {
      if (a?.persistent && isStored(a)) this.stored.push({ ownerId: Number(a.ownerId) >>> 0, baseDesc: a.baseDesc, kind: a.kind });
    }
    this.leftovers = active.map((a) => Number(a?.id) >>> 0).concat(corpses.map((id) => Number(id) >>> 0)).filter((id) => id > 0);
    if (this.leftovers.length || this.stored.length) {
      this.log(`CompanionSystem: ${this.leftovers.length} companion(s) from the previous run to remove, ${this.stored.length} persistent waiting for their owner`);
    }
    this.save();
  }

  // The world DB loads after every system's init (attachSaveStorage in index.ts), before anyone can place a form
  private removeLeftovers(): void {
    const ids = this.leftovers;
    if (!ids.length) return;
    this.leftovers = [];
    const removed = destroyLeftovers(this.mp, ids);
    this.log(`CompanionSystem: removed ${removed}/${ids.length} companion(s) from the previous run`);
    this.save();
  }

  private save(): void {
    const active: Saved[] = Array.from(this.companions.values())
      .map((c) => ({ id: c.id, ownerId: c.ownerId, baseDesc: c.baseDesc, kind: c.kind, persistent: c.persistent }));
    const registry = { active, corpses: Array.from(this.corpses.keys()).concat(this.leftovers), stored: this.stored };
    try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry)); }
    catch (e) { this.log(`CompanionSystem: ${REGISTRY_FILE} write failed: ${e}`); }
  }
}
