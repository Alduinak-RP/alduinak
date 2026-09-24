import { ClientListener, CombinedController, Sp } from "./clientListener";
import { notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked, isGameInputBlocked, buttonEventKeyCode, domKeyCode, armHeldMenu, claimHeldMenu } from "./widgetMenuUtil";
import { RestraintService } from "./restraintService";
import { SendInputsService } from "./sendInputsService";
import { getPcInventory } from "./remoteServer";
import { SHEATHE_MAX_POLLS, SHEATHE_POLL_S, SHEATHE_SETTLE_S } from "../../sync/animation";
import { formIdFromDesc } from "../../view/worldViewMisc";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode, Inventory } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// Mirrors holdMode for the widget setter, which runs in the browser with injected vars only
let wheelHold = false;
const WIDGET_ID = 24;

// An idle played in first person loses the character's collision, so an emote keeps the camera in third person
const FIRST_PERSON_CAMERA = 0;
const CAMERA_TICK_MS = 250;
// Master graph variable set while an idle plays
const IDLE_PLAYING_VAR = "bIdlePlaying";
// Checks the idle must stay gone before the emote counts as over, so a switch between an idle's stages is not its end
const IDLE_END_TICKS = 2;
// An idle never seen playing this long after it was sent was refused by the graph
const IDLE_START_MS = 2000;

// An item the emote shows in hand; any one of the "hex:Plugin" items unlocks it
interface PropNeed {
  label: string;
  items: string[];
}

const PROPS: Record<string, PropNeed> = {
  lute: { label: "a lute", items: ["dabab:Skyrim.esm", "a8a0e:City of Dawnstar.esp"] },
  flute: { label: "a flute", items: ["daba7:Skyrim.esm", "105177:Skyrim.esm", "105109:Skyrim.esm"] },
  drum: { label: "a drum", items: ["daba9:Skyrim.esm"] },
  broom: { label: "a broom", items: ["6717f:Skyrim.esm"] },
  // The plugin's own hoe, pinned to 0x2100 by proficiency-patcher/spec.json
  hoe: { label: "a hoe", items: ["2100:AlduinakAdditions.esp"] },
  imperialHorn: { label: "an Imperial war horn", items: ["200ba:Skyrim.esm"] },
  // Nord War Horn, Torygg's War Horn, Vrage's Horn
  nordHorn: { label: "a Nord war horn", items: ["200b6:Skyrim.esm", "e77bb:Skyrim.esm", "1252be:WindhelmSSE.esp"] },
};

interface EmoteDef {
  anim: string;
  label: string;
  // Idle loads an anim object (hoe, book, instrument) into the hand
  prop?: boolean;
  needs?: PropNeed;
}

interface EmoteGroup {
  id: string;
  label: string;
  emotes: EmoteDef[];
}

// Vanilla idle catalog ported from Vengeful Realms' emote wheel, used with permission.
const GROUPS: EmoteGroup[] = [
  {
    id: 'greetings',
    label: 'Greetings',
    emotes: [
      { anim: 'IdleWave', label: 'Wave' },
      { anim: 'IdleCivilWarCheer', label: 'War Cheer' },
      { anim: 'IdleSalute', label: 'Salute' },
      { anim: 'IdleSilentBow', label: 'Silent Bow' },
      { anim: 'IdleGetAttention', label: 'Get Attention' },
      { anim: 'IdleLookFar', label: 'Look Far' },
      { anim: 'IdleMT_DoorBang', label: 'Knock Door' },
    ],
  },
  {
    id: 'reactions',
    label: 'Reactions',
    emotes: [
      { anim: 'IdleApplaud2', label: 'Clapping' },
      { anim: 'IdleApplaud4', label: 'Applaud' },
      { anim: 'IdleApplaud5', label: 'Clapping Overhead' },
      { anim: 'IdleLaugh', label: 'Laugh' },
      { anim: 'IdleSurrender', label: 'Surrender' },
      { anim: 'IdleCowerEnter', label: 'Scared' },
      { anim: 'IdleWipeBrow', label: 'Wipe Brow' },
      { anim: 'IdleWounded_02', label: 'Wounded' },
    ],
  },
  {
    id: 'stances',
    label: 'Stances',
    emotes: [
      { anim: 'IdleLayDown', label: 'Lay Down' },
      { anim: 'IdleWarmHandsStanding', label: 'Warm Hands' },
      { anim: 'IdleWarmHandsCrouched', label: 'Warm Hands (Sit)' },
      { anim: 'IdleGrave_01', label: 'Pray' },
      { anim: 'IdlePray', label: 'Worship' },
      { anim: 'IdleSitCrossLeggedEnter', label: 'Sit Crossed' },
      { anim: 'IdleKneelingEnter', label: 'Kneel' },
      { anim: 'IdleWounded_03', label: 'Sit Lazy' },
    ],
  },
  {
    id: 'dialog',
    label: 'Dialog',
    emotes: [
      { anim: 'OffsetArmsCrossedStart', label: 'Crossed Arms' },
      { anim: 'IdleGrave_02', label: 'Formal Stand' },
      { anim: 'IdleHandsBehindBack', label: 'Hands Behind' },
      { anim: 'IdleExamine', label: 'Examine' },
      { anim: 'IdleStudy', label: 'Study' },
      { anim: 'IdleDialogueHandOnChinGesture', label: 'Hand On Chin' },
      { anim: 'IdlePointFar_01', label: 'Point Far' },
    ],
  },
  {
    id: 'activities',
    label: 'Activities',
    emotes: [
      { anim: 'IdleDrink', label: 'Drink', prop: true },
      { anim: 'IdleEatingStandingStart', label: 'Eating', prop: true },
      { anim: 'IdleLooseSweepingStart', label: 'Sweeping', prop: true, needs: PROPS.broom },
      { anim: 'IdleHoe', label: 'Use Hoe', prop: true, needs: PROPS.hoe },
      { anim: 'IdleRitualStart', label: 'Ritual' },
      { anim: 'IdleNoteRead', label: 'Read Note', prop: true },
      { anim: 'IdleBook_PageTurn', label: 'Read Book', prop: true },
    ],
  },
  {
    id: 'entertainment',
    label: 'Entertain',
    emotes: [
      { anim: 'IdleCiceroDance1', label: 'Cicero Dance 1' },
      { anim: 'IdleCiceroDance2', label: 'Cicero Dance 2' },
      { anim: 'IdleCiceroDance3', label: 'Cicero Dance 3' },
      { anim: 'IdleDrumStart', label: 'Play Drum', prop: true, needs: PROPS.drum },
      { anim: 'IdleFluteStart', label: 'Play Flute', prop: true, needs: PROPS.flute },
      { anim: 'IdleLuteStart', label: 'Play Lute', prop: true, needs: PROPS.lute },
      { anim: 'IdleBlowHornImperial', label: 'Horn (Imper.)', prop: true, needs: PROPS.imperialHorn },
      { anim: 'IdleBlowHornStormcloak', label: 'Horn (Stormcl.)', prop: true, needs: PROPS.nordHorn },
    ],
  },
];

const events = {
  play: 'emote:play',
  close: 'emote:close',
  stop: 'emote:stop',
  key: 'emote:key',
  hover: 'emote:hover',
};

// Movement input breaks an active emote, matching how remote clones exit poses.
const CANCEL_KEYS: DxScanCode[] = [
  DxScanCode.W,
  DxScanCode.A,
  DxScanCode.S,
  DxScanCode.D,
  DxScanCode.Spacebar,
];

// The engine's draw events; each leaves the sheathed graph branch that every emote idle plays in
const DRAW_EVENTS = new Set<string>(["weapequip", "magic_equip"]);

/**
 * Emote wheel (default B). Opens a radial menu of vanilla idle animations;
 * the chosen idle plays on the local player and reaches other players through
 * the regular animation sync pipeline. Movement keys break an active emote.
 * Ported from Vengeful Realms' emote system, used with permission.
 */
export class EmoteService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.dropEmote());
    // A front reload drops the widget without an emote:close message.
    this.controller.emitter.on("browserWindowLoaded", () => { this.menuOpen = false; });
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });

    this.launcherMenuKeyCode = readMenuKeyCode(this.sp, "emoteWheelKeyCode", DxScanCode.B);
    this.menuKey = this.launcherMenuKeyCode;

    this.allowedAnims = new Set<string>();
    this.propAnims = new Set<string>();
    for (const group of GROUPS) {
      for (const emote of group.emotes) {
        this.allowedAnims.add(emote.anim);
        if (emote.prop) this.propAnims.add(emote.anim);
        if (emote.needs) this.propNeeds.set(emote.anim, emote.needs);
      }
    }
    this.controller.once("update", () => this.resolveProps());
    // Natives throw in the packet handler, and the stored snapshot lags a frame behind the message
    this.controller.emitter.on("setInventoryMessage", (e) => {
      const inventory = e.message.inventory;
      this.controller.once("update", () => this.onInventory(inventory));
    });

    // Records whether the graph accepted the exit event probed by tryExitChain; a draw ends an idle, but an offset overlay still needs OffsetStop
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        if (this.probeAnim && ctx.animEventName === this.probeAnim) {
          this.probeSucceeded = ctx.animationSucceeded;
        }
        if (ctx.animationSucceeded && DRAW_EVENTS.has(ctx.animEventName.toLowerCase())) {
          if (this.activeEmote.indexOf("Offset") === 0) this.stopActiveEmote();
          else this.dropEmote();
        }
      },
    }, 0x14, 0x14);
  }

  private onButtonEvent(e: ButtonEvent): void {
    const code = buttonEventKeyCode(e);
    if (code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    // Movement is real gameplay even with the interface hidden
    if (e.isDown && this.activeEmote && CANCEL_KEYS.includes(code) && !isGameInputBlocked(this.sp, this.controller)) {
      this.stopActiveEmote();
    }
    if (code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
      return;
    }
    if (this.isPoseLocked()) {
      notifyNextUpdate(this.controller, this.sp, this.poseLockNotice());
      return;
    }
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("emote:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    // The wheel key again closes the wheel, unless it is being held open
    if (key === events.key) {
      if (!this.holdMode && this.isMenuDomKey(e.arguments[1])) this.closeMenu();
      return;
    }
    if (key === events.hover) {
      this.hoveredAnim = typeof e.arguments[1] === "string" ? e.arguments[1] : "";
      return;
    }
    if (key === events.stop) {
      this.closeMenu();
      this.stopActiveEmote();
      return;
    }
    if (key === events.play) {
      this.playFromMenu(e.arguments[1]);
    }
  }

  private isMenuDomKey(domKey: unknown): boolean {
    const menuDomKey = domKeyCode(this.menuKey);
    return !!menuDomKey && domKey === menuDomKey;
  }

  // Closes the wheel and plays the chosen emote, or nothing when none was chosen
  private playFromMenu(chosen: unknown): void {
    const anim = typeof chosen === "string" ? chosen : "";
    this.closeMenu();
    if (!this.allowedAnims.has(anim)) {
      return;
    }
    if (this.isPoseLocked()) {
      notifyNextUpdate(this.controller, this.sp, this.poseLockNotice());
      return;
    }
    this.playEmote(anim);
  }

  // Plays an idle for another service; exits replace the exit chain derived from its name
  play(anim: string, exits?: string[]): void {
    if (this.isPoseLocked()) {
      notifyNextUpdate(this.controller, this.sp, this.poseLockNotice());
      return;
    }
    if (exits) this.customExits.set(anim, exits);
    this.playEmote(anim);
  }

  private playEmote(anim: string): void {
    const need = this.missingProp(anim, getPcInventory());
    if (need) {
      notifyNextUpdate(this.controller, this.sp, `You need ${need.label} for this emote.`);
      return;
    }
    const previous = this.activeEmote;
    this.activeEmote = anim;
    this.sentAnim = "";
    // Offset overlays live on their own graph layer: crossing between an
    // overlay and a state idle needs the previous emote exited first, and the
    // exit event must go out alone so the single-slot animation sync relays it.
    // Prop idles are exited first too, otherwise the next idle keeps the prop.
    if (previous && ((previous.indexOf("Offset") === 0) !== (anim.indexOf("Offset") === 0) || this.propAnims.has(previous))) {
      this.exitEmote(previous, () => this.sendEmote(anim));
      return;
    }
    this.chainId++;
    this.sendEmote(anim);
  }

  private sendEmote(anim: string, sheathePolls = 0): void {
    this.controller.once("update", () => {
      if (this.activeEmote !== anim) return;
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      // An idle started with a weapon or spell in hand glitches, so the hands are emptied first
      if (player.isWeaponDrawn()) {
        if (sheathePolls >= SHEATHE_MAX_POLLS) {
          this.activeEmote = "";
          // Observers were already told the weapon is going away
          this.controller.lookupListener(SendInputsService).relayPlayerAnimEvent("Equip");
          notifyNextUpdate(this.controller, this.sp, "Put your weapon away to use emotes.");
          return;
        }
        if (sheathePolls === 0) {
          player.sheatheWeapon();
          // Observers start sheathing the copy now instead of when the idle arrives
          this.controller.lookupListener(SendInputsService).relayPlayerAnimEvent("Unequip");
        }
        this.sp.Utility.wait(SHEATHE_POLL_S).then(() => this.sendEmote(anim, sheathePolls + 1));
        return;
      }
      if (sheathePolls > 0) {
        this.sp.Utility.wait(SHEATHE_SETTLE_S).then(() => this.sendEmote(anim));
        return;
      }
      this.sp.Game.forceThirdPerson();
      this.sp.Debug.sendAnimationEvent(player, anim);
      this.sentAnim = anim;
      this.sentAt = Date.now();
      this.idleGoneTicks = -1;
      logTrace(this, `Playing emote`, anim);
    });
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextCameraTickMs) return;
    this.nextCameraTickMs = now + CAMERA_TICK_MS;
    if (!this.activeEmote) return;
    const player = this.sp.Game.getPlayer();
    if (!player) return;
    if (this.idleEnded(player)) {
      this.activeEmote = "";
      return;
    }
    // A chair or a mount taken after the emote owns the camera again
    if (this.sp.Game.getCameraState() === FIRST_PERSON_CAMERA && player.getSitState() === 0 && !player.isOnMount()) this.sp.Game.forceThirdPerson();
  }

  // An idle seen playing and then gone ended by itself (a one-shot, combat, movement from any device), one never seen was refused; offset overlays are not idles
  private idleEnded(player: Actor): boolean {
    if (this.sentAnim !== this.activeEmote || this.activeEmote.indexOf("Offset") === 0) return false;
    if (player.getAnimationVariableBool(IDLE_PLAYING_VAR)) {
      this.idleGoneTicks = 0;
      return false;
    }
    if (this.idleGoneTicks < 0) return Date.now() - this.sentAt > IDLE_START_MS;
    return ++this.idleGoneTicks >= IDLE_END_TICKS;
  }

  // Also abandons any pending exit chain or follow-up emote
  private dropEmote(): void {
    this.activeEmote = "";
    this.chainId++;
  }

  private stopActiveEmote(): void {
    const anim = this.activeEmote;
    this.activeEmote = "";
    if (anim) this.exitEmote(anim);
  }

  // IdleForceDefaultState breaks most idles; state idles that reject it get
  // their <base>ExitStart / <base>Exit events, offset overlays need OffsetStop.
  private exitEmote(anim: string, onDone?: () => void): void {
    const chain = ++this.chainId;
    if (anim.indexOf("Offset") === 0) {
      this.controller.once("update", () => {
        const player = this.sp.Game.getPlayer();
        if (player) this.sp.Debug.sendAnimationEvent(player, "OffsetStop");
        // Let the sync poll relay OffsetStop before any follow-up event.
        this.sp.Utility.wait(0.1).then(() => {
          if (chain === this.chainId && onDone) onDone();
        });
      });
      return;
    }
    const base = anim.replace(/(Start|Enter)$/, "");
    const attempts = this.customExits.get(anim) ?? ["IdleForceDefaultState", base + "ExitStart", base + "Exit"];
    if (!this.propAnims.has(anim)) {
      this.tryExitChain(attempts, 0, chain, onDone);
      return;
    }
    // IdleForceDefaultState skips the graph's unequip state and leaves the prop in hand
    this.tryExitChain(["IdleStop", ...attempts], 0, chain, onDone && (() => this.waitPropUnload(chain, 0, onDone)));
  }

  // Holds a follow-up emote until the IdleStop exit has dropped the prop.
  private waitPropUnload(chain: number, tries: number, onDone: () => void): void {
    this.sp.Utility.wait(0.2).then(() => {
      this.controller.once("update", () => {
        if (chain !== this.chainId) return;
        const player = this.sp.Game.getPlayer();
        if (player && player.getAnimationVariableBool("bAnimObjectLoaded") && tries < 8) {
          this.waitPropUnload(chain, tries + 1, onDone);
          return;
        }
        onDone();
      });
    });
  }

  private tryExitChain(attempts: string[], index: number, chain: number, onDone?: () => void): void {
    if (chain !== this.chainId) return;
    if (index >= attempts.length) {
      if (onDone) onDone();
      return;
    }
    this.controller.once("update", () => {
      if (chain !== this.chainId) return;
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      // IdleForceDefaultState is a global wildcard into the sheathed branch, so drawn hands skip the exit
      if (player.isWeaponDrawn()) {
        if (onDone) onDone();
        return;
      }
      this.probeAnim = attempts[index];
      this.probeSucceeded = false;
      this.sp.Debug.sendAnimationEvent(player, attempts[index]);
      this.sp.Utility.wait(0.15).then(() => {
        if (chain !== this.chainId) return;
        const ok = this.probeSucceeded;
        this.probeAnim = "";
        if (!ok) {
          this.tryExitChain(attempts, index + 1, chain, onDone);
        } else if (onDone) {
          onDone();
        }
      });
    });
  }

  private isPoseLocked(): boolean {
    try {
      return this.controller.lookupListener(RestraintService).isPoseLocked;
    } catch {
      return false;
    }
  }

  // A carrier, on a passive job or not, is holding a load rather than restrained
  private poseLockNotice(): string {
    try {
      const restraint = this.controller.lookupListener(RestraintService);
      if (restraint.isCarrying && !restraint.isCarried) return "Put down what you carry to use emotes.";
    } catch { /* restraint wording */ }
    return "You cannot use emotes while restrained.";
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.hoveredAnim = "";
    // Releasing a held wheel key plays the hovered emote, if any, and closes the wheel
    if (this.holdMode) {
      armHeldMenu(this.sp, this.controller, this.menuKey);
      claimHeldMenu(() => this.menuOpen, () => this.playFromMenu(this.hoveredAnim));
    }
    openFormMenu(this.sp, this.emoteWidgetSetter, this.menuArgs(getPcInventory()), this.controller);
  }

  // Item ids stay on the client; the wheel only learns what is locked and what it needs
  private menuArgs(inventory: Inventory | undefined): Record<string, unknown> {
    const groups = GROUPS.map((group) => ({
      ...group,
      emotes: group.emotes.map(({ needs, ...emote }) =>
        needs ? { ...emote, locked: !this.carries(needs, inventory), needs: needs.label } : emote),
    }));
    return { GROUPS: groups, events, WIDGET_ID, wheelHold: this.holdMode };
  }

  private missingProp(anim: string, inventory: Inventory | undefined): PropNeed | undefined {
    const need = this.propNeeds.get(anim);
    return need && !this.carries(need, inventory) ? need : undefined;
  }

  private carries(need: PropNeed, inventory: Inventory | undefined): boolean {
    const entries = inventory ? inventory.entries : [];
    return need.items.some((desc) => {
      const id = this.propIds.get(desc);
      return !!id && entries.some((e) => e.baseId === id && e.count > 0);
    });
  }

  // Unresolved items are retried on the next inventory change
  private resolveProps(): void {
    this.propNeeds.forEach((need) => {
      for (const desc of need.items) {
        if (this.propIds.has(desc)) continue;
        const id = formIdFromDesc(desc);
        if (id) this.propIds.set(desc, id);
      }
    });
  }

  private onInventory(inventory: Inventory): void {
    this.resolveProps();
    const need = this.missingProp(this.activeEmote, inventory);
    if (need) {
      const player = this.sp.Game.getPlayer();
      // activeEmote outlives an idle ended by combat, furniture or mounting; only a prop still in hand is stopped
      if (player && player.getAnimationVariableBool("bAnimObjectLoaded")) {
        this.stopActiveEmote();
        notifyNextUpdate(this.controller, this.sp, `You no longer carry ${need.label}.`);
      } else {
        this.activeEmote = "";
      }
    }
    if (this.menuOpen) refreshFormMenu(this.sp, this.emoteWidgetSetter, this.menuArgs(inventory));
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private emoteWidgetSetter = () => {
    const widget = {
      type: "emoteWheel",
      id: WIDGET_ID,
      groups: GROUPS,
      events: events,
      hold: wheelHold,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: number;
  private menuOpen = false;
  // Held open instead of toggled; the release plays the hovered emote
  private holdMode = false;
  // The emote slice under the cursor, as the held wheel reports it
  private hoveredAnim = "";
  private activeEmote = "";
  private allowedAnims: Set<string>;
  private propAnims: Set<string>;
  private propNeeds = new Map<string, PropNeed>();
  private propIds = new Map<string, number>();
  private customExits = new Map<string, string[]>();
  private probeAnim = "";
  private probeSucceeded = false;
  // Generation counter: bumping it abandons any pending exit chain.
  private chainId = 0;
  private nextCameraTickMs = 0;
  // The idle last sent to the graph, and the checks it has been gone since it was seen playing (-1 while never seen)
  private sentAnim = "";
  private idleGoneTicks = -1;
  private sentAt = 0;

  get menuKeyCode(): number {
    return this.menuKey;
  }

  // The launcher's key, which an in-game rebind from the chat settings overrides
  readonly launcherMenuKeyCode: number;

  setMenuKey(override: number): void {
    this.menuKey = override || this.launcherMenuKeyCode;
  }

  setHoldMode(hold: boolean): void {
    this.holdMode = hold;
    wheelHold = hold;
  }
}
