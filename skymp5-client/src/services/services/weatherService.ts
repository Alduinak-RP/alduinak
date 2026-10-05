import { ClientListener, CombinedController, Sp } from "./clientListener";
import { sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { logError, logToPlatformLog } from "../../logging";

// The sky follows the server's weather packet (WeatherSystem): one weather per region, shared by everyone standing in it.
// A weather is set outright while none is held (after a load screen, or back from a world with its own sky), within 10 s of a door or
// teleport, indoors and when the packet says instant; any other change fades. Every 10 s (and after a cell load) the applied weather is re-set when a door, fast travel
// or the engine dropped it. A packet without a region releases the override for the vanilla sky.
// Indoors it holds SkyrimClear, since Show Sky interiors (inns, ruins with open roofs) draw the sky; stepping outside sets the region's weather outright.

const APPLY_MS = 1000;
const RECHECK_MS = 10000;
const SLOW_FADE_MS = 5 * 60000;
const INDOOR_WEATHER = 0x81a;
// A weather applied this soon after a door or teleport is the sky of the new place
const ARRIVAL_MS = 10000;

interface WeatherPacket {
  region: string | null;
  weatherId: number;
  transition: string;
  gameSettings: Record<string, number> | null;
}

export class WeatherService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    controller.on("update", () => this.onUpdate());
    controller.on("loadGame", () => this.onLoadGame());
    controller.on("cellFullyLoaded", () => { this.recheckAt = 0; this.nextApplyAt = 0; });
    controller.emitter.on("playerWorldOrCellChanged", (e) => this.onArrival(e.interior));
    onCustomPacket(controller, "weather", (content) => this.onCustomPacketMessage(content));
  }

  // Natives throw in the packet-handler context, so the packet is only stored here and applied on update
  private onCustomPacketMessage(content: CustomPacketContent): void {
    const gs = content["gameSettings"];
    this.pending = {
      region: typeof content["region"] === "string" ? content["region"] : null,
      weatherId: Number(content["weatherId"]) >>> 0,
      transition: String(content["transition"] ?? "accelerate"),
      gameSettings: gs && typeof gs === "object" ? gs as Record<string, number> : null,
    };
    this.dirty = true;
  }

  // The template save carries its own sky and the last packet may be another character's, so nothing is held until the server answers
  private onLoadGame(): void {
    this.applied = 0;
    this.fadeSince = 0;
    this.pending = null;
    this.dirty = false;
    sendCustomPacket(this.controller, { customPacketType: "weatherRequest" });
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextApplyAt) return;
    this.nextApplyAt = now + APPLY_MS;
    try {
      if (this.dirty) this.apply(now);
      if (now >= this.recheckAt) {
        this.recheckAt = now + RECHECK_MS;
        this.recheck(now);
      }
      this.watchFade(now);
    } catch (e) {
      logError(this, `update failed: ${e}`);
    }
  }

  // A door, or a teleport to another world or cell
  private onArrival(indoors: boolean): void {
    this.indoors = indoors;
    this.outrightUntil = Date.now() + ARRIVAL_MS;
    this.fadeSince = 0;
    this.dirty = !!this.pending;
    this.nextApplyAt = 0;
  }

  // Stays dirty while a native throws, so the next pass tries the packet again
  private apply(now: number): void {
    const p = this.pending;
    if (!p) return;
    const first = p !== this.seen;
    if (first && p.gameSettings) {
      for (const [key, value] of Object.entries(p.gameSettings)) {
        if (/^fWeatherTrans/.test(key) && Number.isFinite(value)) this.sp.Game.setGameSettingFloat(key, value);
      }
    }
    const target = !p.region || !p.weatherId ? 0 : this.indoors ? INDOOR_WEATHER : p.weatherId;
    let did = "kept";
    if (!target) {
      // A loaded save may carry an override of its own
      if (this.applied || first) {
        this.sp.Weather.releaseOverride();
        did = "released";
      }
      this.applied = 0;
      this.fadeSince = 0;
    } else if (target !== this.applied) {
      const weather = this.sp.Weather.from(this.sp.Game.getFormEx(target));
      if (!weather) {
        logError(this, `weather ${target.toString(16)} of region ${p.region} is not in this load order`);
        this.dirty = false;
        return;
      }
      if (!this.applied || now < this.outrightUntil || this.indoors || p.transition === "instant") {
        weather.forceActive(true);
        this.fadeSince = 0;
        did = "set outright";
      } else {
        // The engine starts the fade once any running one ended, which accelerate only hurries
        weather.setActive(true, p.transition === "accelerate");
        this.fadeSince = now;
        did = "fading in";
      }
      this.applied = target;
      // The engine takes the weather up in its own update, so the recheck waits
      this.recheckAt = now + RECHECK_MS;
    }
    if (first) logToPlatformLog(this, `${p.region ?? "no region"} ${p.weatherId.toString(16)} ${p.transition}${this.indoors ? ", indoors" : ""}: ${did}`);
    this.seen = p;
    this.dirty = false;
  }

  // The sky must show the applied weather, inside settled; outside an own fade may wait for a running one, any other weather is the engine's pick after it dropped the override
  private recheck(now: number): void {
    if (!this.applied) return;
    const current = this.sp.Weather.getCurrentWeather()?.getFormID();
    const settled = this.sp.Weather.getCurrentWeatherTransition() >= 1;
    if (current === this.applied && (settled || !this.indoors)) return;
    if (!this.indoors && !settled && this.fadeSince) return;
    this.sp.Weather.from(this.sp.Game.getFormEx(this.applied))?.forceActive(true);
    this.fadeSince = 0;
    if (now - this.resetLoggedAt < SLOW_FADE_MS) return;
    this.resetLoggedAt = now;
    logToPlatformLog(this, `${this.applied.toString(16)} set again${this.indoors ? ", indoors" : ""}: the sky showed ${current?.toString(16)}${settled ? "" : ", fading in"}`);
  }

  // A fade lasts seconds under the server's fWeatherTrans settings; one log line tells when it does not
  private watchFade(now: number): void {
    if (!this.fadeSince || now - this.fadeSince < SLOW_FADE_MS) return;
    this.fadeSince = 0;
    const transition = this.sp.Weather.getCurrentWeatherTransition();
    if (transition < 1) logToPlatformLog(this, `fade still at ${transition.toFixed(2)} five minutes after setActive; set weatherTransition or weatherGameSettings in server-settings.json`);
  }

  private pending: WeatherPacket | null = null;
  // The packet whose game settings and log line are done
  private seen: WeatherPacket | null = null;
  private dirty = false;
  private applied = 0;
  private outrightUntil = 0;
  private indoors = false;
  private nextApplyAt = 0;
  private recheckAt = 0;
  private resetLoggedAt = 0;
  private fadeSince = 0;
}
