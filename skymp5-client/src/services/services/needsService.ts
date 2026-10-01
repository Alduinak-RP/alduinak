import { Menu } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { sendCustomPacket, parseCustomPacket } from "./customPacketUtil";
import { closeWidget, onWidgetsCleared, refreshFormMenu } from "./widgetMenuUtil";
import { applyNeedsPenalties, EXHAUSTION_PENALTY_AV, HUNGER_PENALTY_AV } from "../../sync/attributePenalty";
import { logToPlatformLog } from "../../logging";

// Globals the Survival DOBJ keys name: the HUD draws their 0-100 value as the red end of a meter; SurvivalService owns the cold one
export const UPDATE_ESM = "Update.esm";
const HUNGER_PENALTY_GLOBAL = 0x2edf;
const EXHAUSTION_PENALTY_GLOBAL = 0x2ee0;
const SURVIVAL_PLUGIN = "ccQDRSSE001-SurvivalMode.esl";
// Survival_ModeToggle, the switch HUDMenu polls for ShowSurvivalElements; Survival_ModeEnabled (0x826) is script-only
const SURVIVAL_MODE_GLOBAL = 0x828;
// Survival_ModeEnabled: only Survival_MainScript sets it, when vanilla Survival switches itself on
const SURVIVAL_ENABLED_GLOBAL = 0x826;
const SURVIVAL_READOUT_WIDGET_ID = 39;

// for the browser-side widget setter (executed inside the CEF browser)
declare const window: any;

export const globalOf = (sp: Sp, id: number, plugin: string) => sp.GlobalVariable.from(sp.Game.getFormFromFile(id, plugin));

// Read back: "none" means the form lookup failed, so the HUD never saw the value
export const readGlobal = (sp: Sp, id: number, plugin: string): number | "none" => globalOf(sp, id, plugin)?.getValue() ?? "none";

// The cold and sickness SurvivalService hands over for the readout
export interface SurvivalReadout {
  coldStage: number;
  coldStageName: string;
  // The server's warmth total, cloaks and table pieces included; -1 with cold off
  warmth: number;
  diseases: Array<{ name: string; stage: number }>;
  afflictions: string[];
}

const NO_SURVIVAL_READOUT: SurvivalReadout = { coldStage: -1, coldStageName: "", warmth: -1, diseases: [], afflictions: [] };
// Chilly and colder show on the readout
const READOUT_COLD_STAGE = 2;

// Module-level so the browser-side widget setter can read it (runtime injection)
let survivalReadout = NO_SURVIVAL_READOUT;

interface NeedsState {
  staminaPenalty: number;
  magickaPenalty: number;
  survivalMode: boolean;
}

/**
 * Hunger and fatigue on the vanilla HUD. The server (NeedsSystem) owns both values and pushes needsState whenever they
 * change; this service applies the max stamina (hunger) and max magicka (fatigue) penalty shares the server sends, shows
 * them as Survival's red meter segments, shows the cold stage, diseases and afflictions SurvivalService hands over in a
 * small HUD readout, and closes the Crafting Menu when the server refused a craft for fatigue.
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
      this.readoutShown = "";
      sendCustomPacket(this.controller, { customPacketType: "needsRequest" });
    }));
    // A load resets the HUD's survival cache; a needsState that landed mid-load is re-applied
    this.controller.on("loadGame", () => this.controller.once("update", () => {
      // What the loaded save carries before the penalty goes on again: a nonzero Variable02/03 here would make the apply start from a false amount
      logToPlatformLog(this, `before load re-apply: ${this.describeMaxima()}`);
      this.applyPenalties();
    }));
  }

  // The maxima the penalties act on and the applied amounts Survival keeps in Variable02/03
  private describeMaxima(): string {
    const player = this.sp.Game.getPlayer();
    if (!player) return "no player";
    const r = (v: number) => Math.round(v);
    return `stamMax=${r(player.getActorValueMax("Stamina"))} magMax=${r(player.getActorValueMax("Magicka"))} v02=${r(player.getActorValue(HUNGER_PENALTY_AV))} v03=${r(player.getActorValue(EXHAUSTION_PENALTY_AV))}`;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "needsState") return;
    this.needs = {
      staminaPenalty: Number(content["staminaPenalty"]) || 0,
      magickaPenalty: Number(content["magickaPenalty"]) || 0,
      survivalMode: content["survivalMode"] === true,
    };
    this.showSurvivalReadout();
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
    const set = (id: number, plugin: string, value: number): void => globalOf(this.sp, id, plugin)?.setValue(value);
    set(HUNGER_PENALTY_GLOBAL, UPDATE_ESM, Math.round(needs.staminaPenalty * 100));
    set(EXHAUSTION_PENALTY_GLOBAL, UPDATE_ESM, Math.round(needs.magickaPenalty * 100));
    set(SURVIVAL_MODE_GLOBAL, SURVIVAL_PLUGIN, needs.survivalMode ? 1 : 0);
    const read = (id: number, plugin: string) => readGlobal(this.sp, id, plugin);
    const line = `survival hud toggle=${read(SURVIVAL_MODE_GLOBAL, SURVIVAL_PLUGIN)} enabled=${read(SURVIVAL_ENABLED_GLOBAL, SURVIVAL_PLUGIN)} hunger=${read(HUNGER_PENALTY_GLOBAL, UPDATE_ESM)} exhaustion=${read(EXHAUSTION_PENALTY_GLOBAL, UPDATE_ESM)} ${this.describeMaxima()}`;
    if (line === this.lastHudLog) return;
    this.lastHudLog = line;
    logToPlatformLog(this, line);
  }

  setSurvivalReadout(readout: SurvivalReadout): void {
    this.survival = readout;
    this.showSurvivalReadout();
  }

  // Only with the survival HUD flag on, like the red meter segments; Chilly or colder, a disease or an affliction opens it
  private showSurvivalReadout(): void {
    const s = this.survival;
    const lines = s.coldStage >= READOUT_COLD_STAGE || s.diseases.length > 0 || s.afflictions.length > 0;
    const key = this.needs?.survivalMode && lines ? JSON.stringify(s) : "";
    if (key === this.readoutShown) return;
    this.readoutShown = key;
    if (!key) return closeWidget(this.sp, SURVIVAL_READOUT_WIDGET_ID);
    survivalReadout = s;
    refreshFormMenu(this.sp, this.readoutWidgetSetter, { survivalReadout, SURVIVAL_READOUT_WIDGET_ID });
  }

  // Runs inside the CEF browser. Only injected vars + window are available; no spread syntax
  private readoutWidgetSetter = () => {
    const r = survivalReadout;
    const widget = { type: "survivalReadout", id: SURVIVAL_READOUT_WIDGET_ID, coldStage: r.coldStage, coldStageName: r.coldStageName, warmth: r.warmth, diseases: r.diseases, afflictions: r.afflictions };
    const others = (window.skyrimPlatform.widgets.get() || []).filter((w: any) => w.id !== SURVIVAL_READOUT_WIDGET_ID);
    window.skyrimPlatform.widgets.set(others.concat([widget]));
  };

  private needs: NeedsState | null = null;
  private survival: SurvivalReadout = NO_SURVIVAL_READOUT;
  private readoutShown = "";
  private lastHudLog = "";
}
