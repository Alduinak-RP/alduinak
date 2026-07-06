import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, notifyNextUpdate } from "./customPacketUtil";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 10;

interface PlayerAction {
  id: string;
  label: string;
  group: string;
  tmpl: string; // '<n>' = target's name
}

const ACTIONS: PlayerAction[] = [
  { id: 'appoint_steward', label: 'Appoint: Steward', group: 'Hold', tmpl: '/appoint <n> steward' },
  { id: 'appoint_captain', label: 'Appoint: Captain', group: 'Hold', tmpl: '/appoint <n> captain' },
  { id: 'appoint_courtwizard', label: 'Appoint: Court Wizard', group: 'Hold', tmpl: '/appoint <n> courtwizard' },
  { id: 'appoint_thane', label: 'Appoint: Thane', group: 'Hold', tmpl: '/appoint <n> thane' },
  { id: 'appoint_housecarl', label: 'Appoint: Housecarl', group: 'Hold', tmpl: '/appoint <n> housecarl' },
  { id: 'appoint_elder', label: 'Appoint: Village Elder', group: 'Hold', tmpl: '/appoint <n> villageelder' },
  { id: 'appoint_guard', label: 'Appoint: Guard', group: 'Hold', tmpl: '/appoint <n> guard' },
  { id: 'appoint_lord', label: 'Appoint: Lord/Lady', group: 'Hold', tmpl: '/appoint <n> lord' },
  { id: 'appoint_citizen', label: 'Appoint: Citizen', group: 'Hold', tmpl: '/appoint <n> citizen' },
  { id: 'dismiss', label: 'Dismiss from hold', group: 'Hold', tmpl: '/dismiss <n>' },
  { id: 'arrest', label: 'Arrest', group: 'Justice', tmpl: '/arrest <n>' },
  { id: 'sentence_release', label: 'Sentence: release', group: 'Justice', tmpl: '/sentence <n> release' },
  { id: 'sentence_banish', label: 'Sentence: banish', group: 'Justice', tmpl: '/sentence <n> banish' },
  { id: 'capture', label: 'Capture', group: 'Captivity', tmpl: '' },
  { id: 'carry', label: 'Carry', group: 'Captivity', tmpl: '' },
  { id: 'putdown', label: 'Put down', group: 'Captivity', tmpl: '' },
  { id: 'release', label: 'Release', group: 'Captivity', tmpl: '' },
  { id: 'down', label: 'Down', group: 'Combat', tmpl: '/down <n>' },
  { id: 'rise', label: 'Rise', group: 'Combat', tmpl: '/rise <n>' },
  { id: 'bounty', label: 'Check bounty', group: 'Info', tmpl: '/bounty check <n>' },
  { id: 'slots', label: 'Faction slots', group: 'Info', tmpl: '/faction slots <n>' },
  { id: 'sober', label: 'Sober', group: 'Staff', tmpl: '/sober <n>' },
  { id: 'feed', label: 'Feed', group: 'Staff', tmpl: '/feed <n>' },
  { id: 'nvfl', label: 'Clear NVFL', group: 'Staff', tmpl: '/nvfl clear <n>' },
];

// Captivity actions are sent to the gamemode's CaptureSystem as custom packets
// (keyed by the looked-at player's server form id), not as chat commands.
const PACKET_ACTIONS: Record<string, string> = {
  capture: 'captureRequest',
  carry: 'carryRequest',
  putdown: 'putdownRequest',
  release: 'releaseRequest',
};

const events = {
  action: 'pa:action',
  close: 'pa:close',
  // House actions (namespaced under 'pa:' so HousingService ignores them).
  hClaim: 'pa:h:claim',
  hLock: 'pa:h:lock',
  hUnlock: 'pa:h:unlock',
  hTransfer: 'pa:h:transfer',
};

// Module-level so the browser-side widget setter can read it (runtime injection).
let targetName = '';

/**
 * Look-at-target interaction menu (default Y). Looking at a player opens the
 * player-action / hold-appointment menu (chat commands). Looking at a door or
 * container opens a house menu that sends the same `propertyRequest` packets as
 * the housing key. Drives the gamemode through its existing contracts.
 */
export class PlayerActionService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings && typeof settings["interactMenuKeyCode"] === "number") {
        this.menuKey = settings["interactMenuKeyCode"];
      }
    } catch {
      // default key
    }
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    if (this.sp.browser.isFocused()) {
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();

    // Second step of a house transfer: this press picks the new owner.
    if (this.pendingTransfer !== null) {
      const transferTarget = this.pendingTransfer;
      this.pendingTransfer = null;
      const recipient = ref && Actor.from(ref) ? ref : null;
      if (!recipient) {
        notifyNextUpdate(this.controller, this.sp, "Transfer cancelled - that is not a person.");
        return;
      }
      sendCustomPacket(this.controller, {
        customPacketType: "propertyRequest",
        action: "transfer",
        target: transferTarget,
        recipient: localIdToRemoteId(recipient.getFormID()),
      });
      return;
    }

    if (!ref) {
      notifyNextUpdate(this.controller, this.sp, "Look at a player, door, or container.");
      return;
    }

    // A person -> player/appointment menu. An object -> house menu.
    const actor = Actor.from(ref);
    if (actor && ref.getFormID() !== 0x14) {
      targetName = (ref.getName() || "").trim();
      if (!targetName) {
        notifyNextUpdate(this.controller, this.sp, "That target has no name.");
        return;
      }
      this.playerTarget = localIdToRemoteId(ref.getFormID());
      this.mode = "player";
      logTrace(this, `Opening player-action menu for`, targetName);
      this.openMenu();
    } else if (!actor) {
      this.houseTarget = localIdToRemoteId(ref.getFormID());
      targetName = (ref.getName() || "this").trim() || "this";
      this.mode = "house";
      logTrace(this, `Opening house menu for`, targetName, `(${this.houseTarget})`);
      this.openMenu();
    } else {
      notifyNextUpdate(this.controller, this.sp, "Look at a player, door, or container.");
    }
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== "string" || !key.startsWith("pa:") || !this.menuOpen) {
      return;
    }
    if (key === events.close) {
      this.closeMenu();
      return;
    }
    if (key === events.action) {
      const actionId = typeof e.arguments[1] === "string" ? (e.arguments[1] as string) : "";
      const packetType = PACKET_ACTIONS[actionId];
      if (packetType) {
        // Captivity actions go to the server's CaptureSystem by server form id.
        if (this.playerTarget) {
          sendCustomPacket(this.controller, { customPacketType: packetType, target: this.playerTarget });
        } else {
          notifyNextUpdate(this.controller, this.sp, "Look at a player first.");
        }
      } else {
        const action = ACTIONS.find((a) => a.id === actionId);
        if (action && targetName) {
          this.sendCommand(action.tmpl.replace("<n>", targetName));
        }
      }
      this.closeMenu();
      return;
    }
    // House actions send propertyRequest packets for the looked-at reference.
    const target = this.houseTarget;
    switch (key) {
      case events.hClaim:
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "claim", target });
        this.closeMenu();
        break;
      case events.hLock:
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "lock", target });
        this.closeMenu();
        break;
      case events.hUnlock:
        sendCustomPacket(this.controller, { customPacketType: "propertyRequest", action: "unlock", target });
        this.closeMenu();
        break;
      case events.hTransfer:
        this.pendingTransfer = target;
        this.closeMenu();
        notifyNextUpdate(this.controller, this.sp, "Look at the new owner and press the interact key.");
        break;
      default:
        break;
    }
  }

  private sendCommand(text: string): void {
    logTrace(this, `Player-action command:`, text);
    sendCustomPacket(this.controller, { type: "cef::chat:send", data: text });
  }

  private openMenu(): void {
    this.menuOpen = true;
    const setter = this.mode === "house" ? this.houseWidgetSetter : this.playerWidgetSetter;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(setter).getText({ ACTIONS, targetName, events, WIDGET_ID })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.sp.browser.executeJavaScript('(function(){var ws=(window.skyrimPlatform.widgets.get()||[]).filter(function(w){return w.id!==10;});window.skyrimPlatform.widgets.set(ws);})();');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  private playerWidgetSetter = () => {
    const elements: any[] = [];
    let lastGroup = "";
    for (let i = 0; i < ACTIONS.length; i++) {
      const a = ACTIONS[i];
      if (a.group !== lastGroup) {
        lastGroup = a.group;
        elements.push({ type: "text", text: a.group, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"] });
      }
      elements.push({ type: "button", text: a.label, tags: [], click: () => window.skyrimPlatform.sendMessage(events.action, a.id) });
    }
    elements.push({ type: "button", text: "close", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });

    const widget = { type: "form", id: WIDGET_ID, caption: "Actions: " + targetName, elements: elements };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private houseWidgetSetter = () => {
    const elements: any[] = [];
    elements.push({ type: "text", text: "Manage: " + targetName, tags: [] });
    const actions: [string, string][] = [
      ["claim", events.hClaim],
      ["lock", events.hLock],
      ["unlock", events.hUnlock],
      ["transfer", events.hTransfer],
    ];
    for (let i = 0; i < actions.length; i++) {
      elements.push({ type: "button", text: actions[i][0], tags: [], click: () => window.skyrimPlatform.sendMessage(actions[i][1]) });
    }
    elements.push({ type: "button", text: "close", tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.close) });

    const widget = { type: "form", id: WIDGET_ID, caption: "Property", elements: elements };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private menuKey: DxScanCode = DxScanCode.Y;
  private menuOpen = false;
  private mode: "player" | "house" = "player";
  private houseTarget = 0;
  private playerTarget = 0;
  private pendingTransfer: number | null = null;
}
