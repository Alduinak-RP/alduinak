// Admin tier resolution shared by AdminSystem and HousingSystem: adminProfileIds are always senior, then adminRoles tiers, then legacy adminRoleIds as senior

export type AdminTier = "senior" | "developer" | "gm";

// Precedence when a player holds roles from several tiers
const TIER_ORDER: AdminTier[] = ["senior", "developer", "gm"];

export type AdminCap = "players" | "teleport" | "modes" | "npcs" | "items" | "kick" | "ban";
export const ADMIN_CAPS: AdminCap[] = ["players", "teleport", "modes", "npcs", "items", "kick", "ban"];
export type AdminCaps = Record<AdminCap, boolean>;

const allCaps = (kickBan: boolean): AdminCaps => ({ players: true, teleport: true, modes: true, npcs: true, items: true, kick: kickBan, ban: kickBan });

export const TIER_CAPS: Record<AdminTier, AdminCaps> = {
  senior: allCaps(true),
  developer: allCaps(false),
  gm: allCaps(true),
};

// Kick and Ban are Players sub-tab buttons, so they also need players
const NEEDS_PLAYERS: AdminCap[] = ["kick", "ban"];

// Cap each admin request needs (adminAction by its action); null needs none, a key missing here is refused
export const REQUEST_CAP: Record<string, AdminCap | null> = {
  adminMenuRequest: null,
  npcZonesRequest: "npcs",
  teleportTo: "players",
  summon: "players",
  kick: "kick",
  masteryGrant: "players",
  masteryReset: "players",
  ban: "ban",
  teleportLoc: "teleport",
  toggleMode: "modes",
  npcZoneAdd: "npcs",
  npcZoneTp: "npcs",
  npcZoneReset: "npcs",
  npcZoneDelete: "npcs",
  npcZoneActivate: "npcs",
  npcZoneDeactivate: "npcs",
  npcZonePos: "npcs",
  itemSearch: "items",
  itemSpawn: "items",
  petBases: "npcs",
  petGrant: "npcs",
};

// Undefined for an unknown request
export function capForRequest(key: string): AdminCap | null | undefined {
  return Object.prototype.hasOwnProperty.call(REQUEST_CAP, key) ? REQUEST_CAP[key] : undefined;
}

// The cap the tier lacks for a request needing `need`, null when allowed
export function missingCap(need: AdminCap | null, caps: AdminCaps): AdminCap | null {
  if (!need) return null;
  if (!caps[need]) return need;
  return NEEDS_PLAYERS.includes(need) && !caps.players ? "players" : null;
}

export interface AdminRoleConfig {
  tierRoles: Record<AdminTier, string[]>;
  adminRoleIds: string[];
  adminProfileIds: number[];
  tierCaps: Record<AdminTier, AdminCaps>;
  capWarnings: string[];
}

const idList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// adminTierCaps is merged over TIER_CAPS; only known tiers and caps with boolean values apply
function readTierCaps(raw: unknown, warnings: string[]): Record<AdminTier, AdminCaps> {
  const out = { senior: { ...TIER_CAPS.senior }, developer: { ...TIER_CAPS.developer }, gm: { ...TIER_CAPS.gm } };
  if (raw === undefined || raw === null) return out;
  if (!isObject(raw)) {
    warnings.push("adminTierCaps must be an object, ignored");
    return out;
  }
  for (const [tier, caps] of Object.entries(raw)) {
    if (!TIER_ORDER.includes(tier as AdminTier) || !isObject(caps)) {
      warnings.push(`adminTierCaps.${tier} ignored, needs a tier name (${TIER_ORDER.join(", ")}) and an object`);
      continue;
    }
    for (const [cap, value] of Object.entries(caps)) {
      if (!ADMIN_CAPS.includes(cap as AdminCap) || typeof value !== "boolean") {
        warnings.push(`adminTierCaps.${tier}.${cap} ignored, needs a cap name (${ADMIN_CAPS.join(", ")}) and a boolean`);
        continue;
      }
      out[tier as AdminTier][cap as AdminCap] = value;
    }
  }
  return out;
}

export function readAdminRoleConfig(all: Record<string, unknown> | null): AdminRoleConfig {
  const raw = all?.["adminRoles"];
  const tiers = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const tierRoles: Record<AdminTier, string[]> = { senior: [], developer: [], gm: [] };
  for (const tier of TIER_ORDER) tierRoles[tier] = idList(tiers[tier]);
  const profiles = all?.["adminProfileIds"];
  const capWarnings: string[] = [];
  return {
    tierRoles,
    adminRoleIds: idList(all?.["adminRoleIds"]),
    adminProfileIds: Array.isArray(profiles) ? profiles.map(Number).filter(Number.isFinite) : [],
    tierCaps: readTierCaps(all?.["adminTierCaps"], capWarnings),
    capWarnings,
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
