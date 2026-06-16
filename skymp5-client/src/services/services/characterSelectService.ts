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
// slot is empty and should offer a "create" action instead of "play"/"delete".
interface CharacterSlot {
  name?: string;
  // Optional one-line summary, e.g. "Level 3 Nord — Whiterun".
  info?: string;
}

// Event keys exchanged with the browser. Namespaced so they don't collide with
// other services that also listen to "browserMessage" (e.g. AuthService).
// Declared at module scope so the browser-side widget setter can reference them
// both at type-check time and after runtime injection (see AuthService).
const events = {
  play: 'characterSelect:play',
  create: 'characterSelect:create',
  delete: 'characterSelect:delete',
  cancelDelete: 'characterSelect:cancelDelete',
};

const translations = {
  "ru": {
    selectCharacter: 'Выбор персонажа',
    emptySlot: 'пустой слот',
    unnamed: 'безымянный',
    play: 'играть',
    create: 'создать',
    delete: 'удалить',
    confirmDelete: 'точно удалить?',
    cancel: 'отмена',
  },
  "en": {
    selectCharacter: 'Select Character',
    emptySlot: 'empty slot',
    unnamed: 'unnamed',
    play: 'play',
    create: 'create',
    delete: 'delete',
    confirmDelete: 'confirm delete?',
    cancel: 'cancel',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// State used on both the client and browser side (the browser-side widget setter
// reads these via runtime injection in FunctionInfo.getText). Module-level, like
// AuthService's browserState/authData/strings, so both contexts can see them.
let strings: TranslationStrings = translations['en'];
let characters: (CharacterSlot | null)[] = [];
let maxCharacters = 3;
let confirmDeleteSlot: number | null = null;

/**
 * Renders the character-selection menu (up to N slots) and reports the player's
 * choice back to the server.
 *
 * Protocol (all messages are {@link MsgType.CustomPacket} with a JSON dump):
 *
 *   Server -> Client, opens the menu:
 *     { "customPacketType": "characterSelectMenu",
 *       "maxCharacters": 3,
 *       "characters": [ { "name": "Lydia", "info": "Level 3 — Whiterun" }, null, null ] }
 *
 *   Server -> Client, closes the menu without a choice (optional):
 *     { "customPacketType": "characterSelectMenuClose" }
 *
 *   Client -> Server, the player picked an action:
 *     { "customPacketType": "characterSelectResult", "action": "play",   "slot": 0 }
 *     { "customPacketType": "characterSelectResult", "action": "create", "slot": 1 }
 *     { "customPacketType": "characterSelectResult", "action": "delete", "slot": 2 }
 *
 * The service is inert until the server sends "characterSelectMenu", so it has
 * no effect on servers that don't use it.
 */
export class CharacterSelectService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

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
      // not our concern — other services validate their own packets
      return;
    }

    switch (content["customPacketType"]) {
      case 'characterSelectMenu':
        characters = Array.isArray(content["characters"]) ? content["characters"] as (CharacterSlot | null)[] : [];
        maxCharacters = typeof content["maxCharacters"] === 'number' ? content["maxCharacters"] : Math.max(characters.length, 1);
        confirmDeleteSlot = null;
        this.menuOpen = true;
        logTrace(this, `Opening character select menu with`, maxCharacters, `slots`);
        this.renderMenu();
        this.sp.browser.setVisible(true);
        this.sp.browser.setFocused(true);
        break;
      case 'characterSelectMenuClose':
        if (this.menuOpen) {
          logTrace(this, `Closing character select menu (server request)`);
          this.closeMenu();
        }
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const eventKey = e.arguments[0];
    if (typeof eventKey !== 'string' || !eventKey.startsWith('characterSelect:')) {
      return;
    }
    if (!this.menuOpen) {
      logTrace(this, `Ignoring browser message while menu is closed:`, eventKey);
      return;
    }

    const slot = Number(e.arguments[1]);
    if (!Number.isInteger(slot)) {
      logError(this, `Received character select event with invalid slot:`, JSON.stringify(e.arguments));
      return;
    }

    switch (eventKey) {
      case events.play:
        this.sendResult('play', slot);
        this.closeMenu();
        break;
      case events.create:
        this.sendResult('create', slot);
        this.closeMenu();
        break;
      case events.delete:
        // Two-step confirmation so a single misclick can't wipe a character.
        if (confirmDeleteSlot === slot) {
          this.sendResult('delete', slot);
          this.closeMenu();
        } else {
          confirmDeleteSlot = slot;
          this.renderMenu();
        }
        break;
      case events.cancelDelete:
        confirmDeleteSlot = null;
        this.renderMenu();
        break;
      default:
        break;
    }
  }

  private sendResult(action: 'play' | 'create' | 'delete', slot: number): void {
    logTrace(this, `Sending character select result:`, action, slot);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({
        customPacketType: 'characterSelectResult',
        action,
        slot,
      }),
    };
    this.controller.emitter.emit("sendMessage", {
      message,
      reliability: "reliable",
    });
  }

  private renderMenu(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({
        characters,
        maxCharacters,
        confirmDeleteSlot,
        events,
        strings,
      })
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    confirmDeleteSlot = null;
    this.sp.browser.executeJavaScript('window.skyrimPlatform.widgets.set([]);');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only the variables injected by getText()
  // (characters, maxCharacters, confirmDeleteSlot, events, strings) and `window`
  // are available here.
  private browsersideWidgetSetter = () => {
    const widget: any = {
      type: "form",
      id: 7,
      caption: strings.selectCharacter,
      elements: [] as any[],
    };

    for (let i = 0; i < maxCharacters; i++) {
      const character = characters[i];
      const headerTags = i === 0 ? [] : ["ELEMENT_STYLE_MARGIN_EXTENDED"];

      if (character) {
        widget.elements.push({
          type: "text",
          text: character.name || strings.unnamed,
          tags: headerTags,
        });
        if (character.info) {
          widget.elements.push({ type: "text", text: character.info, tags: [] });
        }

        if (confirmDeleteSlot === i) {
          widget.elements.push({ type: "text", text: strings.confirmDelete, tags: [] });
          widget.elements.push({
            type: "button",
            text: strings.delete,
            tags: [],
            click: () => window.skyrimPlatform.sendMessage(events.delete, i),
          });
          widget.elements.push({
            type: "button",
            text: strings.cancel,
            tags: ["ELEMENT_SAME_LINE"],
            click: () => window.skyrimPlatform.sendMessage(events.cancelDelete, i),
          });
        } else {
          widget.elements.push({
            type: "button",
            text: strings.play,
            tags: [],
            click: () => window.skyrimPlatform.sendMessage(events.play, i),
          });
          widget.elements.push({
            type: "button",
            text: strings.delete,
            tags: ["ELEMENT_SAME_LINE"],
            click: () => window.skyrimPlatform.sendMessage(events.delete, i),
          });
        }
      } else {
        widget.elements.push({ type: "text", text: strings.emptySlot, tags: headerTags });
        widget.elements.push({
          type: "button",
          text: strings.create,
          tags: [],
          click: () => window.skyrimPlatform.sendMessage(events.create, i),
        });
      }
    }

    window.skyrimPlatform.widgets.set([widget]);
  };

  private menuOpen = false;
}
