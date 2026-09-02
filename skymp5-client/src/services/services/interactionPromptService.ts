import { ClientListener, CombinedController, Sp } from "./clientListener";
import { closeWidget } from "./widgetMenuUtil";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, CrosshairRefChangedEvent, Form, FormType, ObjectReference } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logError } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 27;

const HUD_MENU = "HUD Menu";
// Only the text is blanked; the vanilla key glyph stays and pairs with our
// wording. The engine rewrites the rollover's text and _visible on every
// crosshair change but leaves _alpha alone, so alpha is the member it will
// not fight.
const ROLLOVER_ALPHA_PATHS = [
  "_root.HUDMovieBaseInstance.RolloverText._alpha",
];

// The bounty board's visible activator; local id inside Missives.esp.
const BOARD_BASE_LOCAL_ID = 0x0012cb;
const BOARD_PLUGIN = "Missives.esp";

interface Prompt {
  verb: string;
  label: string;
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let prompt: Prompt = { verb: "", label: "" };

/**
 * Replaces the vanilla activate rollover text with a CEF prompt the server
 * side of the game can phrase however it likes; the vanilla key glyph stays.
 * The rollover text is faded out via the HUD movie's GFx members every frame
 * (skyrim-platform's own cursor-hide technique); the custom prompt follows
 * crosshairRefChanged. The bounty board reads "Read Notice Board", player
 * characters read "Interact" with introduction- and mask-aware names (and
 * get their engine activation blocked so the interaction menu owns the key),
 * everything else keeps its display name with a verb picked by base form
 * type. The engine still performs the actual activation, which the server
 * intercepts where it wants to.
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
    if (this.promptShown && next.verb === prompt.verb && next.label === prompt.label) {
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
    const actor = Actor.from(ref);
    if (actor) return this.actorPromptFor(ref);
    const base = ref.getBaseObject();
    if (!base) return null;

    if (this.isBoardBase(base)) {
      return { verb: "Read", label: "Notice Board" };
    }

    const label = (ref.getDisplayName() || base.getName() || "").trim();
    if (!label) return null;
    const verb = this.verbFor(ref, base.getType());
    if (!verb) return null;
    return { verb, label };
  }

  // Player characters get the interaction menu on the activate key; names
  // follow the introductions system, and a mask already rewrites the
  // appearance name server-side, so it holds here too.
  private actorPromptFor(ref: ObjectReference): Prompt | null {
    if (ref.getFormID() === 0x14) return null;
    const remoteId = localIdToRemoteId(ref.getFormID());
    // Server-created characters live in the dynamic id space; everything
    // below it is a world NPC that keeps its vanilla activation.
    if (!remoteId || remoteId < 0xff000000) {
      const name = (ref.getDisplayName() || "").trim();
      return name ? { verb: "Talk", label: name } : null;
    }
    // The engine must not start a dialogue with the clone under our menu.
    try { ref.blockActivation(true); } catch { /* unloaded ref */ }
    const raw = (ref.getName() || "").trim();
    const label = raw && this.knowsTarget(remoteId) ? raw : "Stranger";
    return { verb: "Interact", label };
  }

  // True when the local player's ff_knownIds list contains the remote actor
  // id. A missing list (gamemode without introductions) shows real names.
  private knowsTarget(remoteId: number): boolean {
    if (this.sp.storage["ownerModelSet"] !== true) return true;
    const owner = this.sp.storage["ownerModel"] as Record<string, unknown> | undefined;
    const known = owner ? owner["ff_knownIds"] : undefined;
    if (!Array.isArray(known)) return true;
    return known.includes(remoteId);
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
