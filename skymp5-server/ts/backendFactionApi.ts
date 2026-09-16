import { Settings } from "./settings";
import * as fetchRetry from "fetch-retry";

type Mp = any;

const READ_TIMEOUT_MS = 5000;
// Longer so a slow but committed write is rarely reported as failed
const WRITE_TIMEOUT_MS = 15000;

// Keeps only the rows valid for this character slot (null/undefined slot = all characters); permissions follow the kept rows
export function filterAccessForSlot(access: any, slot: number): any {
  if (!access || typeof access !== "object") return access;
  const applies = (row: any) => row && (row.slot === null || row.slot === undefined || row.slot === slot);
  const out = { ...access };
  if (Array.isArray(access.gameFactions)) out.gameFactions = access.gameFactions.filter(applies);
  if (Array.isArray(access.factions)) {
    out.factions = access.factions.filter(applies);
    out.permissions = out.factions.map((row: any) => row.permission).filter((p: unknown) => typeof p === "string" && p);
  }
  return out;
}

interface AssignmentRow {
  id?: string;
  requirementId?: string;
  slot?: number | null;
  permission?: string | null;
}

export interface AccessPayload {
  permissions: unknown[];
  gameFactions: unknown[];
  factions: AssignmentRow[];
}

export interface RosterRow {
  profileId: number | null;
  playerName: string;
  rank: string | null;
  rankSlug: string;
  slot: number | null;
}

export interface CharacterReport {
  slot: number;
  name: string;
  dead: boolean;
}

// Every call resolves with the account-wide payload; callers narrow it to a character with filterAccessForSlot
export interface FactionBackend {
  fetchAccess(profileId: number): Promise<AccessPayload>;
  fetchDefinitions(): Promise<{ factions: unknown[]; requirements: unknown[] }>;
  fetchRoster(factionId: string): Promise<RosterRow[]>;
  assign(profileId: number, requirementId: string, playerName: string, slot: number | null, by: string): Promise<AccessPayload>;
  remove(profileId: number, requirementId: string, slot: number | null): Promise<AccessPayload>;
  releaseCharacter(profileId: number, slot: number, accountWide: boolean): Promise<{ removed: { requirementId: string; rank: string | null; group: string | null }[]; payload: AccessPayload }>;
  reportCharacters(profileId: number, characters: CharacterReport[]): Promise<void>;
}

// Normalizes any master-api response into the private.skympAccess shape the gamemode reads
function pickPayload(data: any): AccessPayload {
  return {
    permissions: Array.isArray(data?.permissions) ? data.permissions : [],
    gameFactions: Array.isArray(data?.gameFactions) ? data.gameFactions : [],
    factions: Array.isArray(data?.factions) ? data.factions : [],
  };
}

// A null slot names the rows shared by every character, a number one character's rows; a mutation never touches another character's rows
function rowAppliesToSlot(row: AssignmentRow, slot: number | null): boolean {
  const rowSlot = row.slot === undefined ? null : row.slot;
  return rowSlot === null || rowSlot === slot;
}

// "hold:whiterun:jarl" -> "hold:whiterun:" so a character keeps one rank per faction
function groupPrefixOf(requirementId: string): string | null {
  const parts = String(requirementId || "").split(":");
  return parts.length === 3 ? `${parts[0]}:${parts[1]}:` : null;
}

// Null when the backend is not configured for faction writes
export function factionBackendOf(server: Mp): FactionBackend | null {
  const api = server && server.factionBackend;
  return api && typeof api.assign === "function" ? api as FactionBackend : null;
}

// Attaches server.factionBackend plus mp.fetchBackendAccess for the gamemode
export function attachBackendFactionApi(server: Mp, settings: Settings): void {
  const master = String(settings.master || "").replace(/\/+$/, "");
  const masterKey = settings.masterKey;
  const authToken = settings.allSettings ? settings.allSettings["masterApiAuthToken"] : undefined;

  if (!master || !masterKey) {
    console.log("[backendFactionApi] master url or masterKey missing, faction sync natives not attached");
    return;
  }

  const doFetch = fetchRetry.default(global.fetch);
  const base = `${master}/api/servers/${masterKey}`;

  // Attempt cap lives in retryOn (fetch-retry ignores 'retries' when retryOn is a function); mutations never retry, replaying a committed POST/DELETE misreports success as failure
  const request = async (method: string, path: string, body?: unknown): Promise<any> => {
    const mayRetry = method === "GET";
    // One deadline covers every attempt so an unreachable master cannot hold a player's request queue
    const signal = AbortSignal.timeout(mayRetry ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(typeof authToken === "string" && authToken ? { "x-auth-token": authToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      retryOn: (attempt: number, error: Error | null, response: Response) =>
        mayRetry && attempt < 3 && !signal.aborted && (error !== null || response.status >= 500),
    });
    // A body cut off by the deadline must fail, an empty payload would read as no ranks
    const data = await response.json().catch((e: unknown) => { if (signal.aborted) throw e; return {}; });
    if (!response.ok) {
      throw new Error(String(data?.error || `master api HTTP ${response.status}`));
    }
    return data;
  };

  const fetchCheck = async (profileId: number): Promise<AccessPayload> =>
    pickPayload(await request("GET", `/profiles/${profileId}/check`));

  server.fetchBackendAccess = async (profileId: number, slot?: unknown): Promise<AccessPayload> => {
    const payload = await fetchCheck(profileId);
    return Number.isInteger(slot) ? filterAccessForSlot(payload, slot as number) : payload;
  };

  if (typeof authToken !== "string" || !authToken) {
    console.log("[backendFactionApi] masterApiAuthToken missing, read-only: the faction system is disabled");
    return;
  }

  // Mutations are serialized per profile so concurrent appointments cannot interleave their read-then-write cycles
  const queues = new Map<number, Promise<unknown>>();
  const enqueue = <T>(profileId: number, job: () => Promise<T>): Promise<T> => {
    const next = (queues.get(profileId) || Promise.resolve()).then(job, job);
    queues.set(profileId, next.catch(() => undefined));
    return next;
  };

  const backend: FactionBackend = {
    fetchAccess: fetchCheck,

    fetchDefinitions: async () => {
      const data = await request("GET", "/factions");
      return {
        factions: Array.isArray(data?.factions) ? data.factions : [],
        requirements: Array.isArray(data?.requirements) ? data.requirements : [],
      };
    },

    fetchRoster: async (factionId) => {
      const [scope, group] = factionId.split(":");
      const data = await request("GET", `/groups/${encodeURIComponent(scope)}/${encodeURIComponent(group)}/roster`);
      return Array.isArray(data?.members) ? data.members : [];
    },

    // Replace-within-faction: one rank per faction per character, stale ranks are deleted (otherwise demotions never apply, the old higher rank keeps winning)
    assign: (profileId, requirementId, playerName, slot, by) =>
      enqueue(profileId, async () => {
        const prefix = groupPrefixOf(requirementId);
        const current = await fetchCheck(profileId);
        const staleRows: AssignmentRow[] = [];
        let alreadyAssigned = false;
        for (const row of current.factions) {
          if (!row || !row.id || typeof row.requirementId !== "string" || !rowAppliesToSlot(row, slot)) continue;
          if (row.requirementId === requirementId && (row.slot ?? null) === slot) { alreadyAssigned = true; continue; }
          if (prefix && row.requirementId.startsWith(prefix)) staleRows.push(row);
        }
        // POST before deleting the old rank: a rejected POST (capacity, validation) must not cost it
        let latest = alreadyAssigned
          ? current
          : pickPayload(await request("POST", `/profiles/${profileId}/factions`, { requirementId, playerName, slot, by }));
        for (const row of staleRows) {
          latest = pickPayload(await request("DELETE", `/profiles/${profileId}/factions/${row.id}`));
        }
        return latest;
      }),

    remove: (profileId, requirementId, slot) =>
      enqueue(profileId, async () => {
        let latest = await fetchCheck(profileId);
        for (const row of latest.factions.slice()) {
          if (row && row.id && row.requirementId === requirementId && (row.slot ?? null) === slot) {
            latest = pickPayload(await request("DELETE", `/profiles/${profileId}/factions/${row.id}`));
          }
        }
        return latest;
      }),

    releaseCharacter: (profileId, slot, accountWide) =>
      enqueue(profileId, async () => {
        const data = await request("DELETE", `/profiles/${profileId}/characters/${slot}/factions${accountWide ? "?accountWide=1" : ""}`);
        return { removed: Array.isArray(data?.removed) ? data.removed : [], payload: pickPayload(data) };
      }),

    reportCharacters: async (profileId, characters) => {
      await request("PUT", `/profiles/${profileId}/characters`, { characters });
    },
  };
  server.factionBackend = backend;

  console.log("[backendFactionApi] faction sync natives attached");
}
