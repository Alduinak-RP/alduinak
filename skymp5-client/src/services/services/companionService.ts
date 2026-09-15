import { Actor, HitEvent, storage } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { WorldCleanerService } from "./worldCleanerService";
import { isRemoteHostedByMe, localIdToRemoteId, remoteIdToLocalId } from "../../view/worldViewMisc";

// Owner side of the server companion library (companionSystem.ts, docs/docs_roleplay_companions.md).
// The owner hosts its companions, so this engine's AI drives them: teammate setup, following, and combat with the server's target.

const COMPANION_IDS_KEY = "ownCompanionIds";
const DRIVEN_PET_IDS_KEY = "ownDrivenPetIds";
const PLAYER_ID = 0x14;
const PLAYER_FACTION = 0xdb1;
const TWIN_SOULS_PERK = 0xd5f1c;

interface CompanionEntry {
  id: number;
  target: number;
}

// Per local copy; a respawned copy gets a new local id and is set up again
interface LocalState {
  localId: number;
  following: boolean;
  // The heading offset of the last keep-offset call and when it was issued
  followAngle: number;
  followAt: number;
  fightingTarget: number;
}

const normalizeAngle = (deg: number): number => ((deg % 360) + 540) % 360 - 180;

export const isOwnCompanion = (remoteId: number | undefined): boolean => {
  const ids = storage[COMPANION_IDS_KEY];
  return remoteId !== undefined && Array.isArray(ids) && ids.includes(remoteId);
};

// Pets PetService steers itself: following dogs and fleeing pets
export const setDrivenPetIds = (ids: number[]): void => {
  storage[DRIVEN_PET_IDS_KEY] = ids;
};

// Own companions and steered pets keep the follow offset their service gives them
export const keepsOwnOffset = (remoteId: number | undefined): boolean => {
  const ids = storage[DRIVEN_PET_IDS_KEY];
  return isOwnCompanion(remoteId) || (remoteId !== undefined && Array.isArray(ids) && ids.includes(remoteId));
};

export class CompanionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("connectionAccepted", () => this.onConnectionAccepted());
    this.controller.on("hit", (e) => this.onHit(e));
    this.controller.on("update", () => this.onUpdate());
  }

  private onConnectionAccepted(): void {
    this.setCompanions([]);
    this.sentTwinSouls = false;
    this.lastPerkCheckMs = 0;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "companionState") {
      return;
    }
    const raw = Array.isArray(content["companions"]) ? content["companions"] as Record<string, unknown>[] : [];
    const list: CompanionEntry[] = raw
      .filter((x) => x && typeof x["id"] === "number")
      .map((x) => ({ id: x["id"] as number, target: typeof x["target"] === "number" ? x["target"] as number : 0 }));
    // A new companion stands in for the engine's own summon, which the world cleaner removes
    if (list.some((c) => !this.companions.some((old) => old.id === c.id))) {
      this.controller.lookupListener(WorldCleanerService).sweepBurst(CompanionService.cleanerBurstMs);
    }
    this.setCompanions(list);
  }

  private setCompanions(list: CompanionEntry[]): void {
    this.companions = list;
    storage[COMPANION_IDS_KEY] = list.map((c) => c.id);
    this.pruneLocal();
  }

  // Hosted NPCs of another service (PetService's dogs) that get the teammate setup and follow, never a server target
  setExtraFollowers(remoteIds: number[]): void {
    this.extraFollowers = remoteIds;
    this.pruneLocal();
  }

  private pruneLocal(): void {
    Array.from(this.local.keys()).forEach((id) => {
      if (!this.companions.some((c) => c.id === id) && !this.extraFollowers.includes(id)) {
        this.local.delete(id);
      }
    });
  }

  // The owner's hit with a weapon or a hostile spell is the attack order, as vanilla summons join the caster's fights
  private onHit(e: HitEvent): void {
    if (!this.companions.length || !e.aggressor || !e.target || e.aggressor.getFormID() !== PLAYER_ID) {
      return;
    }
    const target = this.sp.Actor.from(e.target);
    if (!target || target.getFormID() === PLAYER_ID || target.isDead() || !this.isHostileSource(e)) {
      return;
    }
    const targetId = localIdToRemoteId(target.getFormID());
    if (!targetId || isOwnCompanion(targetId)) {
      return;
    }
    const now = Date.now();
    if (targetId === this.lastOrderTarget && now - this.lastOrderMs < CompanionService.orderRepeatMs) {
      return;
    }
    this.lastOrderTarget = targetId;
    this.lastOrderMs = now;
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "attack", targetId });
  }

  private isHostileSource(e: HitEvent): boolean {
    if (this.sp.Weapon.from(e.source)) {
      return true;
    }
    const spell = this.sp.Spell.from(e.source);
    if (spell) {
      return spell.isHostile();
    }
    const scroll = this.sp.Scroll.from(e.source);
    if (!scroll) {
      return false;
    }
    for (let i = 0; i < scroll.getNumEffects(); i++) {
      if (scroll.getNthEffectMagicEffect(i)?.isEffectFlagSet(CompanionService.hostileEffectFlag)) {
        return true;
      }
    }
    return false;
  }

  private onUpdate(): void {
    const now = Date.now();
    this.reportPerks(now);
    if ((!this.companions.length && !this.extraFollowers.length) || now - this.lastApplyMs < CompanionService.applyIntervalMs) {
      return;
    }
    this.lastApplyMs = now;
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    for (const c of this.companions) {
      this.drive(c.id, c.target, player);
    }
    for (const id of this.extraFollowers) {
      this.drive(id, 0, player);
    }
  }

  private drive(remoteId: number, targetId: number, player: Actor): void {
    if (!isRemoteHostedByMe(remoteId)) {
      return;
    }
    const actor = this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(remoteId)));
    if (!actor || actor.isDead() || !actor.is3DLoaded()) {
      return;
    }
    const state = this.stateFor(remoteId, actor);
    const target = targetId ? this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(targetId))) : null;
    if (target && !target.isDead()) {
      this.fight(actor, target, state);
    } else {
      this.follow(actor, player, state);
    }
  }

  private stateFor(remoteId: number, actor: Actor): LocalState {
    let state = this.local.get(remoteId);
    if (!state || state.localId !== actor.getFormID()) {
      state = { localId: actor.getFormID(), following: false, followAngle: 0, followAt: 0, fightingTarget: 0 };
      this.local.set(remoteId, state);
      this.prepare(actor);
    }
    return state;
  }

  // A teammate in the player faction instead of its own factions, so it is never hostile to the owner and only attacks enemies unprovoked.
  // Assistance 2 joins the owner's fights instead of waiting to be attacked; Confidence 4 never flees; favors allow the command mode
  private prepare(actor: Actor): void {
    actor.removeFromAllFactions();
    const faction = this.sp.Faction.from(this.sp.Game.getFormEx(PLAYER_FACTION));
    if (faction) {
      actor.setFactionRank(faction, 0);
    }
    actor.setPlayerTeammate(true, true);
    actor.ignoreFriendlyHits(true);
    actor.setActorValue("Aggression", 1);
    actor.setActorValue("Assistance", 2);
    actor.setActorValue("Confidence", 4);
  }

  private fight(actor: Actor, target: Actor, state: LocalState): void {
    this.stopFollowing(actor, state);
    state.fightingTarget = target.getFormID();
    if (actor.getCombatTarget()?.getFormID() !== state.fightingTarget) {
      actor.startCombat(target);
    }
  }

  private follow(actor: Actor, player: Actor, state: LocalState): void {
    // The order ended (target dead, gone or recalled): leave that fight, not one the engine picked itself
    if (state.fightingTarget) {
      if (actor.getCombatTarget()?.getFormID() === state.fightingTarget) {
        actor.stopCombat();
      }
      state.fightingTarget = 0;
    }
    // A fight of its own and the vanilla command mode both own the copy's AI
    if (actor.isInCombat() || actor.isDoingFavor()) {
      this.stopFollowing(actor, state);
      return;
    }
    const angle = this.followAngle(actor, player);
    const now = Date.now();
    // Re-issued on a real turn or every couple of seconds, because the first formView apply and a respawn overwrite it
    if (state.following
      && Math.abs(normalizeAngle(angle - state.followAngle)) < CompanionService.followAngleStep
      && now - state.followAt < CompanionService.followReassertMs) {
      return;
    }
    actor.keepOffsetFromActor(player, 0, CompanionService.followOffsetY, 0, 0, 0, angle,
      CompanionService.catchUpRadius, CompanionService.followRadius);
    state.following = true;
    state.followAngle = angle;
    state.followAt = now;
  }

  // Heading toward the follow point so the follower walks forward; 0 once it is there, which settles it facing the owner's way
  private followAngle(actor: Actor, player: Actor): number {
    const heading = player.getAngleZ();
    const rad = (heading * Math.PI) / 180;
    const dx = player.getPositionX() + CompanionService.followOffsetY * Math.sin(rad) - actor.getPositionX();
    const dy = player.getPositionY() + CompanionService.followOffsetY * Math.cos(rad) - actor.getPositionY();
    if (dx * dx + dy * dy <= CompanionService.followRadius * CompanionService.followRadius) {
      return 0;
    }
    return normalizeAngle((Math.atan2(dx, dy) * 180) / Math.PI - heading);
  }

  private stopFollowing(actor: Actor, state: LocalState): void {
    if (!state.following) return;
    actor.clearKeepOffsetFromActor();
    state.following = false;
  }

  // Twin Souls raises the summon limit to two; the server only keeps the flag for a character in game, so it is repeated while true
  private reportPerks(now: number): void {
    if (now - this.lastPerkCheckMs < CompanionService.perkCheckMs) {
      return;
    }
    this.lastPerkCheckMs = now;
    const player = this.sp.Game.getPlayer();
    const perk = this.sp.Perk.from(this.sp.Game.getFormEx(TWIN_SOULS_PERK));
    const twinSouls = !!player && !!perk && player.hasPerk(perk);
    if (!twinSouls && !this.sentTwinSouls) {
      return;
    }
    this.sentTwinSouls = twinSouls;
    sendCustomPacket(this.controller, { customPacketType: "companionCommand", action: "perks", twinSouls });
  }

  private companions: CompanionEntry[] = [];
  private extraFollowers: number[] = [];
  private local = new Map<number, LocalState>();
  private lastApplyMs = 0;
  private lastOrderTarget = 0;
  private lastOrderMs = 0;
  private lastPerkCheckMs = 0;
  private sentTwinSouls = false;

  private static readonly applyIntervalMs = 250;
  private static readonly orderRepeatMs = 2000;
  private static readonly cleanerBurstMs = 3000;
  private static readonly perkCheckMs = 10000;
  private static readonly followOffsetY = -128;
  // Farther than catchUpRadius it runs to the owner; nearer it walks, so a large value left it standing or plodding
  private static readonly catchUpRadius = 256;
  private static readonly followRadius = 128;
  // Below this turn the offset is left alone, or the follower hunts its heading every tick
  private static readonly followAngleStep = 20;
  private static readonly followReassertMs = 2000;
  private static readonly hostileEffectFlag = 0x1;
}
