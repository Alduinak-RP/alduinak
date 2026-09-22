import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";

// The engine picks the crosshair target inside this cone; beehives and the invisible mead benches sat outside it too easily
const RADIUS_INI = "fActivatePickRadius:Interface";
const LENGTH_INI = "fActivatePickLength:Interface";
const RADIUS_SCALE = 1.5;
const MIN_LENGTH = 200;

/**
 * Widens the crosshair pick a little at startup. activatePickRadius and activatePickLength in the
 * skymp5-client settings block set the values outright; without them the radius grows by half and
 * the length to at least MIN_LENGTH. An INI the engine does not report (0) is left alone.
 */
export class ActivatePickService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.apply());
  }

  private apply(): void {
    try {
      const settings = (this.sp.settings["skymp5-client"] || {}) as Record<string, unknown>;
      this.set(RADIUS_INI, Number(settings["activatePickRadius"]), (value) => value * RADIUS_SCALE);
      this.set(LENGTH_INI, Number(settings["activatePickLength"]), (value) => Math.max(value, MIN_LENGTH));
    } catch (err) {
      logError(this, `apply failed: ${err}`);
    }
  }

  private set(ini: string, wanted: number, widen: (value: number) => number): void {
    const current = this.sp.Utility.getINIFloat(ini);
    const value = wanted > 0 ? wanted : current > 0 ? widen(current) : 0;
    if (!(value > 0)) {
      logTrace(this, `${ini} reads ${current}, left alone`);
      return;
    }
    this.sp.Utility.setINIFloat(ini, value);
    logTrace(this, `${ini} ${current} -> ${value}`);
  }
}
