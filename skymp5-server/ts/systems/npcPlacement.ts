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
