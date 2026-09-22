import { Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { onWidgetsCleared } from "./widgetMenuUtil";
import { applyNeedsPenalties } from "../../sync/attributePenalty";
import { logToPlatformLog } from "../../logging";

// Globals the Survival DOBJ keys name: the HUD draws their 0-100 value as the red end of a meter
const UPDATE_ESM = "Update.esm";
const HUNGER_PENALTY_GLOBAL = 0x2edf;
const EXHAUSTION_PENALTY_GLOBAL = 0x2ee0;
const COLD_PENALTY_GLOBAL = 0x2ede;
const SURVIVAL_PLUGIN = "ccQDRSSE001-SurvivalMode.esl";
// Survival_ModeToggle, the switch HUDMenu polls for ShowSurvivalElements; Survival_ModeEnabled (0x826) is script-only
const SURVIVAL_MODE_GLOBAL = 0x828;

interface NeedsState {
  staminaPenalty: number;
  magickaPenalty: number;
  survivalMode: boolean;
}

/**
 * Hunger and fatigue on the vanilla HUD. The server (NeedsSystem) owns both values and pushes needsState whenever they
 * change; this service applies the max stamina (hunger) and max magicka (fatigue) penalty shares the server sends, shows
 * them as Survival's red meter segments, and closes the Crafting Menu when the server refused a craft for fatigue.
 *
 *   Client -> Server: { "customPacketType": "needsRequest" }
 *   Server -> Client: { "customPacketType": "needsState", "hunger", "stage", "stageName", "fatigue", "fatigueStage",
 *                       "fatigueStageName", "staminaPenalty", "magickaPenalty", "survivalMode", "closeCrafting"? }
 */
export class NeedsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // Login resets every widget, and a front reload drops them silently
    onWidgetsCleared(this.controller, () => this.controller.once("update", () => {
      this.lastHudLog = "";
      sendCustomPacket(this.controller, { customPacketType: "needsRequest" });
    }));
    // A load resets the HUD's survival cache; a needsState that landed mid-load is re-applied
    this.controller.on("loadGame", () => this.controller.once("update", () => this.applyPenalties()));
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "needsState") return;
    this.needs = {
      staminaPenalty: Number(content["staminaPenalty"]) || 0,
      magickaPenalty: Number(content["magickaPenalty"]) || 0,
      survivalMode: content["survivalMode"] === true,
    };
    const closeCrafting = content["closeCrafting"] === true;
    this.controller.once("update", () => {
      // Papyrus natives are allowed in update; the vanilla menu already made the refused recipe locally
      if (closeCrafting && this.sp.Ui.isMenuOpen(Menu.Crafting)) {
        this.sp.callNative("TESModPlatform", "CloseMenu", undefined, Menu.Crafting);
      }
      this.applyPenalties();
    });
  }

  private applyPenalties(): void {
    const player = this.sp.Game.getPlayer();
    if (!this.needs || !player) return;
    applyNeedsPenalties(player, this.needs.staminaPenalty, this.needs.magickaPenalty);
    this.setSurvivalHud(this.needs);
  }

  // Never Survival_ModeEnabledShared: vanilla Update.esm scripts read that one
  private setSurvivalHud(needs: NeedsState): void {
    const find = (id: number, plugin: string) => this.sp.GlobalVariable.from(this.sp.Game.getFormFromFile(id, plugin));
    const set = (id: number, plugin: string, value: number): void => find(id, plugin)?.setValue(value);
    set(HUNGER_PENALTY_GLOBAL, UPDATE_ESM, Math.round(needs.staminaPenalty * 100));
    set(EXHAUSTION_PENALTY_GLOBAL, UPDATE_ESM, Math.round(needs.magickaPenalty * 100));
    set(COLD_PENALTY_GLOBAL, UPDATE_ESM, 0);
    set(SURVIVAL_MODE_GLOBAL, SURVIVAL_PLUGIN, needs.survivalMode ? 1 : 0);
    // Read back: "none" means the form lookup failed, so the HUD never saw the value
    const read = (id: number, plugin: string) => find(id, plugin)?.getValue() ?? "none";
    const line = `survival hud toggle=${read(SURVIVAL_MODE_GLOBAL, SURVIVAL_PLUGIN)} hunger=${read(HUNGER_PENALTY_GLOBAL, UPDATE_ESM)} exhaustion=${read(EXHAUSTION_PENALTY_GLOBAL, UPDATE_ESM)}`;
    if (line === this.lastHudLog) return;
    this.lastHudLog = line;
    logToPlatformLog(this, line);
  }

  private needs: NeedsState | null = null;
  private lastHudLog = "";
}
