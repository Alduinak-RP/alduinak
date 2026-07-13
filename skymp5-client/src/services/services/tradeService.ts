import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { FunctionInfo } from "../../lib/functionInfo";
import { BrowserMessageEvent, ObjectReference } from "skyrimPlatform";
import { getInventory, Entry } from "../../sync/inventory";
import { logTrace } from "../../logging";

// for the browser-side widget setters (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 14; // the two-pane trade window (12 belongs to capture-consent)
const INVITE_WIDGET_ID = 15; // the small "X wants to trade" prompt

// Stacks larger than this prompt for a count when added/removed, like vanilla
// container transfers. Smaller stacks move whole.
const STACK_PROMPT_THRESHOLD = 5;

// Mirror of the server's EXTRA_KEYS (trade.ts): a stack carrying any of these
// is not a "simple" item and cannot be offered.
const EXTRA_KEYS: (keyof Entry)[] = [
  'health', 'enchantmentId', 'maxCharge', 'chargePercent', 'name',
  'soul', 'poisonId', 'poisonCount', 'worn', 'wornLeft',
  'removeEnchantmentOnUnequip',
];

const isSimpleEntry = (e: Entry): boolean => {
  for (const k of EXTRA_KEYS) {
    const v = e[k];
    if (v !== undefined && v !== null && v !== false) {
      return false;
    }
  }
  return true;
};

interface Item {
  baseId: number;
  count: number;
}

interface UiItem extends Item {
  name: string;
}

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
  add: 'trade:add', // (baseId, count) move from inventory -> my offer
  remove: 'trade:remove', // (baseId, count) move from my offer -> inventory
  lock: 'trade:lock',
  unlock: 'trade:unlock',
  accept: 'trade:accept',
  cancel: 'trade:cancel',
  inviteAccept: 'trade:invite:accept',
  inviteDecline: 'trade:invite:decline',
};

// Module-level state shared with the browser-side widget setters via runtime
// injection (same pattern as FactionService / HousingService).
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
 *     { customPacketType: "tradeSetOffer", items: [{ baseId, count }] }
 *     { customPacketType: "tradeLock" | "tradeUnlock" | "tradeAccept" | "tradeCancel" }
 *
 * The window shows the player's own (offerable) inventory on the left and two
 * stacked boxes on the right — their own offer and the partner's. Offers and
 * lock/accept state are owned by the server; the client renders whatever the
 * latest `tradeState` says and only resolves item names locally.
 */
export class TradeService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
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
        this.renderWidget();
        if (this.lockPending) {
          this.lockPending = false;
          // The server wipes the whole offer when a lock fails its affordability
          // check; restore what we can still afford so only the lock resets.
          if (!this.state.myLocked && this.state.myOffer.length === 0
            && prev !== null && prev.myOffer.length > 0) {
            this.restoreOffer(prev.myOffer);
          }
        }
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
            .map((x) => ({ baseId: Number(x?.baseId), count: Number(x?.count) }))
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
      case events.add:
        this.changeOffer(Number(e.arguments[1]), Number(e.arguments[2]), +1);
        break;
      case events.remove:
        this.changeOffer(Number(e.arguments[1]), Number(e.arguments[2]), -1);
        break;
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

  // Move `count` of `baseId` between my inventory and my offer, then ask the
  // server to adopt the new offer. Clamped to what I actually hold so the server
  // never has to reject a sane request.
  private changeOffer(baseId: number, count: number, dir: 1 | -1): void {
    if (!this.state || !Number.isFinite(baseId) || !Number.isFinite(count) || count <= 0) {
      return;
    }
    const offer = this.state.myOffer.map((i) => ({ ...i }));
    const offered = offer.find((i) => i.baseId === baseId);
    const offeredCount = offered ? offered.count : 0;

    let delta: number;
    if (dir > 0) {
      const free = this.ownedCount(baseId) - offeredCount;
      delta = Math.min(count, free);
    } else {
      delta = -Math.min(count, offeredCount);
    }
    if (delta === 0) {
      return;
    }

    if (offered) {
      offered.count += delta;
    } else if (delta > 0) {
      offer.push({ baseId, count: delta });
    }

    const next = offer.filter((i) => i.count > 0);
    this.lockPending = false;
    sendCustomPacket(this.controller, { customPacketType: "tradeSetOffer", items: next });
  }

  // Re-send a wiped offer clamped to what the player still holds.
  private restoreOffer(offer: Item[]): void {
    const items: Item[] = [];
    for (const item of offer) {
      const count = Math.min(item.count, this.ownedCount(item.baseId));
      if (count > 0) {
        items.push({ baseId: item.baseId, count });
      }
    }
    if (items.length > 0) {
      sendCustomPacket(this.controller, { customPacketType: "tradeSetOffer", items });
    }
  }

  // ── Inventory reading ──────────────────────────────────────────────────────

  // How many tradeable (extra-less) copies of baseId the player currently holds.
  private ownedCount(baseId: number): number {
    let total = 0;
    for (const e of this.localSimpleEntries()) {
      if (e.baseId === baseId) {
        total += e.count;
      }
    }
    return total;
  }

  private localSimpleEntries(): Entry[] {
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
    return entries.filter((e) => e.count > 0 && isSimpleEntry(e));
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
    if (!name) {
      name = "0x" + (baseId >>> 0).toString(16);
    }
    this.nameCache.set(baseId, name);
    return name;
  }

  private withNames(items: Item[]): UiItem[] {
    return items.map((i) => ({ baseId: i.baseId, count: i.count, name: this.resolveName(i.baseId) }));
  }

  // The left pane: everything offerable, minus what's already in my offer.
  private availableInventory(): UiItem[] {
    if (!this.state) {
      return [];
    }
    const offered = new Map<number, number>();
    for (const i of this.state.myOffer) {
      offered.set(i.baseId, (offered.get(i.baseId) || 0) + i.count);
    }
    const owned = new Map<number, number>();
    for (const e of this.localSimpleEntries()) {
      owned.set(e.baseId, (owned.get(e.baseId) || 0) + e.count);
    }
    const out: UiItem[] = [];
    owned.forEach((count, baseId) => {
      const available = count - (offered.get(baseId) || 0);
      if (available > 0) {
        out.push({ baseId, count: available, name: this.resolveName(baseId) });
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
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  // The invite is passive: the widget is shown without seizing input focus (the
  // player focuses the browser themselves, as with chat), and a System-tab
  // notification points at it.
  private openInvite(): void {
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.inviteWidgetSetter).getText({ events, inviteFrom, INVITE_WIDGET_ID })
    );
    this.sp.browser.setVisible(true);
    notifyNextUpdate(this.controller, this.sp, inviteFrom + " wants to trade with you.");
  }

  private closeWidget(): void {
    this.sp.browser.executeJavaScript(`(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==${WIDGET_ID};});window.skyrimPlatform.widgets.set(ws);})();`);
  }

  private closeInvite(): void {
    this.sp.browser.executeJavaScript(`(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==${INVITE_WIDGET_ID};});window.skyrimPlatform.widgets.set(ws);})();`);
  }

  private closeAll(): void {
    this.state = null;
    this.lockPending = false;
    this.closeWidget();
    this.closeInvite();
    this.sp.browser.setFocused(false);
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
  private nameCache = new Map<number, string>();
}
