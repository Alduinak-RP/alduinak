import { ClientListener, CombinedController, Sp } from "./clientListener";
import { closeWidget } from "./widgetMenuUtil";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, CrosshairRefChangedEvent, DxScanCode, Form, FormType, ObjectReference } from "skyrimPlatform";
import { logError } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 27;

const HUD_MENU = "HUD Menu";
// The engine rewrites the rollover's text and _visible on every crosshair
// change but leaves _alpha alone, so alpha is the member it will not fight.
const ROLLOVER_ALPHA_PATHS = [
  "_root.HUDMovieBaseInstance.RolloverText._alpha",
  "_root.HUDMovieBaseInstance.RolloverButton._alpha",
];

// The bounty board's visible activator; local id inside Missives.esp.
const BOARD_BASE_LOCAL_ID = 0x0012cb;
const BOARD_PLUGIN = "Missives.esp";

// Labels for the common activate binds; anything exotic falls back to E.
const KEY_LABELS: Partial<Record<number, string>> = {
  [DxScanCode.E]: "E", [DxScanCode.R]: "R", [DxScanCode.F]: "F", [DxScanCode.Q]: "Q",
  [DxScanCode.T]: "T", [DxScanCode.G]: "G", [DxScanCode.V]: "V", [DxScanCode.X]: "X",
  [DxScanCode.Z]: "Z", [DxScanCode.C]: "C", [DxScanCode.Spacebar]: "Space",
};

interface Prompt {
  verb: string;
  label: string;
  keyLabel: string;
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let prompt: Prompt = { verb: "", label: "", keyLabel: "E" };

/**
 * Replaces the vanilla activate rollover with a CEF prompt the server side of
 * the game can phrase however it likes. The vanilla rollover is faded out via
 * the HUD movie's GFx members every frame (skyrim-platform's own cursor-hide
 * technique); the custom prompt follows crosshairRefChanged. The bounty board
 * gets its own wording; everything else keeps its display name with a verb
 * picked by base form type. Purely cosmetic - the engine still performs the
 * actual activation, which the server intercepts where it wants to.
 *
 * Set customPrompts: false in the skymp5-client settings block to keep the
 * vanilla rollover (also stops the GFx writes, should a HUD swf disagree
 * about member paths).
 */
export class InteractionPromptService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.enabled = this.readEnabled();
    if (!this.enabled) return;
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("crosshairRefChanged", (e) => this.onCrosshairRefChanged(e));
    // A front reload drops the widget silently.
    this.controller.emitter.on("browserWindowLoaded", () => {
      this.promptShown = false;
      this.refresh();
    });
  }

  private onUpdate(): void {
    // A throw here would abort the shared event dispatch chain.
    try {
      this.hideVanillaRollover();
      const focused = this.sp.browser.isFocused();
      if (focused !== this.browserFocused) {
        this.browserFocused = focused;
        if (focused) this.clearPrompt();
        else this.refresh();
      }
    } catch (e) {
      this.logOnce(`update failed: ${e}`);
    }
  }

  private onCrosshairRefChanged(e: CrosshairRefChangedEvent): void {
    try {
      if (this.browserFocused) return;
      this.apply(e.reference || null);
    } catch (e) {
      this.logOnce(`crosshair handler failed: ${e}`);
    }
  }

  private refresh(): void {
    try {
      this.apply(this.sp.Game.getCurrentCrosshairRef());
    } catch { /* not in game yet */ }
  }

  private apply(ref: ObjectReference | null): void {
    const next = ref ? this.promptFor(ref) : null;
    if (!next) {
      this.clearPrompt();
      return;
    }
    if (this.promptShown
      && next.verb === prompt.verb && next.label === prompt.label && next.keyLabel === prompt.keyLabel) {
      return;
    }
    prompt = next;
    this.promptShown = true;
    this.sp.browser.executeJavaScript(new FunctionInfo(this.promptWidgetSetter).getText({ prompt, WIDGET_ID }));
    this.sp.browser.setVisible(true);
  }

  private clearPrompt(): void {
    if (!this.promptShown) return;
    this.promptShown = false;
    closeWidget(this.sp, WIDGET_ID);
  }

  private promptFor(ref: ObjectReference): Prompt | null {
    // Actors have nametags; the rollover never named them anyway.
    if (Actor.from(ref)) return null;
    const base = ref.getBaseObject();
    if (!base) return null;

    const keyLabel = this.activateKeyLabel();
    if (this.isBoardBase(base)) {
      return { verb: "Read", label: "Notice Board", keyLabel };
    }

    const label = (ref.getDisplayName() || base.getName() || "").trim();
    if (!label) return null;
    const verb = this.verbFor(ref, base.getType());
    if (!verb) return null;
    return { verb, label, keyLabel };
  }

  private verbFor(ref: ObjectReference, type: number): string | null {
    switch (type) {
      case FormType.Door:
        return ref.isLocked() ? "Unlock" : "Open";
      case FormType.Container:
        return ref.isLocked() ? "Unlock" : "Search";
      case FormType.Activator:
      case FormType.TalkingActivator:
        return "Activate";
      case FormType.Furniture:
        return "Use";
      case FormType.Book:
        return "Read";
      case FormType.Flora:
      case FormType.Tree:
        return ref.isHarvested() ? null : "Harvest";
      case FormType.Weapon:
      case FormType.Armor:
      case FormType.Ammo:
      case FormType.Misc:
      case FormType.Ingredient:
      case FormType.Potion:
      case FormType.SoulGem:
      case FormType.Key:
      case FormType.ScrollItem:
      case FormType.Light:
        return "Take";
      default:
        return null;
    }
  }

  private isBoardBase(base: Form): boolean {
    if (this.boardBaseId === undefined) {
      try {
        const form = this.sp.Game.getFormFromFile(BOARD_BASE_LOCAL_ID, BOARD_PLUGIN);
        this.boardBaseId = form ? form.getFormID() : 0;
      } catch {
        this.boardBaseId = 0;
      }
    }
    return this.boardBaseId !== 0 && base.getFormID() === this.boardBaseId;
  }

  private activateKeyLabel(): string {
    try {
      const code = this.sp.Input.getMappedKey("Activate", 0);
      return KEY_LABELS[code] || "E";
    } catch {
      return "E";
    }
  }

  private hideVanillaRollover(): void {
    for (const path of ROLLOVER_ALPHA_PATHS) {
      this.sp.Ui.setFloat(HUD_MENU, path, 0);
    }
  }

  private readEnabled(): boolean {
    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings["customPrompts"] === "boolean") {
        return settings["customPrompts"];
      }
    } catch { /* default on */ }
    return true;
  }

  private logOnce(text: string): void {
    if (this.errorLogged) return;
    this.errorLogged = true;
    logError(this, text);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private promptWidgetSetter = () => {
    const widget = {
      type: "interactPrompt",
      id: WIDGET_ID,
      verb: prompt.verb,
      label: prompt.label,
      keyLabel: prompt.keyLabel,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private enabled = true;
  private promptShown = false;
  private browserFocused = false;
  private boardBaseId: number | undefined = undefined;
  private errorLogged = false;
}
