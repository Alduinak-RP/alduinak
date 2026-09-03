// Admin tier resolution shared by AdminSystem and HousingSystem: adminProfileIds are always senior, then adminRoles tiers, then legacy adminRoleIds as senior

export type AdminTier = "senior" | "developer" | "gm";

// Precedence when a player holds roles from several tiers
const TIER_ORDER: AdminTier[] = ["senior", "developer", "gm"];

export const TIER_CAPS: Record<AdminTier, { ban: boolean }> = {
  senior: { ban: true },
  developer: { ban: true },
  gm: { ban: false },
};

export interface AdminRoleConfig {
  tierRoles: Record<AdminTier, string[]>;
  adminRoleIds: string[];
  adminProfileIds: number[];
}

const idList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];

export function readAdminRoleConfig(all: Record<string, unknown> | null): AdminRoleConfig {
  const raw = all?.["adminRoles"];
  const tiers = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const tierRoles: Record<AdminTier, string[]> = { senior: [], developer: [], gm: [] };
  for (const tier of TIER_ORDER) tierRoles[tier] = idList(tiers[tier]);
  const profiles = all?.["adminProfileIds"];
  return {
    tierRoles,
    adminRoleIds: idList(all?.["adminRoleIds"]),
    adminProfileIds: Array.isArray(profiles) ? profiles.map(Number).filter(Number.isFinite) : [],
  };
}

// Reads private.discordRoles (written by spawn.ts at login), so a Discord role change needs a relog
export function adminTierOf(mp: any, actorId: number, cfg: AdminRoleConfig): AdminTier | null {
  let roles: string[] = [];
  try {
    const r = mp.get(actorId, "private.discordRoles");
    if (Array.isArray(r)) roles = r.map(String);
  } catch { }
  try {
    if (cfg.adminProfileIds.includes(Number(mp.get(actorId, "profileId")))) return "senior";
  } catch { }
  const has = (ids: string[]) => roles.some(r => ids.includes(r));
  for (const tier of TIER_ORDER) {
    if (has(cfg.tierRoles[tier])) return tier;
  }
  return has(cfg.adminRoleIds) ? "senior" : null;
}
