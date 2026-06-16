import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { FunctionInfo } from "../../lib/functionInfo";
import { Actor, BrowserMessageEvent, ButtonEvent, DxScanCode } from "skyrimPlatform";
import { localIdToRemoteId } from "../../view/worldViewMisc";
import { logTrace } from "../../logging";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

// Event keys exchanged with the browser. Namespaced so they don't collide with
// other services listening to "browserMessage".
const events = {
  claim: 'housing:claim',
  abandon: 'housing:abandon',
  lock: 'housing:lock',
  unlock: 'housing:unlock',
  transfer: 'housing:transfer',
  cancel: 'housing:cancel',
};

const translations = {
  "ru": {
    manage: 'Управление',
    claim: 'занять',
    abandon: 'освободить',
    lock: 'запереть',
    unlock: 'отпереть',
    transfer: 'передать',
    cancel: 'отмена',
    lookAtTarget: 'Наведитесь на дверь или контейнер',
    lookAtNewOwner: 'Наведитесь на нового владельца и нажмите клавишу',
    transferCancelled: 'Передача отменена',
  },
  "en": {
    manage: 'Manage',
    claim: 'claim',
    abandon: 'abandon',
    lock: 'lock',
    unlock: 'unlock',
    transfer: 'transfer',
    cancel: 'cancel',
    lookAtTarget: 'Look at a door or container',
    lookAtNewOwner: 'Look at the new owner and press the housing key',
    transferCancelled: 'Transfer cancelled',
  },
} as const;

type TranslationStrings = { [K in keyof typeof translations['ru']]: string };

// Module-level state shared with the browser-side widget setter via runtime
// injection (see AuthService / CharacterSelectService for the same pattern).
let strings: TranslationStrings = translations['en'];
let targetName = '';

/**
 * Lets a player manage the door/container they're looking at: claim/abandon a
 * house (the door's interior cell) and lock/unlock a door or container they own.
 *
 * Press the housing key (default H) while the crosshair is on a door/container
 * to open a small menu. The chosen action is sent to the gamemode, which owns
 * all the policy — ownership, who may claim/lock, Jarl auto-claim and guard
 * powers (factions), and the actual lock enforcement.
 *
 * Protocol — both messages are {@link MsgType.CustomPacket} with a JSON dump.
 *
 *   Client -> Server, the player's request (target is the form id of the
 *   door/container, in server format):
 *     { "customPacketType": "propertyRequest",
 *       "action": "claim" | "abandon" | "lock" | "unlock",
 *       "target": 0x0001a6f4 }
 *
 *   Server -> Client, feedback shown as a corner notification:
 *     { "customPacketType": "propertyNotice", "text": "You now own this house." }
 *
 * Inert until the player presses the key; sends nothing unless a door/container
 * is targeted.
 */
export class HousingService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("browserMessage", (e) => this.onBrowserMessage(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));

    try {
      const settings = this.sp.settings["skymp5-client"] as any;
      if (settings) {
        if (typeof settings["housingMenuKeyCode"] === "number") {
          this.menuKey = settings["housingMenuKeyCode"];
        }
        if (settings["language"] && settings["language"] in translations) {
          strings = translations[settings["language"] as keyof typeof translations];
        }
      }
    } catch {
      // fall back to defaults
    }
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (e.code !== this.menuKey || !e.isDown || this.menuOpen) {
      return;
    }
    // Don't hijack the key while the player is typing in chat or a menu is up.
    if (this.sp.browser.isFocused()) {
      return;
    }

    // If a transfer is pending, this press picks the new owner (a player).
    if (this.pendingTransferLocalId !== 0) {
      const door = this.pendingTransferLocalId;
      this.pendingTransferLocalId = 0;
      const targeted = this.sp.Game.getCurrentCrosshairRef();
      const recipient = targeted && Actor.from(targeted) ? targeted : null;
      if (!recipient || recipient.getFormID() === 0x14) {
        // Not a (different) player — cancel rather than transfer to nothing/self.
        this.sp.Debug.notification(strings.transferCancelled);
        return;
      }
      this.sendTransfer(door, recipient.getFormID());
      return;
    }

    const ref = this.sp.Game.getCurrentCrosshairRef();
    if (!ref || Actor.from(ref)) {
      // Nothing targeted, or it's a person — houses are doors/containers.
      this.sp.Debug.notification(strings.lookAtTarget);
      return;
    }

    this.targetLocalId = ref.getFormID();
    targetName = ref.getName() || '';
    logTrace(this, `Opening housing menu for`, targetName, `(0x${this.targetLocalId.toString(16)})`);
    this.openMenu();
  }

  private onBrowserMessage(e: BrowserMessageEvent): void {
    const key = e.arguments[0];
    if (typeof key !== 'string' || !key.startsWith('housing:') || !this.menuOpen) {
      return;
    }

    switch (key) {
      case events.claim:
        this.sendRequest('claim');
        this.closeMenu();
        break;
      case events.abandon:
        this.sendRequest('abandon');
        this.closeMenu();
        break;
      case events.lock:
        this.sendRequest('lock');
        this.closeMenu();
        break;
      case events.unlock:
        this.sendRequest('unlock');
        this.closeMenu();
        break;
      case events.transfer:
        // Defer to a second key press where the player looks at the new owner.
        this.pendingTransferLocalId = this.targetLocalId;
        this.closeMenu();
        this.sp.Debug.notification(strings.lookAtNewOwner);
        break;
      case events.cancel:
        this.closeMenu();
        break;
      default:
        break;
    }
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    let content: Record<string, unknown> = {};
    try {
      content = JSON.parse(event.message.contentJsonDump);
    } catch (e) {
      return;
    }
    if (content["customPacketType"] === "propertyNotice" && typeof content["text"] === "string") {
      this.sp.Debug.notification(content["text"]);
    }
  }

  private sendRequest(action: 'claim' | 'abandon' | 'lock' | 'unlock'): void {
    const target = localIdToRemoteId(this.targetLocalId);
    if (!target) {
      logTrace(this, `Could not resolve target id for housing request`);
      return;
    }
    logTrace(this, `Housing request`, action, `target 0x${target.toString(16)}`);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({
        customPacketType: "propertyRequest",
        action,
        target,
      }),
    };
    this.controller.emitter.emit("sendMessage", {
      message,
      reliability: "reliable",
    });
  }

  private sendTransfer(doorLocalId: number, recipientLocalId: number): void {
    const target = localIdToRemoteId(doorLocalId);
    const recipient = localIdToRemoteId(recipientLocalId);
    if (!target || !recipient) {
      logTrace(this, `Could not resolve ids for transfer`);
      return;
    }
    logTrace(this, `Housing transfer 0x${target.toString(16)} -> 0x${recipient.toString(16)}`);
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({
        customPacketType: "propertyRequest",
        action: "transfer",
        target,
        recipient,
      }),
    };
    this.controller.emitter.emit("sendMessage", {
      message,
      reliability: "reliable",
    });
  }

  private openMenu(): void {
    this.menuOpen = true;
    this.sp.browser.executeJavaScript(
      new FunctionInfo(this.browsersideWidgetSetter).getText({ events, strings, targetName })
    );
    this.sp.browser.setVisible(true);
    this.sp.browser.setFocused(true);
  }

  private closeMenu(): void {
    this.menuOpen = false;
    this.sp.browser.executeJavaScript('window.skyrimPlatform.widgets.set([]);');
    this.sp.browser.setFocused(false);
  }

  // Runs inside the CEF browser. Only the injected variables (events, strings,
  // targetName) and `window` are available here.
  private browsersideWidgetSetter = () => {
    const widget = {
      type: "form",
      id: 8,
      caption: targetName ? `${strings.manage}: ${targetName}` : strings.manage,
      elements: [
        { type: "button", text: strings.claim, tags: [], click: () => window.skyrimPlatform.sendMessage(events.claim) },
        { type: "button", text: strings.abandon, tags: [], click: () => window.skyrimPlatform.sendMessage(events.abandon) },
        { type: "button", text: strings.lock, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.lock) },
        { type: "button", text: strings.unlock, tags: [], click: () => window.skyrimPlatform.sendMessage(events.unlock) },
        { type: "button", text: strings.transfer, tags: ["ELEMENT_STYLE_MARGIN_EXTENDED"], click: () => window.skyrimPlatform.sendMessage(events.transfer) },
        { type: "button", text: strings.cancel, tags: [], click: () => window.skyrimPlatform.sendMessage(events.cancel) },
      ],
    };
    window.skyrimPlatform.widgets.set([widget]);
  };

  private menuKey: DxScanCode = DxScanCode.H;
  private menuOpen = false;
  private targetLocalId = 0;
  private pendingTransferLocalId = 0;
}
