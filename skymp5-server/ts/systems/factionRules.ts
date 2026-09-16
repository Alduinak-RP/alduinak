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
  // Rank slugs this rank may appoint (invite into, act on and demote to), promote to, demote from and remove; null: only the leader acts
  appoints: string[] | null;
  promotes: string[] | null;
  demotes: string[] | null;
  removes: string[] | null;
  invites: boolean;
  managesProperty: boolean;
  factionAccess: boolean;
  issuesUniform: boolean;
  uniform: UniformItem[] | null;
}

export type RankList = "appoints" | "promotes" | "demotes" | "removes";

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

const slugList = (v: unknown): string[] | null => (Array.isArray(v) ? v.map(String) : null);

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
    const appoints = slugList(r.appoints);
    faction.ranks.push({
      id: str(r.id),
      slug: split[1],
      name: str(r.rank) || split[1],
      order: Number.isInteger(r.order) ? (r.order as number) : faction.ranks.length,
      capacity: Number.isInteger(r.capacity) && (r.capacity as number) > 0 ? (r.capacity as number) : null,
      appoints,
      promotes: slugList(r.promotes) ?? appoints,
      demotes: slugList(r.demotes) ?? appoints,
      removes: slugList(r.removes) ?? appoints,
      invites: r.invites !== false,
      managesProperty: typeof r.managesProperty === "boolean" ? r.managesProperty : faction.scope === "hold" && HOLD_MANAGER_RANKS.includes(split[1]),
      factionAccess: r.factionAccess !== false,
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
export function holdRanksOf(access: unknown): Array<{ factionId: string; hold: string; rank: string }> {
  return membershipsOf(access)
    .filter((m) => m.factionId.startsWith("hold:"))
    .map((m) => ({ factionId: m.factionId, hold: holdKey(m.factionId.slice(5)), rank: m.rankSlug }));
}

// Leaders are placed by staff only; everyone else follows their rank's list, or the leader when the list is absent
function grants(faction: FactionDef, auth: Authority, key: RankList, target: RankDef): boolean {
  if (auth.staff) return true;
  const own = auth.rank;
  if (!own || isLeaderRank(faction, target)) return false;
  const list = own[key];
  return list ? list.includes(target.slug) : isLeaderRank(faction, own);
}

// The leader acts on every member below the leader; other ranks on the holders of ranks in their list
function actsOn(faction: FactionDef, auth: Authority, key: RankList, memberRank: RankDef): boolean {
  if (auth.staff) return true;
  if (!auth.rank || isLeaderRank(faction, memberRank)) return false;
  return isLeaderRank(faction, auth.rank) || grants(faction, auth, key, memberRank);
}

export function canAppoint(faction: FactionDef, auth: Authority, target: RankDef): boolean {
  return grants(faction, auth, "appoints", target);
}

// Inviting also needs the rank's invite flag
export function canInvite(faction: FactionDef, auth: Authority, target: RankDef): boolean {
  return canAppoint(faction, auth, target) && (auth.staff || !!auth.rank?.invites);
}

// Up: the member's rank in appoints and the target in promotes; down: the member's rank in demotes and the target in appoints
export function canSetRank(faction: FactionDef, auth: Authority, memberRank: RankDef, target: RankDef): boolean {
  if (target.slug === memberRank.slug) return false;
  return target.order < memberRank.order
    ? actsOn(faction, auth, "appoints", memberRank) && grants(faction, auth, "promotes", target)
    : actsOn(faction, auth, "demotes", memberRank) && grants(faction, auth, "appoints", target);
}

// The ranks Set rank may move the member to; Promote and Demote take the nearest one
export function rankTargets(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef[] {
  return faction.ranks.filter((r) => canSetRank(faction, auth, memberRank, r));
}

export function canRemove(faction: FactionDef, auth: Authority, memberRank: RankDef): boolean {
  return actsOn(faction, auth, "removes", memberRank);
}

export function invitableRanks(faction: FactionDef, auth: Authority): RankDef[] {
  return faction.ranks.filter((r) => canInvite(faction, auth, r));
}

export function promotionFor(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef | null {
  const above = rankTargets(faction, auth, memberRank).filter((r) => r.order < memberRank.order);
  return above.length ? above[above.length - 1] : null;
}

export function demotionFor(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef | null {
  return rankTargets(faction, auth, memberRank).find((r) => r.order > memberRank.order) || null;
}

// The rank's flag once definitions are loaded (null: the faction is gone), Jarl and Steward before that
export function managesHold(faction: FactionDef | null | undefined, rankSlug: string): boolean {
  if (faction === undefined) return HOLD_MANAGER_RANKS.includes(rankSlug);
  return !!faction && !!rankOf(faction, rankSlug)?.managesProperty;
}

export function canIssueUniform(faction: FactionDef, auth: Authority): boolean {
  if (auth.staff) return true;
  return !!auth.rank && (auth.rank.issuesUniform || isLeaderRank(faction, auth.rank));
}

// A rank's own list replaces the faction list
export const uniformFor = (faction: FactionDef, rank: RankDef): UniformItem[] => rank.uniform && rank.uniform.length ? rank.uniform : faction.uniform;
