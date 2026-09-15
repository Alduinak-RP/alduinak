// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

export interface NpcLocation {
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

// Keeps the engine from reviving placed NPCs; delays past ~1e9 s overflow its timer and fire at once
export const NEVER_RESPAWN = 1e9;

// Neighbor-visible flag (registered in the gamemode) telling clients the NPC attacks players on sight
export const HOSTILE_PROP = "ff_hostile";

// Keeps a placed actor from starting inside the ground
const SPAWN_LIFT = 32;

// Where a follower settles behind its owner
export const FOLLOW_OFFSET = -128;

// Farther than this from its owner, or in another cell, a follower is moved behind them
export const FOLLOW_TELEPORT_DISTANCE = 4096;

// distance > 0 is in front of the anchor, < 0 behind it
export const locationNear = (mp: Mp, anchorId: number, distance: number): NpcLocation => {
  const p = mp.getActorPos(anchorId);
  const angleZ = Number(mp.get(anchorId, "angle")?.[2]) || 0;
  const rad = (angleZ * Math.PI) / 180;
  return {
    cellOrWorldDesc: String(mp.get(anchorId, "worldOrCellDesc")),
    pos: [p[0] + distance * Math.sin(rad), p[1] + distance * Math.cos(rad), p[2] + SPAWN_LIFT],
    rot: [0, 0, angleZ],
  };
};

// PlaceAtMe needs a self ref (anchorId); the new reference starts at the anchor's position and cell; throws on failure
export const placeAtMe = (mp: Mp, anchorId: number, baseDesc: string): number => {
  const self = { type: "form", desc: mp.getDescFromId(anchorId) };
  const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
    self, [{ type: "espm", desc: baseDesc }, 1, false, false]);
  if (!res?.desc) throw new Error("PlaceAtMe returned no reference");
  return mp.getIdFromDesc(res.desc);
};

// The anchor is usually a player nearby; the new actor then moves to loc and never respawns on its own
export const placeNpc = (mp: Mp, anchorId: number, baseDesc: string, loc: NpcLocation): number => {
  const id = placeAtMe(mp, anchorId, baseDesc);
  mp.set(id, "locationalData", loc);
  mp.set(id, "spawnPoint", loc);
  mp.set(id, "spawnDelay", NEVER_RESPAWN);
  return id;
};
