/* eslint-disable @typescript-eslint/no-empty-function */
import {
  ObjectReference,
  Debug,
  hooks,
  Actor,
  printConsole,
  Utility,
  Game,
  once,
  SendAnimationEventHook,
  // @ts-expect-error (TODO: Remove in 2.10.0)
  setCollision
} from "skyrimPlatform";
import { Movement } from "./movement";
import { applyWeapDrawn } from "./movementApply";
import { isRiderClone } from "./mountApply";
import { logToPlatformLog } from "../logging";

export enum AnimationEventName {
  Ragdoll = "Ragdoll",
  GetUpBegin = "GetUpBegin",
};

export interface Animation {
  animEventName: string;
  numChanges: number;
}

export interface AnimationApplyState {
  lastNumChanges: number;
  useAnimOverrides: boolean;
}

// Sheathing is polled every 0.2 s for about 3 s
export const SHEATHE_POLL_S = 0.2;
export const SHEATHE_MAX_POLLS = 15;
// The sheathe animation still blends out after the weapon state reads sheathed
export const SHEATHE_SETTLE_S = 0.3;

interface PendingIdle {
  count: number;
  expiresAt: number;
}

// Idles the sync sent to a copy, by local id and event name; a send the graph never reports lapses
const allowedIdles = new Map<number, Map<string, PendingIdle>>();
const ALLOWED_IDLE_TTL_MS = 5000;
let nextAllowedIdleSweep = 0;

const allowIdle = (refrId: number, animEventName: string): void => {
  const now = Date.now();
  if (now >= nextAllowedIdleSweep) {
    nextAllowedIdleSweep = now + ALLOWED_IDLE_TTL_MS;
    allowedIdles.forEach((idles, id) => {
      idles.forEach((idle, name) => idle.expiresAt <= now && idles.delete(name));
      if (idles.size === 0) allowedIdles.delete(id);
    });
  }
  let idles = allowedIdles.get(refrId);
  if (!idles) {
    idles = new Map();
    allowedIdles.set(refrId, idles);
  }
  const idle = idles.get(animEventName);
  if (idle && idle.expiresAt > now) {
    idle.count++;
    idle.expiresAt = now + ALLOWED_IDLE_TTL_MS;
  } else {
    idles.set(animEventName, { count: 1, expiresAt: now + ALLOWED_IDLE_TTL_MS });
  }
};

const consumeAllowedIdle = (refrId: number, animEventName: string): boolean => {
  const idles = allowedIdles.get(refrId);
  const idle = idles?.get(animEventName);
  if (!idles || !idle) {
    return false;
  }
  const allowed = idle.expiresAt > Date.now();
  if (!allowed || --idle.count === 0) {
    idles.delete(animEventName);
    if (idles.size === 0) allowedIdles.delete(refrId);
  }
  return allowed;
};

const refsWithDefaultAnimsDisabled = new Set<number>();
const allowedAnims = new Set<string>();
// A copy's graph starts with staggerMagnitude 0, which would make a relayed stagger invisible
const STAGGER_ANIM = "staggerStart";
const RELAYED_STAGGER_MAGNITUDE = 0.5;

// Whether the sync itself sent this event to the copy; consumed, so a phantom event of the same name stays blocked
export const consumeAllowedAnim = (refrId: number, animEventName: string): boolean =>
  allowedAnims.delete(refrId + ":" + animEventName);
// Refs whose collision a sit animation turned off
const sitCollisionDisabled = new Set<number>();
// Refs a synced ground pose left posed; exits, get-ups, IdleStop, draws, attacks and jumps clear it
const idlePosed = new Set<number>();
// Emote wheel ground poses and the server's default logoutPose; they loop until an exit
const groundPosesLowerCase = new Set<string>([
  'idlesitcrossleggedenter',
  'idlekneelingenter',
  'idlewounded_03',
  'idlewarmhandscrouched',
  'idlecowerenter',
]);

// Called with every event that reaches a copy's graph, after any override
export type SendToGraphHook = (refr: ObjectReference, animEventName: string) => void;
const sendToGraphHooks: SendToGraphHook[] = [];
export const addSendToGraphHook = (hook: SendToGraphHook): void => {
  sendToGraphHooks.push(hook);
};

const actorSitAnimsLowerCase = [
  'idlestoolenterplayer',
  'idlestoolenter',
  'idlestoolenterinstant',
  'idlechairrightenter',
  'idlechairleftenter',
  'idlechairfrontenter',
  'idlechairenterinstant',
  'idlejarlchairenter',
  'idlejarlchairenterinstant',
  'idlesnowelfprincechairdialogue',
  'idlesnowelfprincechairenter',
  'idlesnowelfprincechairenterinstant',
  'idlechairchildenterinstant',
  'idlechairchildfrontenter',
  'idlechairchildleftenter',
  'idlechairchildrightenter',
  // A carriedAnimEvent override: its copies turn by setAngle and drop collision like a seated one
  'idlelaydown',
];

const actorGetUpAnimsLowerCase = [
  'idlestoolbackexit',
  'idlechairrightexit',
  'idlechairrightquickexit',
  'idlechairleftexit',
  'idlechairleftquickexit',
  'idlechairfrontexit',
  'idlechairfrontquickexit',
  'idlechairchildfrontexit',
  'idlechairchildleftexit',
  'idlechairchildrightexit',
  'idleforcedefaultstate'
];

// Bound, carried, carry-hold and bleedout poses; the carrier's own client sheathes before its pose
const restraintPosesLowerCase = new Set<string>([
  'offsetboundstandingstart',
  'offsetcarrybasketstart',
  'idlechairenterinstant',
  'idlelaydown',
  'bleedoutstart',
  'bleedoutstop',
]);

// It's critical for values to be the correct case, not just lowercase, otherwise 'allowedIdles' check will break
// We don't want to modify the check itself, because it'll be slower
const animOverridesLowerCase: Record<string, string | undefined> = {
  'idlechairbook_onepage': 'IdleChairEnterInstant',
  'idlechairshoulderflex': 'IdleChairEnterInstant',
  'idlechairwrite': 'IdleChairEnterInstant',
  'idlechairarmscrossedvar1': 'IdleChairEnterInstant',
  'chaireatingstart_vampiremeat': 'IdleChairEnterInstant',
  'chairreadingstart': 'IdleChairEnterInstant',
  'chairvampireeatingstart': 'IdleChairEnterInstant',
  'chairdrinkingstart': 'IdleChairEnterInstant',
  'chaireatingstart': 'IdleChairEnterInstant',

  // The only triple animation we know for now. One base anim to sit, then two to eat
  'chaireatingsoupstart': 'IdleChairEnterInstant',
  'idleeatsoup': 'IdleChairEnterInstant',

  // No need to re-play the animation, use instant variant for spawning actors
  // This is not essential, but makes the sync feel more smooth. The list is not complete.
  'idlechairrightenter': 'IdleChairEnterInstant',
  'idlechairleftenter': 'IdleChairEnterInstant',
  'idlechairfrontenter': 'IdleChairEnterInstant',

  // Untested yet looks correct
  'idlesnowelfprincefireandforget': 'IdleSnowElfPrinceChairEnterInstant',
  'idletablemugenter': 'IdleTableEnterInstant',
  'idletabledrinkenter': 'IdleTableEnterInstant',
  'idletabledrinkandmugenter': 'IdleTableEnterInstant'
};

// unclassified:

// IdleChairEnterInstant
// IdleChairEnterStart
// IdleChairEnterStop
// IdleChairEnterToSit
// IdleChairExitStart
// IdleChairExitToStand
// IdleChairSitting
// IdleLeftChairEnterStart
// ChairIdle
// IdleRightChairEnterStart
// IdleLeftChairEnterStart

const isIdle = (animEventName: string) => {
  const animEventNameLowerCase = animEventName.toLowerCase();
  return (
    animEventNameLowerCase === "motiondrivenidle" ||
    (animEventNameLowerCase.startsWith("idle") &&
      animEventNameLowerCase !== "idlestop" &&
      animEventNameLowerCase !== "idleforcedefaultstate")
  );
};

// Exits, get-ups and restraint poses never wait, or a copy stays posed after its player moved on
export const needsEmptyHands = (animEventName: string): boolean => {
  const animEventNameLowerCase = animEventName.toLowerCase();
  if (
    animEventNameLowerCase.includes("exit") ||
    actorGetUpAnimsLowerCase.includes(animEventNameLowerCase) ||
    restraintPosesLowerCase.has(animEventNameLowerCase)
  ) {
    return false;
  }
  return isIdle(animEventName) || (forcedSyncAnims.has(animEventName) && animEventName !== "OffsetStop");
};

// Null once a newer event replaced the waiting one or the copy can no longer take it
const findWaitingActor = (refrId: number, anim: Animation, state: AnimationApplyState): Actor | null => {
  if (state.lastNumChanges !== anim.numChanges || isRiderClone(refrId)) {
    return null;
  }
  const ac = Actor.from(Game.getFormEx(refrId));
  return ac && ac.is3DLoaded() && !ac.isDead() ? ac : null;
};

// A copy still drawn when the polls run out plays the event anyway to stay in step with its player
const playAfterSheathe = (refrId: number, anim: Animation, state: AnimationApplyState, polls: number): void => {
  Utility.wait(SHEATHE_POLL_S).then(() => {
    const ac = findWaitingActor(refrId, anim, state);
    if (!ac) {
      return;
    }
    if (!ac.isWeaponDrawn()) {
      Utility.wait(SHEATHE_SETTLE_S).then(() => {
        const settled = findWaitingActor(refrId, anim, state);
        if (settled) {
          sendToGraph(settled, anim);
        }
      });
    } else if (polls + 1 < SHEATHE_MAX_POLLS) {
      playAfterSheathe(refrId, anim, state, polls + 1);
    } else {
      sendToGraph(ac, anim);
    }
  });
};

export const applyAnimation = (
  refr: ObjectReference,
  anim: Animation,
  state: AnimationApplyState,
  mounted?: boolean,
  sheatheFirst?: boolean
): void => {
  if (state.lastNumChanges === anim.numChanges) {
    return;
  }
  state.lastNumChanges = anim.numChanges;

  // The engine owns a riding clone's graph; a replayed event would walk it off the horse it is seated on or carried by
  if (mounted) {
    return;
  }

  if (state.useAnimOverrides) {
    const animOverride = animOverridesLowerCase[anim.animEventName.toLowerCase()];
    if (animOverride !== undefined) {
      anim.animEventName = animOverride;
    }
  }

  const ac = Actor.from(refr);

  if (anim.animEventName === "SkympFakeEquip") {
    idlePosed.delete(refr.getFormID());
    if (ac) {
      applyWeapDrawn(ac, true);
    }
    return;
  }

  if (anim.animEventName === "SkympFakeUnequip") {
    if (ac) {
      applyWeapDrawn(ac, false);
    }
    return;
  }

  if (anim.animEventName === "Ragdoll") {
    if (ac) {
      ac.pushActorAway(ac, 0);
      ac.setActorValue("Variable10", -1000);
    }
    return;
  }

  // A player's copy sheathes before an idle or pose, as its player did
  if (ac && sheatheFirst && ac.isWeaponDrawn() && needsEmptyHands(anim.animEventName)) {
    applyWeapDrawn(ac, false);
    playAfterSheathe(ac.getFormID(), { ...anim }, state, 0);
    return;
  }

  sendToGraph(refr, anim);
};

const sendToGraph = (refr: ObjectReference, anim: Animation): void => {
  const animEventNameLowerCase = anim.animEventName.toLowerCase();

  if (isIdle(anim.animEventName)) {
    allowIdle(refr.getFormID(), anim.animEventName);
  }

  if (refsWithDefaultAnimsDisabled.has(refr.getFormID())) {
    if (animEventNameLowerCase.includes("attack")) {
      allowedAnims.add(refr.getFormID() + ":" + anim.animEventName);
    }
  }

  // DeathService blanks every other stagger on a copy
  if (anim.animEventName === STAGGER_ANIM) {
    allowedAnims.add(refr.getFormID() + ":" + STAGGER_ANIM);
    Actor.from(refr)?.setAnimationVariableFloat("staggerMagnitude", RELAYED_STAGGER_MAGNITUDE);
  }

  Debug.sendAnimationEvent(refr, anim.animEventName);

  if (anim.animEventName === "GetUpBegin") {
    const refrId = refr.getFormID();
    Utility.wait(1).then(() => {
      const ac = Actor.from(Game.getFormEx(refrId));
      if (ac) {
        ac.setActorValue("Variable10", 1000);
      }
    });
  }

  if (actorSitAnimsLowerCase.find((x) => x === animEventNameLowerCase) !== undefined) {
    setCollision(refr.getFormID(), false);
    sitCollisionDisabled.add(refr.getFormID());
  }

  const isGetUp = actorGetUpAnimsLowerCase.find((x) => x === animEventNameLowerCase) !== undefined;
  if (isGetUp) {
    setCollision(refr.getFormID(), true);
    sitCollisionDisabled.delete(refr.getFormID());
  }

  if (
    isGetUp ||
    animEventNameLowerCase === "idlestop" ||
    animEventNameLowerCase.includes("exit") ||
    animEventNameLowerCase.includes("attack") ||
    animEventNameLowerCase.includes("jump")
  ) {
    idlePosed.delete(refr.getFormID());
  } else if (groundPosesLowerCase.has(animEventNameLowerCase)) {
    idlePosed.add(refr.getFormID());
  }

  for (const hook of sendToGraphHooks) {
    try {
      hook(refr, anim.animEventName);
    } catch (e) {
      printConsole(`sendToGraph hook failed: ${e}`);
    }
  }
};

// For a service that poses a copy itself: an idle that does not come through the sync is blocked on a copy
export const playOnCopy = (refr: ObjectReference, animEventName: string): void => sendToGraph(refr, { animEventName, numChanges: 0 });

export const isInSitPose = (refrId: number): boolean => sitCollisionDisabled.has(refrId);

export const setRefrCollision = (refrId: number, collision: boolean): void => {
  setCollision(refrId, collision);
};

// When a posed or engine-seated copy first moved, so a pose that is still settling is not stood up
const posedMovingSince = new Map<number, number>();

// Animation sync is unreliable and single-slot, so a lost get-up must not leave a walking clone posed or without collision
export const restoreSitCollisionIfMoving = (refr: ObjectReference, m: Movement): void => {
  const refrId = refr.getFormID();
  // IdleForceDefaultState is a global wildcard into the sheathed branch, so a drawn copy is never reset
  if (m.isWeapDrawn) {
    idlePosed.delete(refrId);
    posedMovingSince.delete(refrId);
    if (m.runMode !== "Standing" && sitCollisionDisabled.delete(refrId)) {
      setCollision(refrId, true);
    }
    return;
  }
  const posed = idlePosed.has(refrId) || sitCollisionDisabled.has(refrId) || (Actor.from(refr)?.getSitState() ?? 0) >= 2;
  if (m.runMode === "Standing" || !posed) {
    posedMovingSince.delete(refrId);
    return;
  }
  const now = Date.now();
  const since = posedMovingSince.get(refrId);
  if (since === undefined) {
    posedMovingSince.set(refrId, now);
  } else if (now - since > 2000) {
    posedMovingSince.delete(refrId);
    sendToGraph(refr, { animEventName: "IdleForceDefaultState", numChanges: 0 });
  }
};

// A bow draw or release or a crossbow shot, which a copy's graph turns into its own arrow or bolt
const shotEventsLowerCase = new Set<string>(["bowattackstart", "attackrelease", "crossbowattackstart"]);

export const isShotEvent = (animEventName: string): boolean => shotEventsLowerCase.has(animEventName.toLowerCase());

// Get-ups and forced poses are single-slot on the receiver, a lost one leaves a copy posed
export const needsReliableSend = (animEventName: string): boolean =>
  actorGetUpAnimsLowerCase.includes(animEventName.toLowerCase()) || forcedSyncAnims.has(animEventName);

export const setDefaultAnimsDisabled = (
  refrId: number,
  disabled: boolean
): void => {
  if (disabled) {
    refsWithDefaultAnimsDisabled.add(refrId);
  } else {
    refsWithDefaultAnimsDisabled.delete(refrId);
  }
};

export class AnimationSource {
  // 0 for the player
  constructor(readonly remoteId: number) { }

  // The last animation the sender passed on
  lastSent?: Animation;

  getAnimation(): Animation {
    const { numChanges, animEventName } = this;
    return { numChanges, animEventName };
  }

  // Counts every event not ignored, sneaks included, so a movement report can follow it
  getNumEvents(): number {
    return this.numEvents;
  }

  // For events the send hook does not report, such as a sheathe started by a script
  relay(animEventName: string): void {
    this.onSendAnimationEvent(animEventName);
  }

  private onSendAnimationEvent(animEventName: string) {
    if (ignoredAnims.has(animEventName)) {
      return;
    }
    this.numEvents++;
    const lower = animEventName.toLowerCase();
    // Half of a paired idle replayed alone on a copy has no partner; PairedIdleService plays both halves everywhere
    if (lower.startsWith("pa_")) {
      return;
    }

    const isTorchEvent = lower.includes("torch");
    if (lower.includes("unequip") && !isTorchEvent) {
      animEventName = "SkympFakeUnequip";
    } else if (lower.includes("equip") && !isTorchEvent) {
      animEventName = "SkympFakeEquip";
    }

    // Sneaking reaches copies through movement
    if (animEventName === "SneakStart" || animEventName === "SneakStop") {
      return;
    }

    this.numChanges++;
    this.animEventName = animEventName;
  }

  private numChanges = 0;
  private numEvents = 0;
  private animEventName = "";
}

const ignoredAnims = new Set<string>([
  "moveStart",
  "moveStop",
  "turnStop",
  "CyclicCrossBlend",
  "CyclicFreeze",
  "TurnLeft",
  "TurnRight",
]);

// Offset/overlay animations (carry, bound hands, ...) report
// animationSucceeded === false but still need to be synced to other clients so
// remote players see the pose. See carryAnimSystem.ts in the gamemode for the
// carry case; bound-hands (arrest) and the bleedout kneel reuse the same mechanism.
const forcedSyncAnims = new Set<string>([
  "OffsetCarryBasketStart",
  "OffsetCarryLogStart",
  "OffsetBoundStandingStart",
  "OffsetArmsCrossedStart",
  "OffsetStop",
  "bleedOutStart",
  "bleedOutStop",
]);

// The player's source lasts the whole session
export const playerAnimationSource = new AnimationSource(0);
// Hosted copies' sources by local id
const copyAnimationSources = new Map<number, AnimationSource>();

// A copy whose local id changed, or a local id another hosted actor took over, gets a fresh source
export const getCopyAnimationSource = (localId: number, remoteId: number): AnimationSource => {
  let source = copyAnimationSources.get(localId);
  if (!source || source.remoteId !== remoteId) {
    disposeCopyAnimationSources(remoteId);
    source = new AnimationSource(remoteId);
    copyAnimationSources.set(localId, source);
  }
  return source;
};

// Without a remote id, every copy's source
export const disposeCopyAnimationSources = (remoteId?: number): void => {
  copyAnimationSources.forEach((source, localId) => {
    if (remoteId === undefined || source.remoteId === remoteId) copyAnimationSources.delete(localId);
  });
};

// Called inside the hook with every event sent to the player's graph, so natives are not safe there
export type PlayerAnimationListener = (animEventName: string) => void;
const playerAnimationListeners: PlayerAnimationListener[] = [];
export const addPlayerAnimationListener = (listener: PlayerAnimationListener): void => {
  playerAnimationListeners.push(listener);
};

// Offset overlays report failure but still sync; see carryAnimSystem.ts in the gamemode
const feedSource = (source: AnimationSource | undefined, ctx: SendAnimationEventHook.LeaveContext): void => {
  if (source && (ctx.animationSucceeded || forcedSyncAnims.has(ctx.animEventName))) {
    source.relay(ctx.animEventName);
  }
};

// Adding a hook throws while any thread is inside one, so a refused add is retried next tick
const addAnimationHook = (handler: SendAnimationEventHook.Handler, minSelfId: number, maxSelfId: number, retry = false): void => {
  try {
    hooks.sendAnimationEvent.add(handler, minSelfId, maxSelfId);
  } catch (e) {
    if (!retry) logToPlatformLog("AnimationHooks", `sendAnimationEvent hook refused, retrying: ${e}`);
    once("tick", () => addAnimationHook(handler, minSelfId, maxSelfId, true));
  }
};

let hooksAdded = false;

// Call after every service has added its own hooks, so the sources see the final event names
export const setupHooks = (): void => {
  if (hooksAdded) {
    return;
  }
  hooksAdded = true;

  addAnimationHook({
    enter: (ctx) => {
      // ShowRaceMenu forces this anim
      if (ctx.animEventName === "OffsetBoundStandingPlayerInstant") {
        ctx.animEventName = "";
      }
    },
    leave: (ctx) => {
      feedSource(playerAnimationSource, ctx);
      playerAnimationListeners.forEach((listener) => listener(ctx.animEventName));
    },
  }, 0x14, 0x14);

  addAnimationHook({
    enter: (ctx) => {
      if (refsWithDefaultAnimsDisabled.has(ctx.selfId)) {
        if (ctx.animEventName.toLowerCase().includes("attack")) {
          const animKey = ctx.selfId + ":" + ctx.animEventName;
          if (allowedAnims.has(animKey)) {
            allowedAnims.delete(animKey);
          } else {
            return (ctx.animEventName = "");
          }
        }
      }

      // The engine drives the idles of a seated rider clone
      if (isRiderClone(ctx.selfId)) {
        return;
      }
      if (isIdle(ctx.animEventName) && !consumeAllowedIdle(ctx.selfId, ctx.animEventName)) {
        ctx.animEventName = "";
      }
    },
    leave: (ctx) => feedSource(copyAnimationSources.get(ctx.selfId), ctx),
  }, 0xff000000, 0xffffffff);
};
