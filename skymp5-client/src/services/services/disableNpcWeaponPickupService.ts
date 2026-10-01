import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logToPlatformLog } from "../../logging";
import { setGameSettings } from "./gameSettingUtil";

// Combat AI Acquire Weapon search: a world weapon at or past the max distance of the NPC's case (close, disarmed, ranged, unarmed) is no candidate, so 0 leaves none
const NO_WEAPON_PICKUP = {
  fCombatAcquireWeaponCloseDistanceMax: 0,
  fCombatAcquireWeaponCloseDistanceMin: 0,
  fCombatAcquireWeaponDisarmedDistanceMax: 0,
  fCombatAcquireWeaponDisarmedDistanceMin: 0,
  fCombatAcquireWeaponRangedDistanceMax: 0,
  fCombatAcquireWeaponRangedDistanceMin: 0,
  fCombatAcquireWeaponUnarmedDistanceMax: 0,
  fCombatAcquireWeaponUnarmedDistanceMin: 0,
  // Arrows and bolts picked up around a bow found by that search
  fCombatAcquireWeaponFindAmmoDistance: 0,
};

export class DisableNpcWeaponPickupService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.apply());
  }

  private apply(): void {
    const applied: string[] = [];
    try {
      setGameSettings(this.sp, NO_WEAPON_PICKUP, applied);
      logToPlatformLog(this, `NPC weapon pickup off: ${applied.join(", ")}`);
    } catch (e) {
      logToPlatformLog(this, `NPC weapon pickup off failed after ${applied.join(", ") || "nothing"}: ${e}`);
    }
  }
}
