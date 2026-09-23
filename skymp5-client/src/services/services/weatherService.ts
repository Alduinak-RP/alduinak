import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket, sendCustomPacket } from "./customPacketUtil";
import { logError } from "../../logging";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";

// The sky follows the server's weather packet (WeatherSystem): one weather per region, shared by everyone standing in it.
// The first weather after a load screen is set outright, so the template save's own sky never fades over; later ones fade
// as the packet's transition says. Every 10 s (and after a cell load) the applied weather is re-set when a door, fast travel
// or the engine dropped it, outside only once no fade is running. A packet without a region releases the override for the vanilla sky.
// Indoors it holds SkyrimClear, since Show Sky interiors (inns, ruins with open roofs) draw the sky; stepping outside sets the region's weather outright.

const APPLY_MS = 1000;
const RECHECK_MS = 10000;
const SLOW_FADE_MS = 5 * 60000;
const INDOOR_WEATHER = 0x81a;

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
    controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  // Natives throw in the packet-handler context, so the packet is only stored here and applied on update
  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "weather") return;
    const gs = content["gameSettings"];
    this.pending = {
      region: typeof content["region"] === "string" ? content["region"] : null,
      weatherId: Number(content["weatherId"]) >>> 0,
      transition: String(content["transition"] ?? "accelerate"),
      gameSettings: gs && typeof gs === "object" ? gs as Record<string, number> : null,
    };
    this.dirty = true;
  }

  // The template save carries its own sky, so the next weather is set outright and asked for again
  private onLoadGame(): void {
    this.applied = 0;
    this.fresh = true;
    this.fadeSince = 0;
    this.dirty = !!this.pending;
    sendCustomPacket(this.controller, { customPacketType: "weatherRequest" });
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextApplyAt) return;
    this.nextApplyAt = now + APPLY_MS;
    try {
      this.trackInterior();
      if (this.dirty) this.apply(now);
      if (now >= this.recheckAt) {
        this.recheckAt = now + RECHECK_MS;
        this.recheck();
      }
      this.watchFade(now);
    } catch (e) {
      logError(this, `update failed: ${e}`);
    }
  }

  // A door between inside and outside sets the next sky outright
  private trackInterior(): void {
    const cell = this.sp.Game.getPlayer()?.getParentCell();
    if (!cell) return;
    const indoors = cell.isInterior();
    if (indoors === this.indoors) return;
    this.indoors = indoors;
    this.fresh = true;
    this.fadeSince = 0;
    this.dirty = !!this.pending;
  }

  // Stays dirty while a native throws, so the next pass tries the packet again
  private apply(now: number): void {
    const p = this.pending;
    if (!p) return;
    if (p.gameSettings && !this.gameSettingsApplied) {
      this.gameSettingsApplied = true;
      for (const [key, value] of Object.entries(p.gameSettings)) {
        if (/^fWeatherTrans/.test(key) && Number.isFinite(value)) this.sp.Game.setGameSettingFloat(key, value);
      }
    }
    const target = !p.region || !p.weatherId ? 0 : this.indoors ? INDOOR_WEATHER : p.weatherId;
    if (!target) {
      if (this.applied) this.sp.Weather.releaseOverride();
      this.applied = 0;
      this.fadeSince = 0;
    } else if (target !== this.applied) {
      const weather = this.sp.Weather.from(this.sp.Game.getFormEx(target));
      if (!weather) {
        logError(this, `weather ${target.toString(16)} of region ${p.region} is not in this load order`);
        this.dirty = false;
        return;
      }
      if (this.fresh || this.indoors || p.transition === "instant") {
        weather.forceActive(true);
        this.fadeSince = 0;
      } else {
        weather.setActive(true, p.transition === "accelerate");
        this.fadeSince = now;
      }
      this.applied = target;
    }
    // A release sets no weather, so fresh waits for the next one
    if (target) this.fresh = false;
    this.dirty = false;
  }

  // The sky must show the applied weather, outside once no fade is running, inside at once; anything else reset it
  private recheck(): void {
    if (!this.applied) return;
    const current = this.sp.Weather.getCurrentWeather()?.getFormID();
    const settled = this.sp.Weather.getCurrentWeatherTransition() >= 1;
    if (this.indoors) {
      if (current === this.applied && settled) return;
    } else {
      if (!settled) return;
      const outgoing = this.sp.Weather.getOutgoingWeather()?.getFormID();
      if (current === this.applied || outgoing === this.applied) return;
    }
    this.sp.Weather.from(this.sp.Game.getFormEx(this.applied))?.forceActive(true);
    this.fadeSince = 0;
  }

  // Fades run on game hours, which the realm's clock keeps at real time; one log line shows how slow that is in practice
  private watchFade(now: number): void {
    if (!this.fadeSince || now - this.fadeSince < SLOW_FADE_MS) return;
    this.fadeSince = 0;
    const transition = this.sp.Weather.getCurrentWeatherTransition();
    if (transition < 1) this.controller.once("update", () => { throw new Error(`WeatherService: fade still at ${transition.toFixed(2)} five minutes after setActive; set weatherTransition or weatherGameSettings in server-settings.json`); });
  }

  private pending: WeatherPacket | null = null;
  private dirty = false;
  private applied = 0;
  private fresh = true;
  private indoors = false;
  private gameSettingsApplied = false;
  private nextApplyAt = 0;
  private recheckAt = 0;
  private fadeSince = 0;
}
