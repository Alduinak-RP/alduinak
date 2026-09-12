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
  fightingTarget: number;
}

export const isOwnCompanion = (remoteId: number | undefined): boolean => {
  const ids = storage[COMPANION_IDS_KEY];
  return remoteId !== undefined && Array.isArray(ids) && ids.includes(remoteId);
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
    Array.from(this.local.keys()).forEach((id) => {
      if (!list.some((c) => c.id === id)) {
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
    if (!this.companions.length || now - this.lastApplyMs < CompanionService.applyIntervalMs) {
      return;
    }
    this.lastApplyMs = now;
    const player = this.sp.Game.getPlayer();
    if (!player) {
      return;
    }
    for (const c of this.companions) {
      if (!isRemoteHostedByMe(c.id)) {
        continue;
      }
      const actor = this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(c.id)));
      if (!actor || actor.isDead() || !actor.is3DLoaded()) {
        continue;
      }
      const state = this.stateFor(c.id, actor);
      const target = c.target ? this.sp.Actor.from(this.sp.Game.getFormEx(remoteIdToLocalId(c.target))) : null;
      if (target && !target.isDead()) {
        this.fight(actor, target, state);
      } else {
        this.follow(actor, player, state);
      }
    }
  }

  private stateFor(remoteId: number, actor: Actor): LocalState {
    let state = this.local.get(remoteId);
    if (!state || state.localId !== actor.getFormID()) {
      state = { localId: actor.getFormID(), following: false, fightingTarget: 0 };
      this.local.set(remoteId, state);
      this.prepare(actor);
    }
    return state;
  }

  // A teammate in the player faction instead of its own factions, so it is never hostile to the owner and only attacks enemies unprovoked
  private prepare(actor: Actor): void {
    actor.removeFromAllFactions();
    const faction = this.sp.Faction.from(this.sp.Game.getFormEx(PLAYER_FACTION));
    if (faction) {
      actor.setFactionRank(faction, 0);
    }
    actor.setPlayerTeammate(true, false);
    actor.ignoreFriendlyHits(true);
    actor.setActorValue("Aggression", 1);
  }

  private fight(actor: Actor, target: Actor, state: LocalState): void {
    if (state.following) {
      actor.clearKeepOffsetFromActor();
      state.following = false;
    }
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
    if (actor.isInCombat()) {
      if (state.following) {
        actor.clearKeepOffsetFromActor();
        state.following = false;
      }
      return;
    }
    if (!state.following) {
      actor.keepOffsetFromActor(player, 0, CompanionService.followOffsetY, 0, 0, 0, 0,
        CompanionService.catchUpRadius, CompanionService.followRadius);
      state.following = true;
    }
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
  private static readonly catchUpRadius = 512;
  private static readonly followRadius = 128;
  private static readonly hostileEffectFlag = 0x1;
}
