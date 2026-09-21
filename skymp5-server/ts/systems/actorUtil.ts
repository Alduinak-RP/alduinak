import { sendJson } from "./playerText";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Connected user of an actor, or -1
export const userOf = (mp: Mp, actorId: number): number => {
  try {
    const u = mp.getUserByActor(actorId);
    if (typeof u !== "number" || u < 0 || u >= 0xffff || !mp.isConnected(u)) return -1;
    return u;
  } catch {
    return -1;
  }
};

// Corner notification for an online player; offline actors are skipped
export const notifyActor = (mp: Mp, actorId: number, text: string): void =>
  sendJson(mp, userOf(mp, actorId), { customPacketType: "notification", text });

export const baseIdOf = (mp: Mp, actorId: number): number => {
  try {
    const desc = mp.get(actorId, "baseDesc");
    return typeof desc === "string" && desc ? mp.getIdFromDesc(desc) >>> 0 : 0;
  } catch {
    return 0;
  }
};

export const GOLD_BASE_ID = 0x0000000f;

// Record type of a reference's base ("DOOR", "FURN"...), "" when unknown
export const baseTypeOf = (mp: Mp, refId: number): string => {
  try {
    return String(mp.lookupEspmRecordById(baseIdOf(mp, refId))?.record?.type ?? "");
  } catch {
    return "";
  }
};

export const isDoorRef = (mp: Mp, refId: number): boolean => baseTypeOf(mp, refId) === "DOOR";

// Whether the inventory holds at least one item whose base id matches
export const holdsItem = (mp: Mp, actorId: number, match: (baseId: number) => boolean): boolean => {
  try {
    const inv = mp.get(actorId, "inventory");
    const entries: any[] = inv && Array.isArray(inv.entries) ? inv.entries : [];
    return entries.some((e) => Number(e.count) > 0 && match(Number(e.baseId) >>> 0));
  } catch {
    return false;
  }
};

// "45 min" or "3 h 12 min", rounded up to the minute
export const formatWait = (ms: number): string => {
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
};

// Player characters use the Player NPC_ (0x7) base and keep a profile id while logged out
export const isPlayerActor = (mp: Mp, actorId: number): boolean => {
  const base = baseIdOf(mp, actorId);
  if (base > 0 && base <= 0x7) return true;
  try {
    return Number(mp.get(actorId, "profileId")) >= 0;
  } catch {
    return false;
  }
};

// False for dead actors and for anything that is not an actor
export const isAlive = (mp: Mp, actorId: number): boolean => {
  try {
    return mp.get(actorId, "isDead") === false;
  } catch {
    return false;
  }
};

// Wraps an mp.* event hook: the previous handler runs first, a false from either one vetoes, and a handler that throws is logged and never vetoes
export const chainMpHook = (mp: Mp, event: string, fn: (...args: any[]) => unknown): void => {
  const previous = typeof mp[event] === "function" ? mp[event] : null;
  const run = (handler: (...args: unknown[]) => unknown, args: unknown[]): unknown => {
    try {
      return handler.apply(mp, args);
    } catch (e) {
      console.error(`[${event}] handler failed: ${e}`);
      return undefined;
    }
  };
  mp[event] = (...args: unknown[]): boolean => {
    if (previous && run(previous, args) === false) return false;
    return run(fn, args) !== false;
  };
};

// Same cell or worldspace and within range
export const isNear = (mp: Mp, aId: number, bId: number, range: number): boolean => {
  try {
    if (mp.getActorCellOrWorld(aId) !== mp.getActorCellOrWorld(bId)) return false;
    const a = mp.getActorPos(aId);
    const b = mp.getActorPos(bId);
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz <= range * range;
  } catch {
    return false;
  }
};

// False when the viewer is in another cell or worldspace or outside the grid the server streams around the actor, so their client has no copy of it
export const isStreamedTo = (mp: Mp, actorId: number, viewerId: number): boolean => {
  try {
    const ids: unknown[] = mp.get(actorId, "actorNeighbors") ?? [];
    return ids.some((id) => Number(id) >>> 0 === viewerId >>> 0);
  } catch {
    return false;
  }
};

// Introduced through the gamemode's ff_knownIds; without that list everyone counts as known
export const isIntroduced = (mp: Mp, viewerActorId: number, subjectActorId: number): boolean => {
  try {
    const known = mp.get(viewerActorId, "ff_knownIds");
    return !Array.isArray(known) || known.includes(subjectActorId);
  } catch {
    return true;
  }
};

// The subject's name as the viewer may see it: real once introduced, otherwise the anonymity placeholder
export const nameShownTo = (mp: Mp, viewerActorId: number, subjectActorId: number): string => {
  if (!isIntroduced(mp, viewerActorId, subjectActorId)) return "A stranger";
  try {
    const n = mp.getActorName(subjectActorId);
    if (typeof n === "string" && n.trim()) return n.trim();
  } catch { /* no name */ }
  return "Someone";
};

// Letters, numbers, spaces and a few marks, single-spaced, trimmed and capped; empty when nothing usable is left
export const cleanDisplayName = (raw: unknown, max: number): string =>
  String(raw ?? "").replace(/[^A-Za-z0-9 '_-]/g, "").replace(/\s+/g, " ").trim().slice(0, max);

export const hex = (id: number): string => (id >>> 0).toString(16);

// Removes a server-placed actor or object for every client; throws when the form does not exist
export const destroyRef = (mp: Mp, id: number): void => {
  if (mp.get(id, "type") === "MpActor") {
    mp.destroyActor(id);
    return;
  }
  mp.callPapyrusFunction("method", "ObjectReference", "Delete", { type: "form", desc: mp.getDescFromId(id) }, []);
};

// Through Papyrus, so the server records learnedSpells (which HasSpell reads) and the client learns it live; throws when a form is unknown
export const addSpellTo = (mp: Mp, actorId: number, spellId: number): void => {
  mp.callPapyrusFunction("method", "Actor", "AddSpell", { type: "form", desc: mp.getDescFromId(actorId) }, [{ type: "espm", desc: mp.getDescFromId(spellId) }, false]);
};

export const removeSpellFrom = (mp: Mp, actorId: number, spellId: number): void => {
  mp.callPapyrusFunction("method", "Actor", "RemoveSpell", { type: "form", desc: mp.getDescFromId(actorId) }, [{ type: "espm", desc: mp.getDescFromId(spellId) }]);
};

export const addItemTo = (mp: Mp, actorId: number, itemId: number, count: number, silent = false): void => {
  mp.callPapyrusFunction("method", "ObjectReference", "AddItem", { type: "form", desc: mp.getDescFromId(actorId) }, [{ type: "espm", desc: mp.getDescFromId(itemId) }, count, silent]);
};

// Forms of a previous run exist only after the world DB loads (WORLD_LOADED_EVENT); plugin refs, player characters and ids failing isOurs are kept
export const destroyLeftovers = (mp: Mp, ids: number[], isOurs: (id: number) => boolean): number =>
  ids.filter((id) => {
    try {
      if (id >>> 0 < 0xff000000 || isPlayerActor(mp, id) || !isOurs(id)) return false;
      destroyRef(mp, id);
      return true;
    } catch {
      return false;
    }
  }).length;
