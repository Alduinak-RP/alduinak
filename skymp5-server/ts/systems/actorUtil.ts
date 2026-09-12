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

export const baseIdOf = (mp: Mp, actorId: number): number => {
  try {
    const desc = mp.get(actorId, "baseDesc");
    return typeof desc === "string" && desc ? mp.getIdFromDesc(desc) >>> 0 : 0;
  } catch {
    return 0;
  }
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

export const hex = (id: number): string => (id >>> 0).toString(16);

// Removes a server-placed actor or object for every client; throws when the form does not exist
export const destroyRef = (mp: Mp, id: number): void => {
  if (mp.get(id, "type") === "MpActor") {
    mp.destroyActor(id);
    return;
  }
  mp.callPapyrusFunction("method", "ObjectReference", "Delete", { type: "form", desc: mp.getDescFromId(id) }, []);
};

// Forms of a previous run exist only after the world DB loads (WORLD_LOADED_EVENT); returns how many were removed
export const destroyLeftovers = (mp: Mp, ids: number[]): number =>
  ids.filter((id) => {
    try {
      destroyRef(mp, id);
      return true;
    } catch {
      return false;
    }
  }).length;
