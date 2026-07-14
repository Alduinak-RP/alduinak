import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent, Menu, MenuOpenEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logError, logTrace } from "../../logging";
import { NetworkingService } from "./networkingService";
import { SinglePlayerService } from "./singlePlayerService";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

// A character slot from the server; null/absent means empty and Play creates a new character there.
interface CharacterSlot {
  name?: string;
  // Optional one-line summary, e.g. "Level 3 Nord, Whiterun".
  info?: string;
  // Permanently dead: shown crossed out and greyed, only Delete is allowed.
  dead?: boolean;
}

// Event keys exchanged with the browser; namespaced to avoid collisions with other "browserMessage" listeners.
const events = {
  select: 'characterSelect:select',         // arg: pick a slot
  play: 'characterSelect:play',             // confirm the selected slot
  edit: 'characterSelect:edit',             // arg: no-op for now
  delete: 'characterSelect:delete',         // arg: ask to delete
  confirmDelete: 'characterSelect:confirmDelete', // arg: delete check
  cancelDelete: 'characterSelect:cancelDelete',
  quit: 'characterSelect:quit',
};

const translations = {
  "ru": {
    selectCharacter: 'Выбор персонажа',
    emptySlot: 'Пусто',
    unnamed: 'Безымянный',
    play: 'Играть',
    edit: 'Изменить',
    del: 'Удалить',
    confirmDelete: 'Удалить этого персонажа навсегда?',
    confirm: 'Подтвердить',
    cancel: 'Отмена',
    quit: 'Выйти',
    dead: 'Мёртв',
  },
  "en": {
    selectCharacter: 'Select Character',
    emptySlot: 'Empty',
    unnamed: 'Unnamed',
    play: 'Play',
    edit: 'Edit',
    del: 'Delete',
    confirmDelete: 'Permanently delete this character? This cannot be undone.',
    confirm: 'Confirm',
    cancel: 'Cancel',
    quit: 'Quit',
    dead: 'Dead',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// State read by the browser-side widget setter via FunctionInfo injection.
let strings: TranslationStrings = translations['en'];
let characters: (CharacterSlot | null)[] = [];
let maxCharacters = 3;
let selectedSlot: number | null = null;
let confirmDeleteSlot: number | null = null;

/**
 * Character-selection menu. Inert until the server opens it, so it has no effect
 * on servers that don't enable the "characterSelect" flow.
 *
 * Protocol (all messages are {@link MsgType.CustomPacket} JSON dumps):
 *
 *   Server -> Client, open the menu:
 *     { "customPacketType": "characterSelectMenu",
 *       "maxCharacters": 3,
 *       "characters": [ { "name": "Lydia", "info": "..." }, null, null ] }
 *
 *   Server -> Client, close without a choice (optional):
 *     { "customPacketType": "characterSelectMenuClose" }
 *
 *   Client -> Server, the player chose:
 *     { "customPacketType": "characterSelectResult", "action": "play",   "slot": 0 }
 *     { "customPacketType": "characterSelectResult", "action": "create", "slot": 1 }
 *     { "customPacketType": "characterSelectResult", "action": "delete", "slot": 2 }
 */
export class CharacterSelectService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    // "update" fires only in-game, so the first one marks the initial spawn.
    this.controller.once("update", () => { this.sawGameplay = true; });

    try {
      const lang = (this.sp.settings["skymp5-client"] as any)?.["language"] as string | undefined;
      if (lang && lang in translations) {
        strings = translations[lang as keyof typeof translations];
      }
    } catch {
      // fall back to English
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return; // other services validate their own packets
    }

    switch (content["customPacketType"]) {
      case 'characterSelectMenu':
        characters = Array.isArray(content["characters"]) ? content["characters"] as (CharacterSlot | null)[] : [];
        maxCharacters = typeof content["maxCharacters"] === 'number' ? content["maxCharacters"] : Math.max(characters.length, 1);
        selectedSlot = null;
        confirmDeleteSlot = null;
        this.menuOpen = true;
        logTrace(this, `Opening character select menu with`, maxCharacters, `slots`);
        this.renderMenu();
        this.sp.browser.setVisible(true);
        this.sp.browser.setFocused(true);
        break;
      case 'characterSelectMenuClose':
        if (this.menuOpen) this.closeMenu();
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const eventKey = e.arguments[0];
    if (typeof eventKey !== 'string' || !eventKey.startsWith('characterSelect:')) return;
    if (!this.menuOpen) return;

    const slot = Number(e.arguments[1]);

    switch (eventKey) {
      case events.select:
        // Dead slots can't be selected; they are only deletable.
        if (Number.isInteger(slot) && !characters[slot]?.dead) { selectedSlot = slot; this.renderMenu(); }
        break;
      case events.play:
        // Play loads the selection or starts creation if empty; dead slots refused, server is the authority.
        if (selectedSlot !== null && !characters[selectedSlot]?.dead) {
          const action = characters[selectedSlot] ? 'play' : 'create';
          this.sendResult(action, selectedSlot);
          this.closeMenu();
        }
        break;
      case events.edit:
        // Editing existing characters isn't wired up yet.
        break;
      case events.delete:
        if (Number.isInteger(slot)) { confirmDeleteSlot = slot; this.renderMenu(); }
        break;
      case events.confirmDelete:
        if (Number.isInteger(slot)) {
          this.sendResult('delete', slot);
          // Optimistic local clear; the server also re-sends the menu.
          if (slot < characters.length) characters[slot] = null;
          if (selectedSlot === slot) selectedSlot = null;
          confirmDeleteSlot = null;
          this.renderMenu();
        }
        break;
      case events.cancelDelete:
        confirmDeleteSlot = null;
        this.renderMenu();
        break;
      case events.quit:
        logTrace(this, 'quit requested from character select');
        this.sp.win32.exitProcess();
        break;
      default:
        break;
    }
  }

  // Quitting to main menu mid-session must reopen character select (the server forgets its menu state).
  // The focused browser reply also hides the native main menu buttons, same as the initial login flow.
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name !== Menu.Main) return;
    if (!this.sawGameplay) return; // initial boot: the auth flow drives the menu
    // menuOpen events can arrive late (queued into SP update tasks); only act
    // when the main menu is REALLY open right now (stale-event guard).
    try {
      if (!this.sp.Ui.isMenuOpen(Menu.Main)) return;
    } catch (err) {
      return; // native context unavailable, event is certainly stale
    }
    if (this.controller.lookupListener(SinglePlayerService).isSinglePlayer) return;
    if (!this.controller.lookupListener(NetworkingService).isConnected()) return;
    logTrace(this, 'Main menu opened while connected, requesting character select menu');
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: 'characterSelectMenuRequest' }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private sendResult(action: 'play' | 'create' | 'delete', slot: number): void {
    logTrace(this, `Sending character select result:`, action, slot);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: 'characterSelectResult', action, slot }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private renderMenu(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({
        characters, maxCharacters, selectedSlot, confirmDeleteSlot, events, strings,
      })
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    selectedSlot = null;
    confirmDeleteSlot = null;
    // Clear forms only; chat and other in-game widgets must survive a mid-session reopen.
    this.sp.browser.executeJavaScript(
      'window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=="form";}));'
    );
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  private browsersideWidgetSetter = () => {
    const widget: any = { type: "form", id: 7, caption: strings.selectCharacter, elements: [] as any[] };

    // Strike through via combining U+0336 overlays; the form renderer has no text styling.
    const strike = (s: string) => s.split("").map((c) => c + String.fromCharCode(0x0336)).join("");

    for (let i = 0; i < maxCharacters; i++) {
      const character = characters[i];
      const headerTags = i === 0 ? [] : ["ELEMENT_STYLE_MARGIN_EXTENDED"];

      if (confirmDeleteSlot === i) {
        widget.elements.push({ type: "text", text: (character && character.name) || strings.unnamed, tags: headerTags });
        widget.elements.push({ type: "text", text: strings.confirmDelete, tags: [] });
        widget.elements.push({ type: "button", text: strings.confirm, tags: [], click: () => window.skyrimPlatform.sendMessage(events.confirmDelete, i) });
        widget.elements.push({ type: "button", text: strings.cancel, tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.cancelDelete, i) });
        continue;
      }

      const isSelected = selectedSlot === i;
      const isDead = !!(character && character.dead);
      const label = character ? (character.name || strings.unnamed) : strings.emptySlot;
      // The slot itself is a button that selects it; dead slots render struck out and disabled.
      widget.elements.push({
        type: "button",
        text: isDead ? strike(label) : (isSelected ? "> " : "") + label,
        tags: headerTags,
        isDisabled: isDead,
        click: () => window.skyrimPlatform.sendMessage(events.select, i),
      });
      if (character) {
        if (isDead) widget.elements.push({ type: "text", text: strings.dead, tags: ["ELEMENT_SAME_LINE"] });
        else if (character.info) widget.elements.push({ type: "text", text: character.info, tags: ["ELEMENT_SAME_LINE"] });
        // Editing a corpse makes no sense, but freeing the slot must stay possible.
        if (!isDead) widget.elements.push({ type: "button", text: strings.edit, tags: ["ELEMENT_SAME_LINE"], width: 90, click: () => window.skyrimPlatform.sendMessage(events.edit, i) });
        widget.elements.push({ type: "button", text: strings.del, tags: ["ELEMENT_SAME_LINE"], width: 90, click: () => window.skyrimPlatform.sendMessage(events.delete, i) });
      }
    }

    // Bottom row: Quit on the left, Play (disabled until a live slot is picked) on the right.
    const selectedDead = selectedSlot !== null && !!(characters[selectedSlot] && characters[selectedSlot]!.dead);
    widget.elements.push({
      type: "button",
      text: strings.quit,
      tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"],
      click: () => window.skyrimPlatform.sendMessage(events.quit),
    });
    widget.elements.push({
      type: "button",
      text: strings.play,
      tags: ["BUTTON_STYLE_FRAME", "ELEMENT_SAME_LINE"],
      isDisabled: selectedSlot === null || selectedDead,
      click: () => window.skyrimPlatform.sendMessage(events.play),
    });

    // Replace form widgets (auth/menu) but keep chat alive: this can render mid-session.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private sawGameplay = false;
}
