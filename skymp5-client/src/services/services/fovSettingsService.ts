import { logToPlatformLog } from "../../logging";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { readClientSettingNumber } from "./widgetMenuUtil";

// Skyrim.ini settings the engine copies into the player camera on every game load, the join included
const FOV_INI_SETTINGS = ["fDefaultWorldFOV:Display", "fDefault1stPersonFOV:Display"];

// Applies the launcher's FOV slider value, stored as "fov" in the client settings
export class FovSettingsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.onceUpdate());
    this.controller.emitter.on("gameLoad", () => this.onGameLoad());
  }

  private onceUpdate() {
    this.iniFov = this.sp.Utility.getINIFloat(FOV_INI_SETTINGS[0]);
    this.apply();
  }

  private onGameLoad() {
    const fov = this.apply();
    logToPlatformLog("FovSettings", fov === null ? `no launcher fov, ini ${this.iniFov}` : `applied fov ${fov}, ini had ${this.iniFov}`);
  }

  // Null when the settings carry no value in the launcher's range
  private apply(): number | null {
    const fov = readClientSettingNumber(this.sp, "fov", 0);
    if (fov < 70 || fov > 170) return null;
    for (const setting of FOV_INI_SETTINGS) this.sp.Utility.setINIFloat(setting, fov);
    return fov;
  }

  private iniFov = 0;
}
