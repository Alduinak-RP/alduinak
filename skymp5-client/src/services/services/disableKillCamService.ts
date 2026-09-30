import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";

// The engine's VATS kill camera (slow motion, the cinematic killmove shot and the arrow or spell follow cam); off, paired killmoves still play in real time
const VATS_DISABLE_INI = "bVATSDisable:VATS";
// The odds rolled for a ranged or magic kill cam
const KILLCAM_FLOATS = ["fKillCamBaseOdds", "fKillCamLevelBias", "fKillCamLevelFactor", "fKillCamLevelMaxBias"];
const KILLCAM_INTS = ["iKillCamLevelOffset"];

export class DisableKillCamService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.apply());
  }

  private apply(): void {
    const { Game, Utility } = this.sp;
    const applied: string[] = [];
    try {
      const was = Utility.getINIBool(VATS_DISABLE_INI);
      Utility.setINIBool(VATS_DISABLE_INI, true);
      applied.push(`${VATS_DISABLE_INI} ${was} -> ${Utility.getINIBool(VATS_DISABLE_INI)}`);
      for (const name of KILLCAM_FLOATS) {
        const was = Game.getGameSettingFloat(name);
        Game.setGameSettingFloat(name, 0);
        applied.push(`${name} ${was} -> ${Game.getGameSettingFloat(name)}`);
      }
      for (const name of KILLCAM_INTS) {
        const was = Game.getGameSettingInt(name);
        Game.setGameSettingInt(name, 0);
        applied.push(`${name} ${was} -> ${Game.getGameSettingInt(name)}`);
      }
      logToPlatformLog(this, `kill cams off: ${applied.join(", ")}`);
    } catch (e) {
      logToPlatformLog(this, `kill cams off failed after ${applied.join(", ") || "nothing"}: ${e}`);
    }
  }
}
