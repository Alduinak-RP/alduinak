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

// PlaceAtMe needs a self ref (anchorId, usually a player nearby); the new actor then moves to loc; throws on failure
export const placeNpc = (mp: Mp, anchorId: number, baseDesc: string, loc: NpcLocation): number => {
  const self = { type: "form", desc: mp.getDescFromId(anchorId) };
  const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
    self, [{ type: "espm", desc: baseDesc }, 1, false, false]);
  if (!res?.desc) throw new Error("PlaceAtMe returned no reference");
  const id = mp.getIdFromDesc(res.desc);
  mp.set(id, "locationalData", loc);
  mp.set(id, "spawnPoint", loc);
  mp.set(id, "spawnDelay", NEVER_RESPAWN);
  return id;
};
