import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { toFormId } from "./formIdUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Base forms nobody can activate. Defaults to the vanilla coin purses: flora that hands out leveled gold and
// respawns, a gold faucet on a roleplay server. The client freezes and hides the prompt for such flora on its own.
//
// server-settings.json key:
//   untouchableBaseIds  base form ids as numbers or "0x..." strings; [] disables the check
const DEFAULT_UNTOUCHABLE_BASE_IDS = [0x000d790c, 0x000d8e7f, 0x000d8e80, 0x000d8e8a, 0x000d8e8b, 0x000d8e8c];
const MAX_ESPM_CACHE = 4096;

export class UntouchableSystem implements System {
  systemName = "UntouchableSystem";
  constructor(private log: Log) { }

  private baseIds = new Set(DEFAULT_UNTOUCHABLE_BASE_IDS);
  private baseIdByRefr = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const raw = (s.allSettings as Record<string, unknown> | null)?.["untouchableBaseIds"];
    if (Array.isArray(raw)) {
      this.baseIds = new Set(raw.map((v) => toFormId(v)).filter((id) => id > 0));
    }
    if (this.baseIds.size === 0) {
      this.log("UntouchableSystem: disabled (untouchableBaseIds is empty)");
      return;
    }
    this.installActivationHook(ctx);
    this.log(`UntouchableSystem: ${this.baseIds.size} untouchable base forms`);
  }

  private installActivationHook(ctx: SystemContext): void {
    const mp = ctx.svr as Mp;
    const previous = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      let untouchable = false;
      try {
        untouchable = this.baseIds.has(this.baseIdOf(ctx, targetId >>> 0));
      } catch (e) {
        this.log(`[untouchable] activation check failed: ${e}`);
      }
      if (untouchable) return false;
      // Chain, so another handler still gets its say.
      if (!previous) return true;
      try {
        return previous.call(mp, targetId, casterId) !== false;
      } catch {
        return true;
      }
    };
  }

  // ESM data never changes, so the lookup is cached per placed reference; spawned (0xff) refs read baseDesc
  private baseIdOf(ctx: SystemContext, refrId: number): number {
    const cached = this.baseIdByRefr.get(refrId);
    if (cached !== undefined) return cached;
    const mp = ctx.svr as Mp;
    let baseId = 0;
    try {
      const refr = mp.lookupEspmRecordById(refrId);
      const fields = refr && refr.record && Array.isArray(refr.record.fields) ? refr.record.fields : [];
      const name = fields.filter((f: any) => f && f.type === "NAME")[0];
      if (name && name.data && name.data.length >= 4 && typeof refr.toGlobalRecordId === "function") {
        const b = name.data;
        const local = (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
        baseId = refr.toGlobalRecordId(local) >>> 0;
      }
    } catch { /* not an espm reference */ }
    if (!baseId) {
      try {
        const desc = mp.get(refrId, "baseDesc");
        if (typeof desc === "string" && desc) baseId = mp.getIdFromDesc(desc) >>> 0;
      } catch { /* form vanished */ }
      // Runtime refs come and go; only espm lookups are worth caching
      return baseId;
    }
    if (this.baseIdByRefr.size >= MAX_ESPM_CACHE) this.baseIdByRefr.clear();
    this.baseIdByRefr.set(refrId, baseId);
    return baseId;
  }
}
