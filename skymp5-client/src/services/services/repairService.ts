import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, parseCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { openFormMenu, refreshFormMenu, closeFormMenu, buttonEventKeyCode } from "./widgetMenuUtil";
import { requestPcInventoryApply } from "./remoteServer";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { canRenameInPlace, getDurabilityConfig, setDurabilityConfig } from "../../sync/durabilityNames";
import { logToPlatformLog, logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 42;

// Event keys exchanged with the browser. Namespaced to avoid collisions.
const events = {
  repair: 'repairMenu:repair',
  repairAll: 'repairMenu:repairAll',
  improve: 'repairMenu:improve',
  close: 'repairMenu:close',
};

interface RepairCost {
  baseId: number;
  name: string;
  need: number;
  have: number;
}

interface RepairRow {
  // The server's own handle of a copy, sent back as it came
  key: string | number;
  baseId: number;
  name: string;
  percent: number;
  hp: number;
  maxHp: number;
  worn: boolean;
  cost: RepairCost[];
}

// The server's repairMenu packet, mirrored into the widget
interface RepairInfo {
  bench: number;
  kind: string;
  title: string;
  rows: RepairRow[];
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let info: RepairInfo = { bench: 0, kind: "", title: "", rows: [] };

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const rowKey = (v: unknown): string | number => (typeof v === "number" && Number.isFinite(v) ? v : text(v));

const parseRow = (raw: any): RepairRow => ({
  key: rowKey(raw?.key),
  baseId: count(raw?.baseId),
  name: text(raw?.name),
  percent: count(raw?.percent),
  hp: count(raw?.hp),
  maxHp: count(raw?.maxHp),
  worn: raw?.worn === true,
  cost: (Array.isArray(raw?.cost) ? raw.cost : []).map((c: any) => ({ baseId: count(c?.baseId), name: text(c?.name), need: count(c?.need), have: count(c?.have) })),
});

// Durability: stores the server's durabilityConfig and runs the repair menu of a workbench (armor, shields) or grindstone (weapons, bows)
// The server opens the menu and owns every repair and cost (durabilitySystem.ts); all packets are MsgType.CustomPacket with a JSON dump
// Server -> Client: { customPacketType: "durabilityConfig", enabled, showAtFull, brokenLabel }
// Server -> Client: { customPacketType: "repairMenu", bench, kind, title, reason: "open" | "refresh", rows: [{ key, baseId, name, percent, hp, maxHp, worn, cost: [{ baseId, name, need, have }] }] }
// Server -> Client: { customPacketType: "repairNotice", text }
// Client -> Server: { customPacketType: "durabilityRepair", bench, keys: [key] } or { customPacketType: "durabilityRepair", bench, all: true }
// Client -> Server: { customPacketType: "durabilityImprove", bench } and { customPacketType: "durabilityClose" }
export class RepairService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // A server that never sends durabilityConfig shows no condition in any name
    this.controller.emitter.on("connectionAccepted", () => this.setConfig(null));
    // A front reload drops the widget without a close message; the server still holds the bench session
    this.controller.emitter.on("browserWindowLoaded", () => {
      if (!this.menuOpen) return;
      this.menuOpen = false;
      this.sendClose();
    });
    this.controller.emitter.on("uiHiddenChanged", (e) => { if (e.hidden && this.menuOpen) this.closeMenu(); });
    this.controller.emitter.on("connectionDisconnect", () => { if (this.menuOpen) this.closeMenu(); });
  }

  private setConfig(next: { enabled?: boolean; showAtFull?: boolean; brokenLabel?: string } | null): void {
    if (!setDurabilityConfig(next)) return;
    const config = getDurabilityConfig();
    if (config.enabled) {
      const rename = canRenameInPlace() ? "worn items are renamed in place" : "setInventoryItemName is not in this SkyrimPlatform, so a copy keeps the tag it was added under";
      logToPlatformLog(this, `condition tags on: pristine shown ${config.showAtFull}, broken label ${config.brokenLabel}; ${rename}`);
    } else {
      logTrace(this, `Condition tags off`);
    }
    requestPcInventoryApply();
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.isDown && this.menuOpen && buttonEventKeyCode(e) === DxScanCode.Escape) this.closeMenu();
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content) return;

    switch (content["customPacketType"]) {
      case "durabilityConfig":
        this.setConfig({
          enabled: content["enabled"] !== false,
          showAtFull: content["showAtFull"] !== false,
          brokenLabel: text(content["brokenLabel"]),
        });
        break;
      case "repairMenu": {
        // A refresh after a repair updates the open menu but never opens a closed one
        const refresh = content["reason"] !== undefined && content["reason"] !== "open";
        if (refresh && !this.menuOpen) break;
        info = {
          bench: count(content["bench"]),
          kind: text(content["kind"]),
          title: text(content["title"]),
          rows: (Array.isArray(content["rows"]) ? content["rows"] : []).map(parseRow),
        };
        if (this.menuOpen) {
          refreshFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, WIDGET_ID });
          break;
        }
        logTrace(this, `Opening the repair menu of`, info.bench.toString(16), `with`, info.rows.length, `rows`);
        this.openMenu();
        break;
      }
      case "repairNotice":
        if (text(content["text"])) notifyNextUpdate(this.controller, this.sp, text(content["text"]));
        break;
      default:
        break;
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    // Escape pressed inside the browser closes the menu on the first press.
    if (key === "menu:escape") {
      if (this.menuOpen) this.closeMenu();
      return;
    }
    if (typeof key !== "string" || !key.startsWith("repairMenu:") || !this.menuOpen) return;

    if (key === events.close) {
      this.closeMenu();
    } else if (key === events.repair) {
      const row = rowKey(e.arguments[1]);
      if (row !== "") sendCustomPacket(this.controller, { customPacketType: "durabilityRepair", bench: info.bench, keys: [row] });
    } else if (key === events.repairAll) {
      sendCustomPacket(this.controller, { customPacketType: "durabilityRepair", bench: info.bench, all: true });
    } else if (key === events.improve) {
      // The server opens the vanilla bench itself, which needs the browser out of the way
      this.menuOpen = false;
      closeFormMenu(this.sp, WIDGET_ID);
      sendCustomPacket(this.controller, { customPacketType: "durabilityImprove", bench: info.bench });
    }
  }

  private openMenu(): void {
    this.menuOpen = true;
    openFormMenu(this.sp, this.browsersideWidgetSetter, { events, info, WIDGET_ID }, this.controller);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    closeFormMenu(this.sp, WIDGET_ID);
    this.sendClose();
  }

  // The server keeps the bench of the open menu per player
  private sendClose(): void {
    sendCustomPacket(this.controller, { customPacketType: "durabilityClose" });
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "repairMenu",
      id: WIDGET_ID,
      kind: info.kind,
      title: info.title,
      rows: info.rows,
      events: events,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuOpen = false;
}
