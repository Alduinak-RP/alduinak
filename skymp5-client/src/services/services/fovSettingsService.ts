import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { readClientSettingNumber } from "./widgetMenuUtil";

// Kept in step with the camera in case the engine re-reads them
const FOV_INI_SETTINGS = ["fDefaultWorldFOV:Display", "fDefault1stPersonFOV:Display"];
const FOV_MIN = 70;
const FOV_MAX = 170;
// The camera can be rebuilt just after a load, so the FOV is written once more
const REAPPLY_DELAY_MS = 1000;

type FovApi = { setFov?: (worldFov: number, firstPersonFov?: number) => number };

// Applies the chat settings FOV, else the launcher's slider value stored as "fov" in the client settings
export class FovSettingsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => FovSettingsService.apply(this.sp, "startup"));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
  }

  // Applied on the next update, natives throw in the browser message context
  static setChatFov(fov: number | null): void {
    const value = fov === null ? null : Math.min(FOV_MAX, Math.max(FOV_MIN, fov));
    if (value === FovSettingsService.chatFov) return;
    FovSettingsService.chatFov = value;
    FovSettingsService.chatApplyOwed = true;
  }

  // Null when neither the chat nor the launcher carries a value in range
  static currentFov(sp: Sp): number | null {
    const fov = FovSettingsService.chatFov ?? readClientSettingNumber(sp, "fov", 0);
    return fov >= FOV_MIN && fov <= FOV_MAX ? fov : null;
  }

  private onGameLoad() {
    FovSettingsService.apply(this.sp, "load");
    this.reapplyAt = Date.now() + REAPPLY_DELAY_MS;
  }

  private onUpdate() {
    if (FovSettingsService.chatApplyOwed) {
      FovSettingsService.chatApplyOwed = false;
      FovSettingsService.apply(this.sp, "chat");
    }
    if (this.reapplyAt === 0 || Date.now() < this.reapplyAt) return;
    this.reapplyAt = 0;
    FovSettingsService.apply(this.sp, "reapply");
  }

  // The native setter is missing from older SkyrimPlatformImpl.dll builds, which then get the INI only
  private static apply(sp: Sp, reason: string): void {
    const fov = FovSettingsService.currentFov(sp);
    if (fov === null) {
      logToPlatformLog("FovSettings", `${reason}: no fov set, ini ${sp.Utility.getINIFloat(FOV_INI_SETTINGS[0])}`);
      return;
    }
    for (const setting of FOV_INI_SETTINGS) sp.Utility.setINIFloat(setting, fov);
    const api = sp as Sp & FovApi;
    let path = "the INI only";
    if (typeof api.setFov === "function") {
      try {
        api.setFov(fov);
        path = "setFov";
      } catch (e) {
        path = `the INI only, setFov failed: ${e}`;
      }
    }
    logToPlatformLog("FovSettings", `${reason}: applied ${fov} via ${path}`);
  }

  private static chatFov: number | null = null;
  private static chatApplyOwed = false;
  private reapplyAt = 0;
}
