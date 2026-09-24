import { FunctionInfo } from "../../lib/functionInfo";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { keyLabel, openFormMenu, readMenuLanguage } from "./widgetMenuUtil";
import { BrowserMessageEvent, Menu, MenuOpenEvent } from "skyrimPlatform";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { logTrace } from "../../logging";
import { NetworkingService } from "./networkingService";
import { SinglePlayerService } from "./singlePlayerService";
import { BrowserService } from "./browserService";
import { VoiceService } from "./voiceService";
import { PlayerActionService } from "./playerActionService";
import { EmoteService } from "./emoteService";

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

interface IntroPage {
  caption?: string;
  text: string;
  align?: 'left';
}

// New character intro from the server: synopsis pages, then the start location question
interface StartIntro {
  pages: IntroPage[];
  question: string;
  locations: { id: string; label: string }[];
}

const WIDGET_ID = 7;
const INTRO_WIDGET_ID = 32;
// Synopsis pages use larger text; the list id also aligns it left
const INTRO_PAGE_WIDGET_ID = 35;
const INTRO_LIST_WIDGET_ID = 36;

// Synopsis placeholders and the live key bindings that fill them
const INTRO_KEYS: [string, (controller: CombinedController) => number][] = [
  ["[get alt interaction button]", (c) => c.lookupListener(PlayerActionService).interactKeyCode],
  ["[get voice key button]", (c) => c.lookupListener(VoiceService).pushToTalkKeyCode],
  ["[get emote wheel button]", (c) => c.lookupListener(EmoteService).menuKeyCode],
  ["[get release mouse button]", (c) => c.lookupListener(BrowserService).freeCursorKeyCode],
  ["[get hide interface button]", (c) => c.lookupListener(BrowserService).hideUiKeyCode],
  ["[get activate chat button]", (c) => c.lookupListener(BrowserService).chatKeyCode],
];

// Event keys exchanged with the browser; namespaced to avoid collisions with other "browserMessage" listeners.
const events = {
  select: 'characterSelect:select',         // arg: pick a slot
  play: 'characterSelect:play',             // confirm the selected slot
  edit: 'characterSelect:edit',             // arg: no-op for now
  delete: 'characterSelect:delete',         // arg: ask to delete
  confirmDelete: 'characterSelect:confirmDelete', // arg: delete check
  cancelDelete: 'characterSelect:cancelDelete',
  quit: 'characterSelect:quit',
  introNext: 'characterSelect:introNext',
  introBack: 'characterSelect:introBack',       // back to the slot list
  introPick: 'characterSelect:introPick',       // arg: start location index
  introConfirm: 'characterSelect:introConfirm',
  introCancel: 'characterSelect:introCancel',   // back to the start locations
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
    next: 'Продолжить',
    back: 'Назад',
    beginAt: 'Начать путь здесь: {0}?',
    loadFailed: 'Не удалось войти в мир: {0}. Отправьте администрации skyrim-platform.log из Документы > My Games > папка Skyrim > SKSE.',
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
    next: 'Continue',
    back: 'Back',
    beginAt: 'Begin at {0}?',
    loadFailed: 'Could not enter the world: {0}. Send staff skyrim-platform.log from Documents > My Games > your Skyrim folder > SKSE.',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// State read by the browser-side widget setter via FunctionInfo injection.
let strings: TranslationStrings = translations['en'];
let characters: (CharacterSlot | null)[] = [];
let maxCharacters = 3;
// Empty slots the server will not create in while the living limit is reached; hidden
let lockedSlots: number[] = [];
let selectedSlot: number | null = null;
let confirmDeleteSlot: number | null = null;
let intro: StartIntro | null = null;
// null shows the slot list; the intro walks page -> question -> confirm
let introScreen: 'page' | 'question' | 'confirm' | null = null;
let introPages: IntroPage[] = [];
let introPage = 0;
let introPick = -1;
// Shown above the slot list after a spawn that never reached the world, or the server's reason for refusing the last choice
let notice = '';
// The load failure line outlives menu re-sends until the player's next choice
let keepNotice = false;

// A player's own quit opens the pause menu shortly before the main menu
const PAUSE_QUIT_WINDOW_MS = 60000;

function parseIntro(raw: unknown): StartIntro | null {
  const r = raw as Partial<StartIntro> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.pages) || !Array.isArray(r.locations) || typeof r.question !== 'string') return null;
  const pages = r.pages.filter((p) => p && typeof p.text === 'string');
  const locations = r.locations.filter((l) => l && typeof l.id === 'string' && typeof l.label === 'string');
  return locations.length > 0 ? { pages, question: r.question, locations } : null;
}

function resetIntro(): void {
  introScreen = null;
  introPages = [];
  introPage = 0;
  introPick = -1;
}

/**
 * Character-selection menu. Inert until the server opens it, so it has no effect
 * on servers that don't enable the "characterSelect" flow.
 *
 * Protocol (all messages are {@link MsgType.CustomPacket} JSON dumps):
 *
 *   Server -> Client, open the menu (without intro an empty slot creates at once); notice is shown above the slots, a refused choice sends one:
 *     { "customPacketType": "characterSelectMenu",
 *       "maxCharacters": 3,
 *       "characters": [ { "name": "Lydia", "info": "..." }, null, null ],
 *       "lockedSlots": [ 2 ],
 *       "intro": { "pages": [ { "caption": "...", "text": "...", "align": "left" } ], "question": "...",
 *                  "locations": [ { "id": "dawnstar-docks", "label": "Dawnstar Docks" } ] },
 *       "notice"?: "That character is dead." }
 *
 *   Server -> Client, close without a choice (optional):
 *     { "customPacketType": "characterSelectMenuClose" }
 *
 *   Client -> Server, the player chose:
 *     { "customPacketType": "characterSelectResult", "action": "play",   "slot": 0 }
 *     { "customPacketType": "characterSelectResult", "action": "create", "slot": 1, "start": "dawnstar-docks" }
 *     { "customPacketType": "characterSelectResult", "action": "delete", "slot": 2 }
 *
 *   Client -> Server, reopen after a quit to the main menu or a failed spawn load:
 *     { "customPacketType": "characterSelectMenuRequest", "loadError"?: "...", "viaPauseMenu"?: true | false }
 */
export class CharacterSelectService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.on("menuOpen", (e) => this.onMenuOpen(e));
    // "update" fires only in-game, so the first one marks the initial spawn.
    this.controller.once("update", () => { this.sawGameplay = true; });
    // The hide UI key drops focus; the modal must be clickable again once shown
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (!e.hidden && this.menuOpen) this.sp.browser.setFocused(true); });

    const lang = readMenuLanguage(this.sp);
    if (lang in translations) {
      strings = translations[lang as keyof typeof translations];
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case 'characterSelectMenu':
        characters = Array.isArray(content["characters"]) ? content["characters"] as (CharacterSlot | null)[] : [];
        maxCharacters = typeof content["maxCharacters"] === 'number' ? content["maxCharacters"] : Math.max(characters.length, 1);
        lockedSlots = Array.isArray(content["lockedSlots"]) ? (content["lockedSlots"] as unknown[]).filter((i): i is number => Number.isInteger(i)) : [];
        selectedSlot = null;
        confirmDeleteSlot = null;
        intro = parseIntro(content["intro"]);
        if (typeof content["notice"] === 'string') notice = content["notice"];
        else if (!keepNotice) notice = '';
        resetIntro();
        this.menuOpen = true;
        logTrace(this, `Opening character select menu with`, maxCharacters, `slots`);
        openFormMenu(this.sp, this.browsersideWidgetSetter, this.menuArgs(), this.controller);
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
        if (Number.isInteger(slot) && !characters[slot]?.dead && lockedSlots.indexOf(slot) < 0) { selectedSlot = slot; this.renderMenu(); }
        break;
      case events.play:
        // Play loads the selection or starts creation if empty; dead slots refused, server is the authority.
        if (introScreen === null && selectedSlot !== null && !characters[selectedSlot]?.dead) {
          if (!characters[selectedSlot] && intro) {
            introPages = this.resolveIntroPages(intro.pages);
            introPage = 0;
            introScreen = introPages.length > 0 ? 'page' : 'question';
            this.renderMenu();
            break;
          }
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
      case events.introNext:
        if (introScreen === 'page') {
          if (introPage + 1 < introPages.length) introPage++;
          else introScreen = 'question';
          this.renderMenu();
        }
        break;
      case events.introBack:
        if (introScreen === 'page' || introScreen === 'question') {
          resetIntro();
          this.renderMenu();
        }
        break;
      case events.introPick:
        if (introScreen === 'question' && intro && Number.isInteger(slot) && intro.locations[slot]) {
          introPick = slot;
          introScreen = 'confirm';
          this.renderMenu();
        }
        break;
      case events.introConfirm:
        if (introScreen === 'confirm' && intro && intro.locations[introPick] && selectedSlot !== null) {
          this.sendResult('create', selectedSlot, intro.locations[introPick].id);
          this.closeMenu();
        }
        break;
      case events.introCancel:
        if (introScreen === 'confirm') {
          introScreen = 'question';
          this.renderMenu();
        }
        break;
      case events.quit:
        logTrace(this, 'quit requested from character select');
        this.controller.lookupListener(NetworkingService).close();
        this.sp.win32.exitProcess();
        break;
      default:
        break;
    }
  }

  // Quitting to main menu mid-session must reopen character select (the server forgets its menu state).
  // The focused browser reply also hides the native main menu buttons, same as the initial login flow.
  private onMenuOpen(e: MenuOpenEvent): void {
    if (e.name === Menu.Journal) this.pauseMenuAt = Date.now();
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
    sendCustomPacket(this.controller, { customPacketType: 'characterSelectMenuRequest', viaPauseMenu: Date.now() - this.pauseMenuAt < PAUSE_QUIT_WINDOW_MS });
  }

  public isMenuOpen(): boolean {
    return this.menuOpen;
  }

  // The server log gets the reason without the Windows user name
  public showLoadFailure(reason: string): void {
    notice = strings.loadFailed.replace('{0}', reason);
    keepNotice = true;
    const loadError = reason.replace(/[A-Za-z]:\\Users\\[^\\]+/g, '%USERPROFILE%').slice(0, 300);
    sendCustomPacket(this.controller, { customPacketType: 'characterSelectMenuRequest', loadError });
  }

  private sendResult(action: 'play' | 'create' | 'delete', slot: number, start?: string): void {
    logTrace(this, `Sending character select result:`, action, slot, start);
    keepNotice = false;
    sendCustomPacket(this.controller, { customPacketType: 'characterSelectResult', action, slot, start });
  }

  // Placeholders become [key] labels; a line whose key is unbound is dropped
  private resolveIntroPages(pages: IntroPage[]): IntroPage[] {
    const keys = INTRO_KEYS.map(([placeholder, read]) => {
      let code = 0;
      try { code = read(this.controller); } catch { /* service not registered */ }
      return { placeholder, code };
    });
    return pages
      .map((page) => ({
        caption: page.caption,
        align: page.align,
        text: page.text.split('\n')
          .filter((line) => keys.every((k) => k.code > 0 || line.indexOf(k.placeholder) < 0))
          .map((line) => keys.reduce((s, k) => s.split(k.placeholder).join(`[${keyLabel(k.code)}]`), line))
          .join('\n'),
      }))
      .filter((page) => page.text.trim().length > 0);
  }

  private menuArgs(): Record<string, unknown> {
    return {
      characters, maxCharacters, lockedSlots, selectedSlot, confirmDeleteSlot, events, strings, notice, WIDGET_ID,
      intro, introScreen, introPages, introPage, introPick, INTRO_WIDGET_ID, INTRO_PAGE_WIDGET_ID, INTRO_LIST_WIDGET_ID,
    };
  }

  private renderMenu(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText(this.menuArgs())
    );
  }

  private closeMenu(): void {
    this.menuOpen = false;
    selectedSlot = null;
    confirmDeleteSlot = null;
    notice = '';
    keepNotice = false;
    resetIntro();
    // Clear forms only; chat and other in-game widgets must survive a mid-session reopen.
    this.sp.browser.executeJavaScript(
      'window.skyrimPlatform.widgets.set((window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w&&w.type!=="form";}));'
    );
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser; only the injected variables and window are available here.
  private browsersideWidgetSetter = () => {
    if (introScreen !== null && intro) {
      const form: any = { type: "form", id: INTRO_WIDGET_ID, elements: [] as any[] };
      if (introScreen === "page") {
        const page = introPages[introPage];
        form.id = page.align === "left" ? INTRO_LIST_WIDGET_ID : INTRO_PAGE_WIDGET_ID;
        if (page.caption) form.caption = page.caption;
        form.elements.push({ type: "text", text: page.text, tags: [] });
        form.elements.push({ type: "button", text: strings.back, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], width: 240, click: () => window.skyrimPlatform.sendMessage(events.introBack) });
        form.elements.push({ type: "button", text: strings.next, tags: ["ELEMENT_SAME_LINE"], width: 240, click: () => window.skyrimPlatform.sendMessage(events.introNext) });
      } else if (introScreen === "question") {
        form.caption = intro.question;
        for (let i = 0; i < intro.locations.length; i++) {
          form.elements.push({ type: "button", text: intro.locations[i].label, tags: [], width: 560, click: () => window.skyrimPlatform.sendMessage(events.introPick, i) });
        }
        form.elements.push({ type: "button", text: strings.back, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], width: 240, click: () => window.skyrimPlatform.sendMessage(events.introBack) });
      } else {
        form.caption = intro.question;
        form.elements.push({ type: "text", text: strings.beginAt.replace("{0}", intro.locations[introPick].label), tags: [] });
        form.elements.push({ type: "button", text: strings.back, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], width: 240, click: () => window.skyrimPlatform.sendMessage(events.introCancel) });
        form.elements.push({ type: "button", text: strings.confirm, tags: ["ELEMENT_SAME_LINE"], width: 240, click: () => window.skyrimPlatform.sendMessage(events.introConfirm) });
      }
      const rest = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
      window.skyrimPlatform.widgets.set(rest.concat([form]));
      return;
    }

    const widget: any = { type: "form", id: WIDGET_ID, caption: strings.selectCharacter, elements: [] as any[] };
    if (notice) widget.elements.push({ type: "text", text: notice, tags: [] });

    // Strike through via combining U+0336 overlays; the form renderer has no text styling.
    const strike = (s: string) => s.split("").map((c) => c + String.fromCharCode(0x0336)).join("");

    for (let i = 0; i < maxCharacters; i++) {
      const character = characters[i];
      if (!character && lockedSlots.indexOf(i) >= 0) continue;
      const headerTags = widget.elements.length === 0 ? [] : ["ELEMENT_STYLE_MARGIN_EXTENDED"];

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
      tags: ["ELEMENT_SAME_LINE"],
      isDisabled: selectedSlot === null || selectedDead,
      click: () => window.skyrimPlatform.sendMessage(events.play),
    });

    // Replace form widgets (auth/menu) but keep chat alive: this can render mid-session.
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w && w.type !== "form");
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
  private sawGameplay = false;
  private pauseMenuAt = 0;
}
