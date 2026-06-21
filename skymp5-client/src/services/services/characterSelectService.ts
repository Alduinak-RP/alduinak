import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { BrowserMessageEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logError, logTrace } from "../../logging";

// for browsersideWidgetSetter (executed inside the CEF browser)
declare const window: any;

// A single character slot as described by the server. `null`/absent means the
// slot is empty and Play should create a new character there.
interface CharacterSlot {
  name?: string;
  // Optional one-line summary, e.g. "Level 3 Nord — Whiterun".
  info?: string;
}

// Event keys exchanged with the browser. Namespaced so they don't collide with
// other services that also listen to "browserMessage" (e.g. AuthService).
const events = {
  select: 'characterSelect:select',         // arg: slot — pick a slot
  play: 'characterSelect:play',             // confirm the selected slot
  edit: 'characterSelect:edit',             // arg: slot — no-op for now
  delete: 'characterSelect:delete',         // arg: slot — ask to delete
  confirmDelete: 'characterSelect:confirmDelete', // arg: slot — really delete
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
    // Tries to force character selection to be visible
    this.controller.on("tick", () => {
      if (!this.menuOpen) return;
      if (!this.sp.browser.isVisible()) this.sp.browser.setVisible(true);
      if (!this.sp.browser.isFocused()) this.sp.browser.setFocused(true);
    });

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
        if (Number.isInteger(slot)) { selectedSlot = slot; this.renderMenu(); }
        break;
      case events.play:
        // Play loads the selected character, or starts creation if empty.
        if (selectedSlot !== null) {
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
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==7;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only the injected variables (characters,
  // maxCharacters, selectedSlot, confirmDeleteSlot, events, strings) and `window`
  // are available here.
  private browsersideWidgetSetter = () => {
    const widget: any = { type: "form", id: 7, caption: strings.selectCharacter, elements: [] as any[] };

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
      const label = character ? (character.name || strings.unnamed) : strings.emptySlot;
      // The slot itself is a button; clicking it selects the slot.
      widget.elements.push({
        type: "button",
        text: (isSelected ? "> " : "") + label,
        tags: headerTags,
        click: () => window.skyrimPlatform.sendMessage(events.select, i),
      });
      if (character) {
        if (character.info) widget.elements.push({ type: "text", text: character.info, tags: ["ELEMENT_SAME_LINE"] });
        widget.elements.push({ type: "button", text: strings.edit, tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.edit, i) });
        widget.elements.push({ type: "button", text: strings.del, tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.delete, i) });
      }
    }

    // Bottom row: Play (disabled until a slot is picked) and Quit.
    widget.elements.push({
      type: "button",
      text: strings.play,
      tags: ["BUTTON_STYLE_FRAME", "ELEMENT_STYLE_MARGIN_EXTENDED"],
      isDisabled: selectedSlot === null,
      click: () => window.skyrimPlatform.sendMessage(events.play),
    });
    widget.elements.push({ type: "button", text: strings.quit, tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.quit) });

    // Preserve any other widgets (e.g. the persistent chat) — only replace ours.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== 7);
    window.skyrimPlatform.widgets.set([...others, widget]);
  };

  private menuOpen = false;
}
