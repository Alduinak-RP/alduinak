import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";
import { setGameSettings } from "./gameSettingUtil";

// Seconds between the engine's torch checks of an NPC (5 by default); each one unequips a held torch where it is not dark, another player's copy included
const TORCH_CHECK = { fTorchEvaluationTimer: 3600 };

export class NpcTorchCheckService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.apply());
  }

  private apply(): void {
    const applied: string[] = [];
    try {
      setGameSettings(this.sp, TORCH_CHECK, applied);
      logToPlatformLog(this, `NPC torch check slowed: ${applied.join(", ")}`);
    } catch (e) {
      logToPlatformLog(this, `NPC torch check not slowed: ${e}`);
    }
  }
}
