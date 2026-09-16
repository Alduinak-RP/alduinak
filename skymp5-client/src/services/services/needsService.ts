import { Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { onWidgetsCleared } from "./widgetMenuUtil";
import { FunctionInfo } from "../../lib/functionInfo";

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

const WIDGET_ID = 34;

interface NeedsState {
  hunger: number;
  stage: number;
  stageName: string;
  fatigue: number;
}

// Module-level so the browser-side widget setter can read it (runtime injection).
let needs: NeedsState | null = null;

/**
 * Hunger and fatigue HUD. The server (NeedsSystem) owns both values and pushes needsState whenever they change; this
 * service only draws them and closes the Crafting Menu when the server refused a craft for fatigue. The widget lives in
 * the CEF page, so it hides with the interface and under blocking menus like every other widget.
 *
 *   Client -> Server: { "customPacketType": "needsRequest" }
 *   Server -> Client: { "customPacketType": "needsState", "hunger", "stage", "stageName", "fatigue", "closeCrafting"? }
 */
export class NeedsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // Login resets every widget, and a front reload drops them silently
    onWidgetsCleared(this.controller, () => this.controller.once("update", () => {
      this.draw();
      sendCustomPacket(this.controller, { customPacketType: "needsRequest" });
    }));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "needsState") return;
    needs = {
      hunger: Number(content["hunger"]) || 0,
      stage: Number(content["stage"]) || 0,
      stageName: typeof content["stageName"] === "string" ? content["stageName"] as string : "",
      fatigue: Number(content["fatigue"]) || 0,
    };
    const closeCrafting = content["closeCrafting"] === true;
    this.controller.once("update", () => {
      // Papyrus natives are allowed in update; the vanilla menu already made the refused recipe locally
      if (closeCrafting && this.sp.Ui.isMenuOpen(Menu.Crafting)) {
        this.sp.callNative("TESModPlatform", "CloseMenu", undefined, Menu.Crafting);
      }
      this.draw();
    });
  }

  private draw(): void {
    if (!needs) return;
    this.sp.browser.executeJavaScript(new FunctionInfo(this.needsWidgetSetter).getText({ needs, WIDGET_ID }));
  }

  // Runs inside the CEF browser. Only injected vars + window are available.
  // No spread syntax: it breaks after FunctionInfo stringification (8d7c0c05).
  private needsWidgetSetter = () => {
    const widget = {
      type: "needsMeter",
      id: WIDGET_ID,
      hunger: needs ? needs.hunger : 0,
      stage: needs ? needs.stage : 0,
      stageName: needs ? needs.stageName : "",
      fatigue: needs ? needs.fatigue : 0,
    };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };
}
