import { ClientListener, CombinedController, Sp } from "./clientListener";
import { notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, closeFormMenu, readMenuKeyCode, isMenuHotkeyBlocked } from "./widgetMenuUtil";
import { RestraintService } from "./restraintService";
import { BrowserMessageEvent, ButtonEvent, DxScanCode, InputDeviceType } from "skyrimPlatform";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 24;

interface EmoteDef {
  anim: string;
  label: string;
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
      { anim: 'IdleDrink', label: 'Drink' },
      { anim: 'IdleEatingStandingStart', label: 'Eating' },
      { anim: 'IdleLooseSweepingStart', label: 'Sweeping' },
      { anim: 'IdleHoe', label: 'Use Hoe' },
      { anim: 'IdleRitualStart', label: 'Ritual' },
      { anim: 'IdleNoteRead', label: 'Read Note' },
      { anim: 'IdleBook_PageTurn', label: 'Read Book' },
    ],
  },
  {
    id: 'entertainment',
    label: 'Entertain',
    emotes: [
      { anim: 'IdleCiceroDance1', label: 'Cicero Dance 1' },
      { anim: 'IdleCiceroDance2', label: 'Cicero Dance 2' },
      { anim: 'IdleCiceroDance3', label: 'Cicero Dance 3' },
      { anim: 'IdleDrumStart', label: 'Play Drum' },
      { anim: 'IdleFluteStart', label: 'Play Flute' },
      { anim: 'IdleLuteStart', label: 'Play Lute' },
      { anim: 'IdleBlowHornImperial', label: 'Horn (Imper.)' },
      { anim: 'IdleBlowHornStormcloak', label: 'Horn (Stormcl.)' },
    ],
  },
];

const events = {
  play: 'emote:play',
  close: 'emote:close',
};

// Movement input breaks an active emote, matching how remote clones exit poses.
const CANCEL_KEYS: DxScanCode[] = [
  DxScanCode.W,
  DxScanCode.A,
  DxScanCode.S,
  DxScanCode.D,
  DxScanCode.Spacebar,
  DxScanCode.R,
];

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
    this.controller.emitter.on("gameLoad", () => { this.activeEmote = ""; });

    this.menuKey = readMenuKeyCode(this.sp, "emoteWheelKeyCode", DxScanCode.B);

    this.allowedAnims = new Set<string>();
    for (const group of GROUPS) {
      for (const emote of group.emotes) {
        this.allowedAnims.add(emote.anim);
      }
    }

    // Records whether the graph accepted the exit event probed by tryExitChain.
    this.sp.hooks.sendAnimationEvent.add({
      enter: () => { },
      leave: (ctx) => {
        if (this.probeAnim && ctx.animEventName === this.probeAnim) {
          this.probeSucceeded = ctx.animationSucceeded;
        }
      },
    }, 0x14, 0x14);
  }

  private onButtonEvent(e: ButtonEvent): void {
    // Gamepad idCodes are bitmasks that alias onto keyboard scancodes
    if (e.device !== InputDeviceType.Keyboard) return;
    if (e.code === DxScanCode.Escape && e.isDown && this.menuOpen) {
      this.closeMenu();
      return;
    }
    if (e.isDown && this.activeEmote && CANCEL_KEYS.includes(e.code) && !this.sp.browser.isFocused()) {
      this.stopActiveEmote();
    }
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (isMenuHotkeyBlocked(this.sp, this.controller)) {
      return;
    }
    if (this.isPoseLocked()) {
      notifyNextUpdate(this.controller, this.sp, "You cannot use emotes while restrained.");
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
    if (key === events.play) {
      const anim = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      this.closeMenu();
      if (!this.allowedAnims.has(anim)) {
        return;
      }
      if (this.isPoseLocked()) {
        notifyNextUpdate(this.controller, this.sp, "You cannot use emotes while restrained.");
        return;
      }
      this.playEmote(anim);
    }
  }

  private playEmote(anim: string): void {
    const previous = this.activeEmote;
    this.activeEmote = anim;
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      // Offset overlays stay on their own graph layer; clear one before a normal idle.
      if (previous.indexOf("Offset") === 0 && anim.indexOf("Offset") !== 0) {
        this.sp.Debug.sendAnimationEvent(player, "OffsetStop");
      }
      this.sp.Debug.sendAnimationEvent(player, anim);
      logTrace(this, `Playing emote`, anim);
    });
  }

  // IdleForceDefaultState breaks most idles; state idles that reject it get
  // their <base>ExitStart / <base>Exit events, offset overlays need OffsetStop.
  private stopActiveEmote(): void {
    const anim = this.activeEmote;
    this.activeEmote = "";
    if (!anim) return;
    if (anim.indexOf("Offset") === 0) {
      this.controller.once("update", () => {
        const player = this.sp.Game.getPlayer();
        if (player) this.sp.Debug.sendAnimationEvent(player, "OffsetStop");
      });
      return;
    }
    const base = anim.replace(/(Start|Enter)$/, "");
    this.tryExitChain(["IdleForceDefaultState", base + "ExitStart", base + "Exit"], 0);
  }

  private tryExitChain(attempts: string[], index: number): void {
    if (index >= attempts.length) return;
    this.controller.once("update", () => {
      const player = this.sp.Game.getPlayer();
      if (!player) return;
      this.probeAnim = attempts[index];
      this.probeSucceeded = false;
      this.sp.Debug.sendAnimationEvent(player, attempts[index]);
      this.sp.Utility.wait(0.15).then(() => {
        const ok = this.probeSucceeded;
        this.probeAnim = "";
        if (!ok) this.tryExitChain(attempts, index + 1);
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

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.emoteWidgetSetter, { GROUPS, events, WIDGET_ID });
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
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.B;
  private menuOpen = false;
  private activeEmote = "";
  private allowedAnims: Set<string>;
  private probeAnim = "";
  private probeSucceeded = false;
}
