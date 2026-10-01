import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";
import { setGameSettings } from "./gameSettingUtil";

// The engine's VATS kill camera (slow motion, the cinematic killmove shot and the arrow or spell follow cam); off, paired killmoves still play in real time
const VATS_DISABLE_INI = "bVATSDisable:VATS";
// The odds rolled for a ranged or magic kill cam
const KILLCAM_ODDS_OFF = { fKillCamBaseOdds: 0, fKillCamLevelBias: 0, fKillCamLevelFactor: 0, fKillCamLevelMaxBias: 0, iKillCamLevelOffset: 0 };

export class DisableKillCamService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.apply());
  }

  private apply(): void {
    const { Utility } = this.sp;
    const applied: string[] = [];
    try {
      const was = Utility.getINIBool(VATS_DISABLE_INI);
      Utility.setINIBool(VATS_DISABLE_INI, true);
      applied.push(`${VATS_DISABLE_INI} ${was} -> ${Utility.getINIBool(VATS_DISABLE_INI)}`);
      setGameSettings(this.sp, KILLCAM_ODDS_OFF, applied);
      logToPlatformLog(this, `kill cams off: ${applied.join(", ")}`);
    } catch (e) {
      logToPlatformLog(this, `kill cams off failed after ${applied.join(", ") || "nothing"}: ${e}`);
    }
  }
}
