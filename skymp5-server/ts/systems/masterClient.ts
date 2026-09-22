import { System, Log } from "./system";
import Axios from "axios";
import { SystemContext } from "./system";
import { ScampServer } from "../scampNative";
import { Settings } from "../settings";
import { readPlayerSlots } from "./queueSystem";

// Heartbeat every 5 s: POST /api/servers/:key { name, maxPlayers, online, queued }; maxPlayers is the playable cap (playerSlots), queued the login queue length
export class MasterClient implements System {
  systemName = "MasterClient";

  constructor(
    private log: Log,
    private serverPort: number,
    private masterUrl: string | null,
    private maxPlayers: number,
    private name: string,
    private masterKey: string,
    private updateIntervalMs = 5000,
    private offlineMode = false
  ) { }

  async initAsync(): Promise<void> {
    const all = (await Settings.get()).allSettings;
    this.playerSlots = readPlayerSlots(all, this.maxPlayers);

    if (!this.masterUrl) {
      this.log("No master server specified");
      return;
    }

    this.log(`Using master server on ${this.masterUrl}`);

    this.endpoint = `${this.masterUrl}/api/servers/${this.masterKey}`;
    this.log(`Our endpoint on master is ${this.endpoint}`);

    const token = all?.["masterApiAuthToken"];
    this.authToken = typeof token === "string" ? token : "";
    if (!this.authToken) {
      this.log("masterApiAuthToken missing, the master will refuse heartbeats");
    }
  }

  update(): void {
    return;
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    if (this.offlineMode) {
      return;
    }

    await new Promise((r) => setTimeout(r, this.updateIntervalMs));

    if (this.endpoint) {
      const { name, playerSlots: maxPlayers } = this;
      const online = this.getCurrentOnline(ctx.svr);
      const queued = (ctx.svr as any).getQueueLength?.() ?? 0;
      try {
        await Axios.post(this.endpoint, { name, maxPlayers, online, queued }, { headers: { "X-Auth-Token": this.authToken } });
      } catch (e) {
        console.error(`Error updating info on master server: ${e}`);
      }
    }
  }

  // connect/disconnect events are not reliable so we do full recalculate
  private getCurrentOnline(svr: ScampServer): number {
    return (svr as any).get(0, "onlinePlayers").length;
  }

  customPacket(): void {
    return;
  }

  private endpoint: string;
  private authToken = "";
  private playerSlots = 0;
}
