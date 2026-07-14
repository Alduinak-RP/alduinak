import { Settings } from "./settings";
import * as fetchRetry from "fetch-retry";

type Mp = any;

// Keeps only the gameFactions valid for this character slot (null/undefined slot = all characters)
export function filterAccessForSlot(access: any, slot: number): any {
  if (!access || !Array.isArray(access.gameFactions)) return access;
  return {
    ...access,
    gameFactions: access.gameFactions.filter(
      (gf: any) => gf && (gf.slot === null || gf.slot === undefined || gf.slot === slot)
    ),
  };
}

interface AssignmentRow {
  id?: string;
  requirementId?: string;
  slot?: number | null;
}

interface AccessPayload {
  permissions: unknown[];
  gameFactions: unknown[];
  factions: AssignmentRow[];
}

// Normalizes any master-api response into the private.skympAccess shape the gamemode reads
function pickPayload(data: any): AccessPayload {
  return {
    permissions: Array.isArray(data?.permissions) ? data.permissions : [],
    gameFactions: Array.isArray(data?.gameFactions) ? data.gameFactions : [],
    factions: Array.isArray(data?.factions) ? data.factions : [],
  };
}

// Payloads handed to the gamemode are slot-filtered like the login path when the slot is known
function payloadForSlot(payload: AccessPayload, slot: unknown): AccessPayload {
  return Number.isInteger(slot) ? filterAccessForSlot(payload, slot as number) : payload;
}

// Account-wide rows always apply, slot rows only on a known matching slot; rows scoped to OTHER characters never apply, so mutations cannot destroy their grants
// slot 'any' matches every row: used for offline targets, where no slot is knowable
function rowAppliesToSlot(row: AssignmentRow, slot: unknown): boolean {
  if (slot === "any") return true;
  const rowSlot = row.slot === undefined ? null : row.slot;
  return rowSlot === null || (Number.isInteger(slot) && rowSlot === slot);
}

// "hold:whiterun:jarl" -> "hold:whiterun:" so a player keeps one rank per hold; null for other scopes
function holdPrefixOf(requirementId: string): string | null {
  const parts = String(requirementId || "").split(":");
  return parts.length === 3 && parts[0] === "hold" ? `${parts[0]}:${parts[1]}:` : null;
}

// Attaches the natives the gamemode probes for (mp.assignBackendFaction, mp.removeBackendFaction, mp.fetchBackendAccess); all resolve with the refreshed { permissions, gameFactions, factions } payload for private.skympAccess
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
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(typeof authToken === "string" && authToken ? { "x-auth-token": authToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      retryOn: (attempt: number, error: Error | null, response: Response) =>
        mayRetry && attempt < 3 && (error !== null || response.status >= 500),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(String(data?.error || `master api HTTP ${response.status}`));
    }
    return data;
  };

  const fetchCheck = async (profileId: number): Promise<AccessPayload> =>
    pickPayload(await request("GET", `/profiles/${profileId}/check`));

  server.fetchBackendAccess = async (profileId: number, slot?: unknown): Promise<AccessPayload> =>
    payloadForSlot(await fetchCheck(profileId), slot);

  // Full hold roster (online or not) for the in-game faction menu
  server.fetchHoldRoster = async (holdSlug: string): Promise<unknown[]> => {
    const data = await request("GET", `/holds/${encodeURIComponent(holdSlug)}/roster`);
    return Array.isArray(data?.members) ? data.members : [];
  };

  if (typeof authToken !== "string" || !authToken) {
    console.log("[backendFactionApi] masterApiAuthToken missing, read-only: assign/remove natives not attached");
    return;
  }

  // Mutations are serialized per profile so concurrent appointments cannot interleave their read-then-write cycles
  const queues = new Map<number, Promise<unknown>>();
  const enqueue = <T>(profileId: number, job: () => Promise<T>): Promise<T> => {
    const next = (queues.get(profileId) || Promise.resolve()).then(job, job);
    queues.set(profileId, next.catch(() => undefined));
    return next;
  };

  // Replace-within-hold: one rank per hold, stale ranks are deleted (otherwise demotions never apply, the old higher rank keeps winning)
  server.assignBackendFaction = (profileId: number, requirementId: string, playerName?: string, slot?: unknown): Promise<AccessPayload> =>
    enqueue(profileId, async () => {
      const holdPrefix = holdPrefixOf(requirementId);
      const current = await fetchCheck(profileId);
      const staleRows: AssignmentRow[] = [];
      let alreadyAssigned = false;
      for (const row of current.factions) {
        if (!row || !row.id || typeof row.requirementId !== "string" || !rowAppliesToSlot(row, slot)) continue;
        if (row.requirementId === requirementId) { alreadyAssigned = true; continue; }
        if (holdPrefix && row.requirementId.startsWith(holdPrefix)) staleRows.push(row);
      }
      // POST before deleting the old rank: a rejected POST (capacity, validation) must not cost it
      let latest = alreadyAssigned
        ? current
        : pickPayload(await request("POST", `/profiles/${profileId}/factions`, { requirementId, playerName }));
      for (const row of staleRows) {
        latest = pickPayload(await request("DELETE", `/profiles/${profileId}/factions/${row.id}`));
      }
      return payloadForSlot(latest, slot);
    });

  server.removeBackendFaction = (profileId: number, requirementId: string, slot?: unknown): Promise<AccessPayload> =>
    enqueue(profileId, async () => {
      let latest = await fetchCheck(profileId);
      for (const row of latest.factions.slice()) {
        if (row && row.id && row.requirementId === requirementId && rowAppliesToSlot(row, slot)) {
          latest = pickPayload(await request("DELETE", `/profiles/${profileId}/factions/${row.id}`));
        }
      }
      return payloadForSlot(latest, slot);
    });

  console.log("[backendFactionApi] faction sync natives attached");
}
