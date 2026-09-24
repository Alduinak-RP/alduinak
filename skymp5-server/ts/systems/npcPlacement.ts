import { toFormId } from "./formIdUtil";

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

// A follower is brought this far in front of its owner, because behind them after a load door is the door itself
const BRING_DISTANCE = 64;

// distance > 0 is in front of the anchor, < 0 behind it
export const locationNear = (mp: Mp, anchorId: number, distance: number, lift = SPAWN_LIFT): NpcLocation => {
  const p = mp.getActorPos(anchorId);
  const angleZ = Number(mp.get(anchorId, "angle")?.[2]) || 0;
  const rad = (angleZ * Math.PI) / 180;
  return {
    cellOrWorldDesc: String(mp.get(anchorId, "worldOrCellDesc")),
    pos: [p[0] + distance * Math.sin(rad), p[1] + distance * Math.cos(rad), p[2] + lift],
    rot: [0, 0, angleZ],
  };
};

// Lifted to clear a 45 degree rise up to the spot, so the follower drops onto the ground instead of starting inside it
export const locationForFollower = (mp: Mp, ownerId: number): NpcLocation =>
  locationNear(mp, ownerId, BRING_DISTANCE, SPAWN_LIFT + BRING_DISTANCE);

export const moveNpc = (mp: Mp, id: number, loc: NpcLocation): void => {
  mp.set(id, "locationalData", loc);
  mp.set(id, "spawnPoint", loc);
};

// A CONT base given as a desc ("c674b:Skyrim.esm") or a load-order id; "" when it is neither
export const containerDesc = (mp: Mp, raw: unknown): string => {
  try {
    const desc = typeof raw === "string" && raw.includes(":") ? raw : mp.getDescFromId(toFormId(raw));
    if (mp.lookupEspmRecordById(mp.getIdFromDesc(desc))?.record?.type === "CONT") return desc;
  } catch { }
  return "";
};

// PlaceAtMe needs a self ref (anchorId); the new reference starts at the anchor's position and cell; throws on failure
export const placeAtMe = (mp: Mp, anchorId: number, baseDesc: string, disabled = false): number => {
  const self = { type: "form", desc: mp.getDescFromId(anchorId) };
  const res = mp.callPapyrusFunction("method", "ObjectReference", "PlaceAtMe",
    self, [{ type: "espm", desc: baseDesc }, 1, false, disabled]);
  if (!res?.desc) throw new Error("PlaceAtMe returned no reference");
  return mp.getIdFromDesc(res.desc);
};

// The anchor is usually a player nearby; the new actor then moves to loc and never respawns on its own
export const placeNpc = (mp: Mp, anchorId: number, baseDesc: string, loc: NpcLocation): number => {
  // Enabled only at loc: a same-grid teleport never reaches clients, so they would create it at the anchor
  const id = placeAtMe(mp, anchorId, baseDesc, true);
  moveNpc(mp, id, loc);
  mp.set(id, "spawnDelay", NEVER_RESPAWN);
  mp.set(id, "isDisabled", false);
  return id;
};
