import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { userSlotCount, isCreationPending } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Gold watch: samples every online character's gold and flags a rise above the threshold between two samples
// (looting, trades, console spawns and dupes alike) as a goldSpawn alert in the manager's Security tab.
// The first sample of a character only sets its baseline, so logging in rich flags nothing.
//
// server-settings.json keys:
//   goldAlertThreshold  gold gained between two samples that raises an alert, 0 disables (default 5000)

const POLL_MS = 10000;
const GOLD_BASE_ID = 0xf;

export class GoldWatchSystem implements System {
  systemName = "GoldWatchSystem";
  constructor(private log: Log) { }

  private threshold = 5000;
  private masterUrl = "";
  private masterKey = "";
  private authToken = "";
  private lastGold = new Map<number, number>(); // actorId -> gold at the last sample

  async initAsync(): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const threshold = Number(all?.["goldAlertThreshold"]);
    if (Number.isFinite(threshold) && threshold >= 0) this.threshold = threshold;
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.log(this.threshold ? `GoldWatchSystem: alerting on gains above ${this.threshold} gold` : "GoldWatchSystem: disabled (goldAlertThreshold is 0)");
  }

  disconnect(userId: number, ctx: SystemContext): void {
    try {
      const actorId = (ctx.svr as Mp).getUserActor(userId);
      if (actorId) this.lastGold.delete(actorId);
    } catch { }
  }

  async updateAsync(ctx: SystemContext): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.threshold) return;
    const mp = ctx.svr as Mp;
    for (let userId = 0; userId < userSlotCount(); userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { }
      if (!actorId || isCreationPending(mp, actorId)) continue;
      const gold = this.goldOf(mp, actorId);
      const before = this.lastGold.get(actorId);
      this.lastGold.set(actorId, gold);
      if (before !== undefined && gold - before > this.threshold) this.alert(mp, actorId, before, gold);
    }
  }

  private goldOf(mp: Mp, actorId: number): number {
    try {
      const entries: any[] = mp.get(actorId, "inventory")?.entries || [];
      return entries.reduce((n, e) => n + ((Number(e.baseId) >>> 0) === GOLD_BASE_ID ? Number(e.count) || 0 : 0), 0);
    } catch {
      return 0;
    }
  }

  private alert(mp: Mp, actorId: number, before: number, after: number): void {
    const hex = actorId.toString(16);
    let profileId = -1;
    let name = "";
    try { profileId = Number(mp.get(actorId, "profileId")); } catch { }
    try { name = String(mp.get(actorId, "appearance")?.name || ""); } catch { }
    this.log(`GoldWatchSystem: ${name || hex} (profile ${profileId}) went from ${before} to ${after} gold`);
    if (!this.masterUrl || !this.masterKey || !this.authToken) return;
    const at = Date.now();
    fetch(`${this.masterUrl}/api/servers/${this.masterKey}/security-alerts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": this.authToken },
      body: JSON.stringify({ type: "goldSpawn", key: `${hex}:${at}`, details: { actorId: hex, profileId, name, before, after, gain: after - before, at } }),
    }).catch((e) => this.log(`GoldWatchSystem: alert not delivered: ${e}`));
  }
}
