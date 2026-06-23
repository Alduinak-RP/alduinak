// ── Respawn (wake at nearest temple) — gamemode-owned ─────────────────────────
//
// Falling off a cliff (or any lethal hit) does the engine's normal death:
// ragdoll → death-state for `spawnDelay` seconds → respawn at the player's
// `spawnPoint`. This system points that spawn point at the nearest Temple of the
// Divines the instant the player dies, sets the bleedout time to a minute, and
// makes them wake at ~1 HP so they must seek healing.
//
// Players spawn INSIDE the temple (the interior cell the temple door leads to),
// not on the exterior steps — the exterior doors live in city worldspaces, so a
// Tamriel-cell position there is empty no-collision geometry.
//
// Works with the SHIPPING engine (scam_native.node): only uses `onDeath`,
// `spawnPoint`, `spawnDelay`, and `respawnPercentages` — no native rebuild.
//
// Wiring (gamemode entry init, alongside the other *.init calls):
//   import * as respawn from './systems/respawn';
//   respawn.init(mp, store, bus);

import { safeGet, safeSet } from '../mpUtil';
import { risePlayer } from './combat';

// ── Tuning ────────────────────────────────────────────────────────────────────

const BLEEDOUT_SECONDS = 60;                  // engine death-state before respawn
const BLEEDOUT_MS = BLEEDOUT_SECONDS * 1000;  // staff-downing JS timer
const WAKE_HEALTH = 0.01;                     // ~1 HP (engine minimum, 1% of max)

// ── Temple table ──────────────────────────────────────────────────────────────
// `dest` is INSIDE each temple — the interior cell + position the temple door
// leads to (resolved from Skyrim.esm). `cellOrWorldDesc` is "<hexFormId>:file".

interface LocationalData {
  cellOrWorldDesc: string;
  pos: [number, number, number];
  rot: [number, number, number];
}

const SOLITUDE: LocationalData  = { cellOrWorldDesc: '16a02:Skyrim.esm', pos: [1536, -788, 192],    rot: [0, 0, 180] }; // Temple of the Divines
const MARKARTH: LocationalData  = { cellOrWorldDesc: '16df3:Skyrim.esm', pos: [-1872, -1520, 64],   rot: [0, 0, 180] }; // Temple of Dibella
const FALKREATH: LocationalData = { cellOrWorldDesc: '13a71:Skyrim.esm', pos: [-1728, -391, 0],     rot: [0, 0, 180] }; // Falkreath Hall of the Dead
const WHITERUN: LocationalData  = { cellOrWorldDesc: '165a7:Skyrim.esm', pos: [225, 1138, 131],     rot: [0, 0, 270] }; // Temple of Kynareth
const WINDHELM: LocationalData  = { cellOrWorldDesc: '16786:Skyrim.esm', pos: [-482, -1536, 279],   rot: [0, 0, 0]   }; // Temple of Talos
const RIFTEN: LocationalData    = { cellOrWorldDesc: '16bd7:Skyrim.esm', pos: [-1408, -448, 68],    rot: [0, 0, 0]   }; // Temple of Mara

interface TempleAnchor { name: string; x: number; y: number; dest: LocationalData; }

// One anchor per hold. `x`/`y` are the temple-door map positions used to pick the
// nearest temple. Temple holds anchor on their temple; temple-less holds
// (Winterhold & Dawnstar → Windhelm, Morthal → Solitude) anchor on the hold.
const TEMPLE_ANCHORS: TempleAnchor[] = [
  { name: 'Solitude',   x: -58661,  y: 110698, dest: SOLITUDE },
  { name: 'Markarth',   x: -176816, y: 4500,   dest: MARKARTH },
  { name: 'Falkreath',  x: -34593,  y: -84340, dest: FALKREATH },
  { name: 'Whiterun',   x: 24159,   y: -3366,  dest: WHITERUN },
  { name: 'Windhelm',   x: 131512,  y: 38458,  dest: WINDHELM },
  { name: 'Riften',     x: 176376,  y: -97022, dest: RIFTEN },
  { name: 'Winterhold', x: 130000,  y: 123000, dest: WINDHELM },
  { name: 'Dawnstar',   x: 4000,    y: 130000, dest: WINDHELM },
  { name: 'Morthal',    x: -32000,  y: 92000,  dest: SOLITUDE },
];

export function nearestTemple(pos: number[] | null): TempleAnchor {
  const px = Array.isArray(pos) ? pos[0] : 0;
  const py = Array.isArray(pos) ? pos[1] : 0;
  let best = TEMPLE_ANCHORS[0];
  let bestSq = Infinity;
  for (const t of TEMPLE_ANCHORS) {
    const dx = t.x - px;
    const dy = t.y - py;
    const sq = dx * dx + dy * dy;
    if (sq < bestSq) { bestSq = sq; best = t; }
  }
  return best;
}

// ── Real deaths: spawn inside the nearest temple, at 1 HP ──────────────────────
// Runs from the engine `onDeath` hook, BEFORE the engine schedules the respawn.

export function onPlayerDeath(mp: any, store: any, dyingActorId: number): void {
  // Only redirect real, connected player characters — never NPCs.
  const isPlayer = store.getAll().some((p: any) => p.actorId === dyingActorId);
  if (!isPlayer) return;

  const pos = safeGet(mp, dyingActorId, 'pos', null) as number[] | null;
  const temple = nearestTemple(pos);
  safeSet(mp, dyingActorId, 'spawnPoint', temple.dest);
  safeSet(mp, dyingActorId, 'spawnDelay', BLEEDOUT_SECONDS);
  safeSet(mp, dyingActorId, 'respawnPercentages', { health: WAKE_HEALTH, magicka: 1, stamina: 1 });
  console.log('[respawn] ' + dyingActorId.toString(16) + ' down — will wake at the ' + temple.name + ' temple (1 HP)');
}

// ── Staff downing (combat.downPlayer / playerDowned): teleport-based bleedout ──

const timers = new Map<unknown, ReturnType<typeof setTimeout>>();

export function cancelTempleRespawn(playerId: unknown): void {
  const h = timers.get(playerId);
  if (h !== undefined) { clearTimeout(h); timers.delete(playerId); }
}

export function scheduleTempleRespawn(mp: any, store: any, bus: any, playerId: unknown): void {
  cancelTempleRespawn(playerId);
  const h = setTimeout(() => {
    timers.delete(playerId);
    try { passOutAtTemple(mp, store, bus, playerId); }
    catch (err: any) { console.error('[respawn] passOut error: ' + (err && err.message)); }
  }, BLEEDOUT_MS);
  timers.set(playerId, h);
}

function passOutAtTemple(mp: any, store: any, bus: any, playerId: unknown): void {
  const player = store.get(playerId);
  if (!player || !player.actorId) return;
  if (player.isCaptive) return; // restrained — being marched, don't whisk away
  if (!player.isDown) return;   // already healed / on their feet
  const pos = safeGet(mp, player.actorId, 'pos', null) as number[] | null;
  const temple = nearestTemple(pos);
  safeSet(mp, player.actorId, 'locationalData', temple.dest);
  safeSet(mp, player.actorId, 'percentages', { health: WAKE_HEALTH, magicka: 1, stamina: 1 });
  risePlayer(mp, store, bus, playerId);
  bus.dispatch({ type: 'templeRespawn', playerId, temple: temple.name });
  console.log('[respawn] ' + (player.name || playerId) + ' woke at the ' + temple.name + ' temple');
}

// ── Init ─────────────────────────────────────────────────────────────────────

export function init(mp: any, store: any, bus: any): void {
  console.log('[respawn] Initializing');

  mp.onDeath = (dyingActorId: number, _killerId: number) => {
    try { onPlayerDeath(mp, store, dyingActorId); }
    catch (err: any) { console.error('[respawn] onDeath error: ' + (err && err.message)); }
  };

  bus.on('playerDowned', (e: any) => scheduleTempleRespawn(mp, store, bus, e.victimId));
  bus.on('playerRisen', (e: any) => cancelTempleRespawn(e.playerId));
  bus.on('playerCaptured', (e: any) => cancelTempleRespawn(e.captiveId));
  bus.on('playerReleased', (e: any) => {
    const p = store.get(e.captiveId);
    if (p && p.isDown) scheduleTempleRespawn(mp, store, bus, e.captiveId);
  });
  bus.on('playerFinished', (e: any) => cancelTempleRespawn(e.playerId));

  console.log('[respawn] Started');
}
