// Faction rank policy on top of the backend definitions; pure data, no mp calls

export interface UniformItem {
  item: string;
  count: number;
}

// A character joins at most one faction of each type
export type FactionType = "hold" | "military" | "guild";

export const FACTION_TYPES: FactionType[] = ["hold", "military", "guild"];

export interface RankDef {
  id: string;
  slug: string;
  name: string;
  // Prefix Show Title puts before the character's name; the rank name when the backend sets none
  title: string;
  titleFemale: string;
  order: number;
  capacity: number | null;
  // Every permission of the faction, and only ever held in one faction at a time
  leader: boolean;
  // Rank slugs an outsider may be recruited into, and the ranks a member below this one may be moved to
  recruit: string[];
  promote: string[];
  remove: boolean;
  craft: boolean;
  housing: boolean;
  arrest: boolean;
  execute: boolean;
  factionAccess: boolean;
  issuesUniform: boolean;
  uniform: UniformItem[] | null;
}

export type Permission = "remove" | "craft" | "housing" | "arrest" | "execute";

export interface RegentSeat {
  profileId: number;
  slot: number | null;
}

export interface FactionDef {
  id: string;
  scope: string;
  type: FactionType;
  name: string;
  zone: string;
  color: string;
  uniform: UniformItem[];
  regencyEnabled: boolean;
  // Ordered stand-ins; the first one online acts while no leader is
  regents: RegentSeat[];
  // Ladder order, the leader first
  ranks: RankDef[];
}

// A character's standing in one faction; staff act with every right and no rank, acting marks a regent standing in for the leader
export interface Authority {
  staff: boolean;
  rank: RankDef | null;
  acting: boolean;
}

export interface Membership {
  factionId: string;
  rankSlug: string;
  slot: number | null;
  since: number;
}

export const HOLD_MANAGER_RANKS = ["jarl", "steward"];

// What an acting regent is called instead of the leader's own title
const REGENT_TITLES: Record<FactionType, string> = {
  hold: "Lord Regent",
  military: "Acting Commander",
  guild: "Acting Guildmaster",
};

const DEFAULT_COLOR = "c9a36b";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

const slugList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

const uniformList = (v: unknown): UniformItem[] | null =>
  Array.isArray(v)
    ? v.filter((u) => u && typeof u.item === "string" && Number.isInteger(u.count) && u.count > 0).map((u) => ({ item: u.item, count: u.count }))
    : null;

const factionType = (v: unknown, scope: string): FactionType =>
  FACTION_TYPES.includes(v as FactionType) ? (v as FactionType) : scope === "hold" ? "hold" : "guild";

const regentSeats = (v: unknown): RegentSeat[] =>
  (Array.isArray(v) ? v : [])
    .map((r) => r as Record<string, unknown>)
    .filter((r) => Number.isInteger(r?.profileId) && (r.profileId as number) > 0)
    .map((r) => ({ profileId: r.profileId as number, slot: Number.isInteger(r.slot) ? (r.slot as number) : null }));

const timeOf = (v: unknown): number => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
};

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
    const scope = id.split(":")[0];
    out.set(id, {
      id,
      scope,
      type: factionType(r.type, scope),
      name: str(r.name) || str(r.group) || id,
      zone: str(r.zone),
      color: /^[0-9a-f]{6}$/.test(str(r.color)) ? str(r.color) : DEFAULT_COLOR,
      uniform: uniformList(r.uniform) || [],
      regencyEnabled: r.regencyEnabled === true,
      regents: regentSeats(r.regents),
      ranks: [],
    });
  }
  for (const q of raw?.requirements || []) {
    const r = q as Record<string, unknown>;
    const split = splitRequirementId(r?.id);
    const faction = split && out.get(split[0]);
    if (!split || !faction) continue;
    const order = Number.isInteger(r.order) ? (r.order as number) : faction.ranks.length;
    const name = str(r.rank) || split[1];
    const title = str(r.title) || name;
    faction.ranks.push({
      id: str(r.id),
      slug: split[1],
      name,
      title,
      titleFemale: str(r.titleFemale) || title,
      order,
      capacity: Number.isInteger(r.capacity) && (r.capacity as number) > 0 ? (r.capacity as number) : null,
      leader: typeof r.leader === "boolean" ? r.leader : order === 0,
      recruit: slugList(r.recruit),
      promote: slugList(r.promote),
      remove: r.remove === true,
      craft: r.craft === true,
      housing: typeof r.housing === "boolean" ? r.housing : faction.scope === "hold" && HOLD_MANAGER_RANKS.includes(split[1]),
      arrest: r.arrest === true,
      execute: r.execute === true,
      factionAccess: r.factionAccess !== false,
      issuesUniform: r.issuesUniform === true,
      uniform: uniformList(r.uniform),
    });
  }
  for (const faction of out.values()) faction.ranks.sort((a, b) => a.order - b.order);
  return out;
}

export const rankOf = (faction: FactionDef, slug: string): RankDef | null => faction.ranks.find((r) => r.slug === slug) || null;

export const leaderRanks = (faction: FactionDef): RankDef[] => faction.ranks.filter((r) => r.leader);

export const isLeaderRank = (faction: FactionDef, rank: RankDef): boolean => rank.leader;

// Every faction row of private.skympAccess (already narrowed to the character)
export function membershipsOf(access: unknown): Membership[] {
  const rows = access && Array.isArray((access as { factions?: unknown }).factions) ? (access as { factions: unknown[] }).factions : [];
  const out: Membership[] = [];
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    const split = splitRequirementId(r?.requirementId);
    if (!split) continue;
    out.push({ factionId: split[0], rankSlug: split[1], slot: Number.isInteger(r.slot) ? (r.slot as number) : null, since: timeOf(r.createdAt) });
  }
  return out;
}

// Hold ranks by hold key, for housing
export function holdRanksOf(access: unknown): Array<{ factionId: string; hold: string; rank: string }> {
  return membershipsOf(access)
    .filter((m) => m.factionId.startsWith("hold:"))
    .map((m) => ({ factionId: m.factionId, hold: holdKey(m.factionId.slice(5)), rank: m.rankSlug }));
}

// Staff, a leader and a regent standing in for one all act with the whole ladder's rights
export const hasFullAuthority = (auth: Authority): boolean => auth.staff || auth.acting || !!auth.rank?.leader;

// Where the actor sits on the ladder; anyone with full authority acts from above the top rank
const ownOrder = (auth: Authority): number => (hasFullAuthority(auth) ? -1 : auth.rank ? auth.rank.order : Infinity);

// A member strictly below the actor on the ladder may be acted on; nobody acts on their own rank or above it
export const canActOn = (auth: Authority, memberRank: RankDef): boolean => ownOrder(auth) < memberRank.order;

export function hasPermission(auth: Authority, key: Permission): boolean {
  return hasFullAuthority(auth) || !!auth.rank?.[key];
}

// The ranks an outsider may be recruited into; a leader recruits into anything but a leader seat
export function recruitableRanks(faction: FactionDef, auth: Authority): RankDef[] {
  if (!auth.staff && !auth.rank) return [];
  if (hasFullAuthority(auth)) return faction.ranks.filter((r) => !r.leader);
  return faction.ranks.filter((r) => !r.leader && auth.rank!.recruit.includes(r.slug));
}

// Recruit takes the lowest rank the actor may recruit into, as the spec asks
export function recruitRankFor(faction: FactionDef, auth: Authority): RankDef | null {
  const ranks = recruitableRanks(faction, auth);
  return ranks.length ? ranks[ranks.length - 1] : null;
}

// The ranks the actor may move this member to, up or down; the leader may place anyone anywhere below itself
export function promoteTargets(faction: FactionDef, auth: Authority, memberRank: RankDef): RankDef[] {
  if (!canActOn(auth, memberRank)) return [];
  const allowed = hasFullAuthority(auth) ? faction.ranks : faction.ranks.filter((r) => auth.rank!.promote.includes(r.slug));
  return allowed.filter((r) => r.slug !== memberRank.slug && r.order > ownOrder(auth));
}

export const canSetRank = (faction: FactionDef, auth: Authority, memberRank: RankDef, target: RankDef): boolean =>
  promoteTargets(faction, auth, memberRank).some((r) => r.slug === target.slug);

export const canRemove = (faction: FactionDef, auth: Authority, memberRank: RankDef): boolean =>
  canActOn(auth, memberRank) && hasPermission(auth, "remove");

// Only a leader (or staff) seats regents, and never in a second faction
export const canManageRegency = (auth: Authority): boolean => auth.staff || !!auth.rank?.leader;

export function canIssueUniform(faction: FactionDef, auth: Authority): boolean {
  return hasFullAuthority(auth) || !!auth.rank?.issuesUniform;
}

// A rank's own list replaces the faction list
export const uniformFor = (faction: FactionDef, rank: RankDef): UniformItem[] => rank.uniform && rank.uniform.length ? rank.uniform : faction.uniform;

// The Show Title prefix: an acting regent carries the faction type's regent title, everyone else their rank's
export function titleOf(faction: FactionDef, rank: RankDef, acting: boolean, female: boolean): string {
  if (acting) return REGENT_TITLES[faction.type];
  return female ? rank.titleFemale : rank.title;
}

// The rank's flag once definitions are loaded (null: the faction is gone), Jarl and Steward before that
export function managesHold(faction: FactionDef | null | undefined, rankSlug: string): boolean {
  if (faction === undefined) return HOLD_MANAGER_RANKS.includes(rankSlug);
  return !!faction && !!rankOf(faction, rankSlug)?.housing;
}
