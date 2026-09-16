// Faction rank policy on top of the backend definitions; pure data, no mp calls

export interface UniformItem {
  item: string;
  count: number;
}

export interface RankDef {
  id: string;
  slug: string;
  name: string;
  order: number;
  capacity: number | null;
  assigned: number;
  // null: only the leader appoints this faction's ranks
  appoints: string[] | null;
  issuesUniform: boolean;
  uniform: UniformItem[] | null;
}

export interface FactionDef {
  id: string;
  scope: string;
  name: string;
  zone: string;
  color: string;
  uniform: UniformItem[];
  // Ladder order, leader first
  ranks: RankDef[];
}

// A character's standing in one faction; staff act with every right and no rank
export interface Authority {
  staff: boolean;
  rank: RankDef | null;
}

export interface Membership {
  factionId: string;
  rankSlug: string;
  slot: number | null;
}

export const HOLD_MANAGER_RANKS = ["jarl", "steward"];

const DEFAULT_COLOR = "c9a36b";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const uniformList = (v: unknown): UniformItem[] | null =>
  Array.isArray(v)
    ? v.filter((u) => u && typeof u.item === "string" && Number.isInteger(u.count) && u.count > 0).map((u) => ({ item: u.item, count: u.count }))
    : null;

// "hold:the-rift:jarl" -> ["hold:the-rift", "jarl"]
export function splitRequirementId(requirementId: unknown): [string, string] | null {
  const parts = str(requirementId).split(":");
  return parts.length === 3 && parts.every(Boolean) ? [`${parts[0]}:${parts[1]}`, parts[2]] : null;
}

// Housing tables name holds without the article the backend groups carry ("the-rift" and "rift" are one hold)
export const holdKey = (slug: string): string => slug.replace(/^the-/, "");

// The master-api GET /factions reply as ladders keyed by faction id
export function buildFactions(raw: { factions?: unknown[]; requirements?: unknown[] } | null): Map<string, FactionDef> {
  const out = new Map<string, FactionDef>();
  for (const f of raw?.factions || []) {
    const r = f as Record<string, unknown>;
    const id = str(r?.id);
    if (!id.includes(":")) continue;
    out.set(id, {
      id,
      scope: id.split(":")[0],
      name: str(r.name) || str(r.group) || id,
      zone: str(r.zone),
      color: /^[0-9a-f]{6}$/.test(str(r.color)) ? str(r.color) : DEFAULT_COLOR,
      uniform: uniformList(r.uniform) || [],
      ranks: [],
    });
  }
  for (const q of raw?.requirements || []) {
    const r = q as Record<string, unknown>;
    const split = splitRequirementId(r?.id);
    const faction = split && out.get(split[0]);
    if (!split || !faction) continue;
    faction.ranks.push({
      id: str(r.id),
      slug: split[1],
      name: str(r.rank) || split[1],
      order: Number.isInteger(r.order) ? (r.order as number) : faction.ranks.length,
      capacity: Number.isInteger(r.capacity) && (r.capacity as number) > 0 ? (r.capacity as number) : null,
      assigned: Number.isInteger(r.assigned) ? (r.assigned as number) : 0,
      appoints: Array.isArray(r.appoints) ? (r.appoints as unknown[]).map(String) : null,
      issuesUniform: r.issuesUniform === true,
      uniform: uniformList(r.uniform),
    });
  }
  for (const faction of out.values()) faction.ranks.sort((a, b) => a.order - b.order);
  return out;
}

export const rankOf = (faction: FactionDef, slug: string): RankDef | null => faction.ranks.find((r) => r.slug === slug) || null;

export const isLeaderRank = (faction: FactionDef, rank: RankDef): boolean => rank.order === faction.ranks[0]?.order;

// Every faction row of private.skympAccess (already narrowed to the character)
export function membershipsOf(access: unknown): Membership[] {
  const rows = access && Array.isArray((access as { factions?: unknown }).factions) ? (access as { factions: unknown[] }).factions : [];
  const out: Membership[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const split = splitRequirementId(r?.requirementId);
    if (!split) continue;
    out.push({ factionId: split[0], rankSlug: split[1], slot: Number.isInteger(r.slot) ? (r.slot as number) : null });
  }
  return out;
}

// Hold ranks by hold key, for housing
export function holdRanksOf(access: unknown): Array<{ hold: string; rank: string }> {
  return membershipsOf(access)
    .filter((m) => m.factionId.startsWith("hold:"))
    .map((m) => ({ hold: holdKey(m.factionId.slice(5)), rank: m.rankSlug }));
}

// Leaders are placed by staff only; everyone else follows their rank's appoints list, or the leader when the list is absent
export function canAppoint(faction: FactionDef, auth: Authority, target: RankDef): boolean {
  if (auth.staff) return true;
  const own = auth.rank;
  if (!own || isLeaderRank(faction, target)) return false;
  return own.appoints ? own.appoints.includes(target.slug) : isLeaderRank(faction, own);
}

// Whoever may appoint a rank may demote or remove its holders; the leader may remove anyone below the leader
export function canManage(faction: FactionDef, auth: Authority, memberRank: RankDef): boolean {
  if (auth.staff) return true;
  const own = auth.rank;
  if (!own) return false;
  if (isLeaderRank(faction, own)) return !isLeaderRank(faction, memberRank);
  return canAppoint(faction, auth, memberRank);
}

export function appointableRanks(faction: FactionDef, auth: Authority): RankDef[] {
  return faction.ranks.filter((r) => canAppoint(faction, auth, r));
}

// The nearest rank above the member's that the actor may appoint
export function promotionFor(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef | null {
  if (!canManage(faction, auth, memberRank)) return null;
  const above = appointableRanks(faction, auth).filter((r) => r.order < memberRank.order);
  return above.length ? above[above.length - 1] : null;
}

export function demotionFor(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef | null {
  if (!canManage(faction, auth, memberRank)) return null;
  return appointableRanks(faction, auth).find((r) => r.order > memberRank.order) || null;
}

export function canIssueUniform(faction: FactionDef, auth: Authority): boolean {
  if (auth.staff) return true;
  return !!auth.rank && (auth.rank.issuesUniform || isLeaderRank(faction, auth.rank));
}

// A rank's own list replaces the faction list
export const uniformFor = (faction: FactionDef, rank: RankDef): UniformItem[] => rank.uniform && rank.uniform.length ? rank.uniform : faction.uniform;
