import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { closeWidget, showUi } from "./widgetMenuUtil";
import { FunctionInfo } from "../../lib/functionInfo";
import { BrowserMessageEvent, ObjectReference } from "skyrimPlatform";
import { getInventory, Entry, isBoundItem, PROPERTY_KEY_BASE_ID } from "../../sync/inventory";
import { logTrace } from "../../logging";

// for the browser-side widget setters (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 14; // the two-pane trade window (12 belongs to capture-consent)
const INVITE_WIDGET_ID = 15; // the small "X wants to trade" prompt

// Stacks larger than this prompt for a count when added/removed (vanilla-style); smaller stacks move whole.
const STACK_PROMPT_THRESHOLD = 5;

// Extras that tell copies apart, same as the server's IDENTITY_KEYS (tradeSystem.ts)
const IDENTITY_KEYS = [
  'health', 'enchantmentId', 'maxCharge', 'removeEnchantmentOnUnequip',
  'soul', 'poisonId', 'poisonCount',
] as const;

const OFFER_KEYS: (keyof Entry)[] = [...IDENTITY_KEYS, 'chargePercent', 'name'];

const TEMPER_LABELS = ['Fine', 'Superior', 'Exquisite', 'Flawless', 'Epic', 'Legendary'];
const SOUL_LABELS = ['Petty', 'Lesser', 'Common', 'Greater', 'Grand'];

const isWorn = (e: Entry): boolean => !!e.worn || !!e.wornLeft;

// Same rule as the server's isSet (tradeSystem.ts)
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== false && v !== 0 && v !== '';

// One inventory entry minus worn flags; the server sets plain when it holds no copy with these extras
type Item = Omit<Entry, 'worn' | 'wornLeft'> & { plain?: boolean };

interface UiItem {
  lineId: string; // rides trade:add/remove events
  baseId: number;
  count: number;
  name: string;
  tags?: string[];
  equipped?: boolean;
}

// Property keys (housing): the name is the credential
const keyName = (i: Item): string =>
  (i.baseId >>> 0) === PROPERTY_KEY_BASE_ID && typeof i.name === 'string' ? i.name : '';

// Same shape as the server's lineKey
const lineKey = (i: Item): string =>
  [i.baseId >>> 0, keyName(i), ...IDENTITY_KEYS.map((k) => (isSet(i[k]) ? String(i[k]) : ''))].join('|');

// Keeps only extras the server accepts (copyValidExtras in tradeSystem.ts), so both sides build the same lineKey
const toItem = (raw: any, count: number): Item => {
  const item: Item = { baseId: Number(raw?.baseId), count };
  for (const k of OFFER_KEYS) {
    const v = raw?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && (v > 0 || (k === 'chargePercent' && v === 0))) {
      (item as any)[k] = v;
    } else if (typeof v === 'string' && v) {
      (item as any)[k] = v.slice(0, 256);
    } else if (v === true) {
      (item as any)[k] = true;
    }
  }
  return item;
};

// Mirror of the server's tradeState packet (this player's point of view).
interface TradeState {
  partnerName: string;
  myOffer: Item[];
  theirOffer: Item[];
  myLocked: boolean;
  theirLocked: boolean;
  bothLocked: boolean;
  iAccepted: boolean;
  theyAccepted: boolean;
}

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  add: 'trade:add', // (lineId, count) move from inventory -> my offer
  remove: 'trade:remove', // (lineId, count) move from my offer -> inventory
  lock: 'trade:lock',
  unlock: 'trade:unlock',
  accept: 'trade:accept',
  cancel: 'trade:cancel',
  inviteAccept: 'trade:invite:accept',
  inviteDecline: 'trade:invite:decline',
};

// Module-level state shared with the browser-side widget setters via runtime injection.
let tradeData: any = {};
let inviteFrom = '';

/**
 * Player-to-player trading. The interact (Y) menu sends a `tradeRequest` for the
 * looked-at player (see PlayerActionService); from there everything is driven by
 * the server through `MsgType.CustomPacket` packets:
 *
 *   Server -> Client
 *     { customPacketType: "tradeInvite", fromName }
 *     { customPacketType: "tradeState", partnerName, myOffer, theirOffer,
 *         myLocked, theirLocked, bothLocked, iAccepted, theyAccepted }
 *     { customPacketType: "tradeCompleted" }
 *     { customPacketType: "tradeCancelled", reason }
 *     { customPacketType: "tradeNotice", text }
 *
 *   Client -> Server
 *     { customPacketType: "tradeRespond", accept }
 *     { customPacketType: "tradeSetOffer", items: [{ baseId, count, ...extras }] }
 *     { customPacketType: "tradeLock" | "tradeUnlock" | "tradeAccept" | "tradeCancel" }
 *
 * The window shows the player's own (offerable) inventory on the left and two
 * stacked boxes on the right: their own offer and the partner's. Offers and
 * lock/accept state are owned by the server; the client renders whatever the
 * latest `tradeState` says and only resolves item names locally.
 */
export class TradeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden) this.cancelOnHide(); });
  }

  // Hiding ends the trade on both sides like the cancel button, else the partner's next move reopens it
  private cancelOnHide(): void {
    if (!this.windowOpen && !this.invitePending) return;
    if (this.windowOpen) {
      sendCustomPacket(this.controller, { customPacketType: "tradeCancel" });
    }
    if (this.invitePending) {
      sendCustomPacket(this.controller, { customPacketType: "tradeRespond", accept: false });
    }
    this.closeAll();
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }

    switch (content["customPacketType"]) {
      case "tradeInvite":
        inviteFrom = typeof content["fromName"] === "string" ? content["fromName"] as string : "Someone";
        logTrace(this, `Trade invite from`, inviteFrom);
        this.openInvite();
        break;
      case "tradeState": {
        const prev = this.state;
        this.state = this.parseState(content);
        this.closeInvite();
        const wasLockPending = this.lockPending;
        this.lockPending = false;
        // Packet handlers run in tick context where inventory natives throw; defer to update
        this.controller.once("update", () => {
          if (!this.state) return;
          this.renderWidget();
          if (wasLockPending) {
            // The server wipes the offer when a lock fails affordability; restore what we can still afford.
            if (!this.state.myLocked && this.state.myOffer.length === 0
              && prev !== null && prev.myOffer.length > 0) {
              this.restoreOffer(prev.myOffer);
            }
          }
        });
        break;
      }
      case "tradeCompleted":
        notifyNextUpdate(this.controller, this.sp, "Trade complete.");
        this.closeAll();
        break;
      case "tradeCancelled":
        if (typeof content["reason"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["reason"] as string);
        }
        this.closeAll();
        break;
      case "tradeNotice":
        if (typeof content["text"] === "string") {
          notifyNextUpdate(this.controller, this.sp, content["text"] as string);
        }
        break;
      default:
        break;
    }
  }

  private parseState(content: Record<string, unknown>): TradeState {
    const items = (v: unknown): Item[] =>
      Array.isArray(v)
        ? (v as any[])
            .map((x) => {
              const item = toItem(x, Number(x?.count));
              if (x?.plain === true) {
                item.plain = true;
              }
              return item;
            })
            .filter((x) => Number.isFinite(x.baseId) && x.count > 0)
        : [];
    return {
      partnerName: typeof content["partnerName"] === "string" ? content["partnerName"] as string : "Player",
      myOffer: items(content["myOffer"]),
      theirOffer: items(content["theirOffer"]),
      myLocked: !!content["myLocked"],
      theirLocked: !!content["theirLocked"],
      bothLocked: !!content["bothLocked"],
      iAccepted: !!content["iAccepted"],
      theyAccepted: !!content["theyAccepted"],
    };
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || key.indexOf("trade:") !== 0) {
      return;
    }

    switch (key) {
      case events.inviteAccept:
        sendCustomPacket(this.controller, { customPacketType: "tradeRespond", accept: true });
        this.closeInvite();
        break;
      case events.inviteDecline:
        sendCustomPacket(this.controller, { customPacketType: "tradeRespond", accept: false });
        this.closeInvite();
        break;
      case events.add: {
        // Browser messages arrive in tick context; inventory natives need update
        const [lineId, count] = [String(e.arguments[1]), Number(e.arguments[2])];
        this.controller.once("update", () => this.changeOffer(lineId, count, +1));
        break;
      }
      case events.remove: {
        const [lineId, count] = [String(e.arguments[1]), Number(e.arguments[2])];
        this.controller.once("update", () => this.changeOffer(lineId, count, -1));
        break;
      }
      case events.lock:
        this.lockPending = true;
        sendCustomPacket(this.controller, { customPacketType: "tradeLock" });
        break;
      case events.unlock:
        sendCustomPacket(this.controller, { customPacketType: "tradeUnlock" });
        break;
      case events.accept:
        sendCustomPacket(this.controller, { customPacketType: "tradeAccept" });
        break;
      case events.cancel:
        sendCustomPacket(this.controller, { customPacketType: "tradeCancel" });
        this.closeAll();
        break;
      default:
        break;
    }
  }

  // Move `count` of one line between inventory and offer, then send it; clamped to what I actually hold.
  private changeOffer(lineId: string, count: number, dir: 1 | -1): void {
    if (!this.state || !Number.isFinite(count) || count <= 0) {
      return;
    }
    const offer = this.state.myOffer.map((i) => toItem(i, i.count));
    const offered = offer.find((i) => lineKey(i) === lineId);
    const offeredCount = offered ? offered.count : 0;
    const owned = this.localLines().get(lineId);

    let delta: number;
    if (dir > 0) {
      delta = Math.min(count, (owned ? owned.item.count : 0) - offeredCount);
    } else {
      delta = -Math.min(count, offeredCount);
    }
    if (delta === 0) {
      return;
    }

    if (offered) {
      offered.count += delta;
    } else if (delta > 0 && owned) {
      offer.push(toItem(owned.item, delta));
    }

    const next = offer.filter((i) => i.count > 0);
    this.lockPending = false;
    sendCustomPacket(this.controller, { customPacketType: "tradeSetOffer", items: next });
  }

  // Re-send a wiped offer clamped to what the player still holds.
  private restoreOffer(offer: Item[]): void {
    const lines = this.localLines();
    const items: Item[] = [];
    for (const item of offer) {
      const owned = lines.get(lineKey(item));
      const count = Math.min(item.count, owned ? owned.item.count : 0);
      if (count > 0) {
        items.push(toItem(item, count));
      }
    }
    if (items.length > 0) {
      sendCustomPacket(this.controller, { customPacketType: "tradeSetOffer", items });
    }
  }

  // ── Inventory reading ──────────────────────────────────────────────────────

  // Offerable lines by lineKey; equipped and loose copies count together
  private localLines(): Map<string, { item: Item; equipped: boolean }> {
    const lines = new Map<string, { item: Item; equipped: boolean }>();
    for (const e of this.localTradeableEntries()) {
      const item = toItem(e, e.count);
      const id = lineKey(item);
      let line = lines.get(id);
      if (line) {
        line.item.count += e.count;
      } else {
        line = { item, equipped: false };
        lines.set(id, line);
      }
      if (isWorn(e)) {
        line.equipped = true;
      }
    }
    return lines;
  }

  private localTradeableEntries(): Entry[] {
    const player = this.sp.Game.getPlayer() as ObjectReference | null;
    if (!player) {
      return [];
    }
    let entries: Entry[] = [];
    try {
      entries = getInventory(player).entries;
    } catch (e) {
      return [];
    }
    // Summoned bound weapons and arrows are worn but never held by the server inventory
    return entries
      .map((e) => this.withoutDefaultName(e))
      .filter((e) => e.count > 0 && !this.isSummonedBoundItem(e.baseId));
  }

  private isSummonedBoundItem(baseId: number): boolean {
    const form = this.sp.Game.getFormEx(baseId);
    return !!form && isBoundItem(form);
  }

  // applyInventory stamps server items with their form name as TextDisplayData; same rule as containersService
  private withoutDefaultName(e: Entry): Entry {
    if (typeof e.name !== "string" || e.name !== this.resolveName(e.baseId)) {
      return e;
    }
    const copy = { ...e };
    delete copy.name;
    return copy;
  }

  private resolveName(baseId: number): string {
    const cached = this.nameCache.get(baseId);
    if (cached !== undefined) {
      return cached;
    }
    let name = "";
    try {
      const form = this.sp.Game.getFormEx(baseId);
      name = (form && form.getName && form.getName()) || "";
    } catch (e) {
      name = "";
    }
    // Only cache real names so a transient native failure cannot stick
    if (name) {
      this.nameCache.set(baseId, name);
      return name;
    }
    return "0x" + (baseId >>> 0).toString(16);
  }

  private toUiItem(i: Item, count = i.count): UiItem {
    const ui: UiItem = {
      lineId: lineKey(i),
      baseId: i.baseId,
      count,
      name: i.name ? i.name : this.resolveName(i.baseId),
    };
    const tags = this.extraTags(i);
    if (tags.length > 0) {
      ui.tags = tags;
    }
    return ui;
  }

  // Vanilla-style labels for tempering, enchantment, charge, soul and poison
  private extraTags(i: Item): string[] {
    const tags: string[] = [];
    const tier = i.health ? Math.floor((i.health - 1) * 10 + 1e-3) : 0;
    if (tier >= 1) {
      tags.push(TEMPER_LABELS[Math.min(tier, TEMPER_LABELS.length) - 1]);
    }
    if (i.enchantmentId) {
      tags.push("enchanted");
    }
    const maxCharge = i.chargePercent !== undefined ? i.maxCharge || this.baseCharge(i.baseId) : 0;
    if (maxCharge > 0) {
      tags.push("charge " + Math.round(Math.min(100, ((i.chargePercent as number) / maxCharge) * 100)) + "%");
    }
    if (i.soul && SOUL_LABELS[i.soul - 1]) {
      tags.push(SOUL_LABELS[i.soul - 1] + " soul");
    }
    if (i.poisonId) {
      tags.push("poisoned");
    }
    if (i.plain) {
      tags.push("trades as plain");
    }
    return tags;
  }

  // Charge capacity of a weapon enchanted in its base record
  private baseCharge(baseId: number): number {
    try {
      const weapon = this.sp.Weapon.from(this.sp.Game.getFormEx(baseId));
      return weapon ? weapon.getEnchantmentValue() : 0;
    } catch (e) {
      return 0;
    }
  }

  private withNames(items: Item[]): UiItem[] {
    return items.map((i) => this.toUiItem(i));
  }

  // The left pane: everything offerable, minus what's already in my offer.
  private availableInventory(): UiItem[] {
    if (!this.state) {
      return [];
    }
    const offered = new Map<string, number>();
    for (const i of this.state.myOffer) {
      const id = lineKey(i);
      offered.set(id, (offered.get(id) || 0) + i.count);
    }
    const out: UiItem[] = [];
    this.localLines().forEach(({ item, equipped }, id) => {
      const available = item.count - (offered.get(id) || 0);
      if (available > 0) {
        const ui = this.toUiItem(item, available);
        if (equipped) {
          ui.equipped = true;
        }
        out.push(ui);
      }
    });
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  // ── Widget rendering ─────────────────────────────────────────────────────────

  private renderWidget(): void {
    if (!this.state) {
      return;
    }
    tradeData = {
      partnerName: this.state.partnerName,
      inventory: this.availableInventory(),
      myOffer: this.withNames(this.state.myOffer),
      theirOffer: this.withNames(this.state.theirOffer),
      myLocked: this.state.myLocked,
      theirLocked: this.state.theirLocked,
      bothLocked: this.state.bothLocked,
      iAccepted: this.state.iAccepted,
      theyAccepted: this.state.theyAccepted,
      stackPromptThreshold: STACK_PROMPT_THRESHOLD,
      events,
    };
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.tradeWidgetSetter).getText({ tradeData, WIDGET_ID })
    );
    showUi(this.controller);
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
    this.windowOpen = true;
  }

  // Passive invite: shown without seizing input focus (like chat); a System-tab notification points at it.
  private openInvite(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.inviteWidgetSetter).getText({ events, inviteFrom, INVITE_WIDGET_ID })
    );
    showUi(this.controller);
    this.sp.browser.setVisible(true);
    this.invitePending = true;
    notifyNextUpdate(this.controller, this.sp, inviteFrom + " wants to trade with you.");
  }

  private closeWidget(): void {
    closeWidget(this.sp, WIDGET_ID);
  }

  private closeInvite(): void {
    this.invitePending = false;
    closeWidget(this.sp, INVITE_WIDGET_ID);
  }

  private closeAll(): void {
    this.state = null;
    this.lockPending = false;
    this.closeWidget();
    this.closeInvite();
    // Only surrender focus we actually took (the invite never grabs it).
    if (this.windowOpen) {
      this.windowOpen = false;
      this.sp.browser.setFocused(false);
    }
  }

  // Runs inside the CEF browser. Only injected vars + `window` are available.
  private tradeWidgetSetter = () => {
    const widget: any = Object.assign({ type: "trade", id: WIDGET_ID }, tradeData);
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private inviteWidgetSetter = () => {
    const widget: any = {
      type: "form",
      id: INVITE_WIDGET_ID,
      caption: "Trade Request",
      elements: [
        { type: "text", text: inviteFrom + " wants to trade with you.", tags: [] },
        { type: "button", text: "Accept", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.inviteAccept) },
        { type: "button", text: "Decline", tags: ["ELEMENT_SAME_LINE"], click: () => window.skyrimPlatform.sendMessage(events.inviteDecline) },
      ],
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== INVITE_WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  // ── Networking & misc ─────────────────────────────────────────────────────────

  private state: TradeState | null = null;
  private lockPending = false;
  private windowOpen = false;
  private invitePending = false;
  private nameCache = new Map<number, string>();
}
