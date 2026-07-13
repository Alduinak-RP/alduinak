// ── Respawn + Death Screen — gamemode-owned ───────────────────────────────────
//
// On death the engine ragdolls the player and respawns them after `spawnDelay`
// at their `spawnPoint`, restoring `respawnPercentages` of each stat. This
// system:
//   • points that spawn point at the nearest temple INTERIOR with respawn
//     percentages of ~1 HP, and starts a slow "injured" recovery (default
//     outcome). While injured, the periodic tick PINS server health to the
//     recovery curve: the engine's respawn message tells the client "full
//     health" and natural-regen cropping would otherwise accept the client's
//     full bar within minutes, so the curve is re-asserted every tick;
//   • shows the death-screen widget with a countdown + 3 confirm-gated choices,
//     validated server-side (the sender must actually be dead AND hold an
//     unconsumed, server-set death-choice window for THIS death):
//       permadeath  → character locked as a corpse: the engine respawn is
//                     BLOCKED (mp.onRespawn returns false, which blocks
//                     RespawnEvent), and character selection refuses the slot
//                     (spawn.ts reads private.permaDead)
//       resurrect   → full health in place (logged; re-death to the same
//                     killer within 1 hour = forced permadeath)
//       temple      → nearest temple at full health. The 1h no-return zone
//                     around the death spot is currently DISABLED (commented
//                     out): deaths near a temple trapped players in
//                     bounce-backs. The code is kept for a future rework.
//
// Every server → client packet resolves the connection first: sendCustomPacket
// takes a networking userId, NOT an actor/form id, so send() translates via
// getUserByActor + isConnected and silently skips offline actors.
//
// Works with the SHIPPING engine: onDeath / onRespawn hooks + spawnPoint /
// spawnDelay / respawnPercentages / locationalData / percentages / isDead
// properties + getUserActor / getUserByActor / isConnected / sendCustomPacket.
// A `false` return from an mp.onRespawn handler blocks the engine revive
// (GameModeEvent::Fire → OnFireBlocked; SendAndSetDeathState never runs).
// (The engine ALSO has a native nearest-temple fallback, but a spawn point set
// here always wins over it — see MpActor::GetRespawnPosition.)
//
// Coordinates are measured in-game (VGR_Locations survey), not ESM-derived.
//
// Wiring (gamemode entry init):  respawn.init(mp, store, bus);

import { safeGet, safeSet } from '../mpUtil';

// ── Tuning ────────────────────────────────────────────────────────────────────
const BLEEDOUT_SECONDS = 60;
const WAKE_HEALTH = 0.01;               // ~1 HP
const FULL_HEALTH = 1.0;
const REGEN_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours
const REGEN_NATURAL = 0.01;             // ~1 HP / 8h (fraction of max)
const REGEN_HEALER = 0.05;              // ~5 HP / 8h with a healer
// NO-RETURN SYSTEM DISABLED: a death near the respawn temple (e.g. inside
// Whiterun) put the zone on top of the temple, locking the player into
// bounce-backs. Kept commented out for a future rework, see doTempleFullHealth
// and tick below.
// const NO_RETURN_MS = 60 * 60 * 1000;    // 1 hour
// const NO_RETURN_RADIUS = 6000;          // units around the death spot
// const TEMPLE_EXIT_MARGIN = 3000;        // anchor-to-door slack for the trap check
const ARMED_KILLER_TTL_MS = 60 * 60 * 1000; // resurrect anti-glitch arming expires after 1h
const NEVER_RESPAWN = 1e12;             // spawnDelay for a permadead corpse
const TICK_MS = 30 * 1000;
const HEALTH_EPSILON = 0.005;           // don't re-clamp for sub-noise drift

interface Loc { cellOrWorldDesc: string; pos: [number, number, number]; rot: [number, number, number]; }

// ── Temple interiors (measured in-game) ───────────────────────────────────────
const SOLITUDE: Loc  = { cellOrWorldDesc: '16a02:Skyrim.esm', pos: [1676.93, 1571.19, 0],     rot: [0, 0, 15.75] };  // Temple of the Divines
const MARKARTH: Loc  = { cellOrWorldDesc: '16df3:Skyrim.esm', pos: [-1870.36, 356.02, 156.24], rot: [0, 0, 279.5] }; // Temple of Dibella
const FALKREATH: Loc = { cellOrWorldDesc: '13a71:Skyrim.esm', pos: [-1728, -391, 0],          rot: [0, 0, 180] };    // Hall of the Dead
const WHITERUN: Loc  = { cellOrWorldDesc: '165a7:Skyrim.esm', pos: [223.24, 248.85, 54],      rot: [0, 0, 0] };      // Temple of Kynareth
const WINDHELM: Loc  = { cellOrWorldDesc: '16785:Skyrim.esm', pos: [0, -2800, 64.35],         rot: [0, 0, 0] };      // Temple of Talos
const RIFTEN: Loc    = { cellOrWorldDesc: '16bd7:Skyrim.esm', pos: [-1414.34, 208.64, 64],    rot: [0, 0, 15.75] };  // Temple of Mara

// ── Anchors: measured Tamriel positions used to pick the nearest temple ───────
// Hold capitals route to their own temple; temple-less holds to a neighbour
// (Winterhold & Dawnstar → Windhelm, Morthal → Solitude); settlements to their
// hold's temple so villages don't route to whichever capital is closest as the
// crow flies.
const ANCHORS = [
  { name: 'Solitude',        x: -68173.96,  y: 103311.75, dest: SOLITUDE },
  { name: 'Markarth',        x: -169535.31, y: 5386.96,   dest: MARKARTH },
  { name: 'Falkreath',       x: -34020.39,  y: -89435.80, dest: FALKREATH },
  { name: 'Whiterun',        x: 16476.68,   y: -9595.68,  dest: WHITERUN },
  { name: 'Windhelm',        x: 135019.44,  y: 33731.66,  dest: WINDHELM },
  { name: 'Riften',          x: 174274.64,  y: -91459.67, dest: RIFTEN },
  { name: 'Winterhold',      x: 114050.01,  y: 94006.28,  dest: WINDHELM },
  { name: 'Dawnstar',        x: 26328.23,   y: 101092.58, dest: WINDHELM },
  { name: 'Morthal',         x: -39547.51,  y: 70770.92,  dest: SOLITUDE },
  { name: 'Riverwood',       x: 19233.25,   y: -46721.73, dest: WHITERUN },
  { name: 'Rorikstead',      x: -78931.07,  y: 2789.23,   dest: WHITERUN },
  { name: 'Ivarstead',       x: 78291.95,   y: -67062.64, dest: RIFTEN },
  { name: "Dragon's Bridge", x: -100811.45, y: 80907.16,  dest: SOLITUDE },
  { name: 'High Hrothgar',   x: 56897.66,   y: -31974.11, dest: WHITERUN },
];

// Deaths outside the Tamriel worldspace can't use X/Y distance (coordinates
// are in a different space). Route them by where their region connects back
// to Skyrim: Solstheim/Apocrypha → Windhelm (the boat), Forgotten Vale →
// Markarth (Darkfall Cave in the Reach), Soul Cairn → Solitude (Volkihar).
const WORLDSPACE_OVERRIDES: Array<{ match: (desc: string) => boolean; name: string; dest: Loc }> = [
  { match: (d) => d.endsWith(':Dragonborn.esm'), name: 'Windhelm', dest: WINDHELM },
  { match: (d) => d === 'bb5:Dawnguard.esm', name: 'Markarth', dest: MARKARTH },
  { match: (d) => d === '1408:Dawnguard.esm', name: 'Solitude', dest: SOLITUDE },
];

export function nearestTemple(pos: number[] | null): { name: string; dest: Loc } {
  const px = Array.isArray(pos) ? pos[0] : 0;
  const py = Array.isArray(pos) ? pos[1] : 0;
  let best = ANCHORS[0], bestSq = Infinity;
  for (const t of ANCHORS) {
    const dx = t.x - px, dy = t.y - py, sq = dx * dx + dy * dy;
    if (sq < bestSq) { bestSq = sq; best = t; }
  }
  return best;
}

export function pickTemple(worldDesc: string | null, pos: number[] | null): { name: string; dest: Loc; x?: number; y?: number } {
  if (typeof worldDesc === 'string') {
    for (const o of WORLDSPACE_OVERRIDES) {
      if (o.match(worldDesc)) return o;
    }
    // A death inside a temple interior wakes the player in THAT temple:
    // interior coords are cell-local and would otherwise mis-route to
    // whichever anchor happens to be nearest the cell origin (Whiterun).
    for (const t of ANCHORS) {
      if (t.dest.cellOrWorldDesc === worldDesc) return t;
    }
  }
  return nearestTemple(pos);
}

// NO-RETURN SYSTEM DISABLED, kept for a future rework.
// True when the no-return zone around the death spot would cover the temple
// the player is being sent to: enforcing it would just bounce them back on
// every tick. Measured against the DESTINATION temple's own city anchor, not
// the routing anchor (a Riverwood death routes to Whiterun's temple; the zone
// at Riverwood never covers it). Capitals precede settlements in ANCHORS, so
// find() resolves the capital that owns the destination. Anchors share the
// Tamriel coordinate frame with the walled-city child worldspaces, so the X/Y
// comparison is valid for city deaths too; worldspace-override picks carry no
// x/y and correctly fall through to false (their coords are in another space).
// function zoneWouldTrapTemple(temple: { dest: Loc; x?: number; y?: number }, deathWorld: string | null, deathPos: number[] | null): boolean {
//   if (deathWorld === temple.dest.cellOrWorldDesc) return true; // died in the temple cell
//   if (!Array.isArray(deathPos) || typeof temple.x !== 'number' || typeof temple.y !== 'number') return false;
//   const city = ANCHORS.find((a) => a.dest === temple.dest);
//   if (!city) return false;
//   const dx = city.x - deathPos[0], dy = city.y - deathPos[1];
//   return Math.sqrt(dx * dx + dy * dy) < NO_RETURN_RADIUS + TEMPLE_EXIT_MARGIN;
// }

// ── helpers ────────────────────────────────────────────────────────────────────
function isPlayer(store: any, actorId: number): boolean {
  return store.getAll().some((p: any) => p.actorId === actorId);
}
// mp.sendCustomPacket wants a NETWORKING userId (a small connection index),
// never an actor/form id. Resolve via getUserByActor; a userless actor yields
// the InvalidUserId sentinel (0xffff), which isConnected safely rejects. When
// the player is offline the packet is skipped — private.* state already
// persists, so nothing is lost.
function send(mp: any, actorId: number, payload: object): void {
  try {
    const userId = mp.getUserByActor(actorId);
    if (userId === undefined || userId === null || userId < 0) return;
    if (!mp.isConnected(userId)) return;
    mp.sendCustomPacket(userId, JSON.stringify(payload));
  } catch (e) { /* actor not ready / user gone */ }
}
function showDeathScreen(mp: any, actorId: number, seconds: number): void {
  send(mp, actorId, { customPacketType: 'deathScreen', show: true, seconds });
}
function hideDeathScreen(mp: any, actorId: number): void {
  send(mp, actorId, { customPacketType: 'deathScreen', hide: true });
}
// Full restore — deliberately refills magicka/stamina too. ONLY for the
// explicit full-health outcomes (resurrect / temple); the injured tick uses
// setHealthPreserving instead so it can't stealth-refill resources.
function setHealth(mp: any, actorId: number, health: number): void {
  safeSet(mp, actorId, 'percentages', { health, magicka: 1, stamina: 1 });
}
// Write health while keeping the player's CURRENT magicka/stamina.
function setHealthPreserving(mp: any, actorId: number, health: number): void {
  const cur = safeGet(mp, actorId, 'percentages', null) as any;
  const magicka = cur && typeof cur.magicka === 'number' ? cur.magicka : 1;
  const stamina = cur && typeof cur.stamina === 'number' ? cur.stamina : 1;
  safeSet(mp, actorId, 'percentages', { health, magicka, stamina });
}
// Resolve the resurrect anti-glitch arming (expiry, unrelated death, permadeath).
function clearArmedKiller(mp: any, actorId: number): void {
  safeSet(mp, actorId, 'private.resurrectArmedKiller', 0);
  safeSet(mp, actorId, 'private.resurrectArmedUntilMs', 0);
}

// ── Death ────────────────────────────────────────────────────────────────────
function onPlayerDeath(mp: any, store: any, dyingActorId: number, killerId: number): void {
  if (!isPlayer(store, dyingActorId)) return;

  // A permadead corpse must never re-enter the normal death flow (e.g. an
  // admin resurrect followed by a re-kill would otherwise re-arm a 60s temple
  // respawn). Re-assert the never-respawn delay and stop.
  if (safeGet(mp, dyingActorId, 'private.permaDead', false) === true) {
    safeSet(mp, dyingActorId, 'spawnDelay', NEVER_RESPAWN);
    return;
  }

  // Abuse rule: if they resurrected (anti-glitch) and then died AGAIN to the
  // same player WITHIN THE ARMING WINDOW, force permadeath instead of offering
  // the screen. The arming expires (ARMED_KILLER_TTL_MS) so an unrelated fight
  // against the same player days later is a normal death, and any death that
  // doesn't match resolves the arming.
  const armed = safeGet(mp, dyingActorId, 'private.resurrectArmedKiller', 0);
  const armedUntil = safeGet(mp, dyingActorId, 'private.resurrectArmedUntilMs', 0);
  if (killerId && armed === killerId && Date.now() < armedUntil) {
    console.log('[respawn] ' + dyingActorId.toString(16) + ' died again to armed killer ' + killerId.toString(16) + ' within the arming window — forcing permadeath');
    doPermaDeath(mp, dyingActorId, 'died again to the same player after a resurrect');
    return;
  }
  if (armed) clearArmedKiller(mp, dyingActorId);

  const pos = safeGet(mp, dyingActorId, 'pos', null);
  const world = safeGet(mp, dyingActorId, 'worldOrCellDesc', null);
  const temple = pickTemple(world, pos);

  // Default outcome: wake at the nearest temple interior, at 1 HP, injured.
  // (spawnDelay/respawnPercentages take effect because this handler runs
  // BEFORE DeathEvent::OnFireSuccess arms the engine's respawn timer.)
  safeSet(mp, dyingActorId, 'spawnPoint', temple.dest);
  safeSet(mp, dyingActorId, 'spawnDelay', BLEEDOUT_SECONDS);
  safeSet(mp, dyingActorId, 'respawnPercentages', { health: WAKE_HEALTH, magicka: 1, stamina: 1 });

  // Record death context (for the choices) + start the slow recovery clock.
  // private.injuredHealth is the server-authoritative recovery curve the tick
  // clamps live health back to (the client is told "full" on respawn).
  safeSet(mp, dyingActorId, 'private.deathKiller', killerId || 0);
  safeSet(mp, dyingActorId, 'private.deathPos', Array.isArray(pos) ? pos : [0, 0, 0]);
  safeSet(mp, dyingActorId, 'private.deathWorld', typeof world === 'string' ? world : '');
  safeSet(mp, dyingActorId, 'private.injured', true);
  safeSet(mp, dyingActorId, 'private.injuredHealth', WAKE_HEALTH);
  safeSet(mp, dyingActorId, 'private.regenLastMs', Date.now());
  safeSet(mp, dyingActorId, 'private.regenRate', REGEN_NATURAL);

  // One-shot window: deathChoice packets are only honoured while this is set.
  safeSet(mp, dyingActorId, 'private.deathChoicePending', true);

  showDeathScreen(mp, dyingActorId, BLEEDOUT_SECONDS);
  console.log('[respawn] ' + dyingActorId.toString(16) + ' down — death screen shown, will wake at ' + temple.name + ' (1 HP)');
}

// Returning `false` from here (via the mp.onRespawn wrapper) BLOCKS the engine
// respawn: RespawnEvent is discarded, SendAndSetDeathState(false) never runs,
// and the corpse stays where it fell. Re-setting isDead inside this hook is
// useless — the changeform is still flagged dead while the hook runs, so
// SetIsDead(true) hits the "already dead" no-op branch and the engine would
// revive the actor right afterwards.
function onPlayerRespawn(mp: any, store: any, actorId: number): boolean | void {
  if (!isPlayer(store, actorId)) return;
  if (safeGet(mp, actorId, 'private.permaDead', false) === true) {
    // Keep the persisted delay inert so the post-restart re-arm
    // (MpActor::ApplyChangeForm) never schedules a real respawn either.
    safeSet(mp, actorId, 'spawnDelay', NEVER_RESPAWN);
    return false; // block the revive — the body remains
  }
  // The engine respawn consumed this death: close the choice window.
  safeSet(mp, actorId, 'private.deathChoicePending', false);
  hideDeathScreen(mp, actorId);
}

// ── Choices ────────────────────────────────────────────────────────────────────
// deathChoice is a raw client packet — a modified client can send it at any
// time. Only honour it when the sender's actor is actually dead AND still
// holds the one-shot window set by onPlayerDeath; otherwise it would be an
// on-demand full heal / teleport-to-temple.
function onDeathChoice(mp: any, store: any, userId: number, choice: string): void {
  const actorId = mp.getUserActor(userId);
  if (!actorId || !isPlayer(store, actorId)) return;
  if (choice !== 'permadeath' && choice !== 'resurrect' && choice !== 'temple') return;
  if (safeGet(mp, actorId, 'isDead', false) !== true) return;
  if (safeGet(mp, actorId, 'private.deathChoicePending', false) !== true) return;
  safeSet(mp, actorId, 'private.deathChoicePending', false); // consume: once per death

  if (choice === 'permadeath') {
    doPermaDeath(mp, actorId, 'chose permanent death');
  } else if (choice === 'resurrect') {
    doResurrectHere(mp, store, actorId);
  } else if (choice === 'temple') {
    doTempleFullHealth(mp, actorId);
  }
}

// Permadeath holds through TWO locks: onPlayerRespawn returns false while
// private.permaDead is set (blocks the already-armed engine timer), and
// spawn.ts refuses the slot at character select. spawnDelay=NEVER_RESPAWN is
// belt-and-braces for the restart re-arm path.
function doPermaDeath(mp: any, actorId: number, reason: string): void {
  safeSet(mp, actorId, 'private.permaDead', true);
  safeSet(mp, actorId, 'private.injured', false);
  safeSet(mp, actorId, 'private.deathChoicePending', false);
  clearArmedKiller(mp, actorId);
  safeSet(mp, actorId, 'spawnDelay', NEVER_RESPAWN); // keep restart re-arming inert
  safeSet(mp, actorId, 'isDead', true);              // ensure downed (no-op if already dead)
  hideDeathScreen(mp, actorId);
  console.log('[respawn] PERMADEATH ' + actorId.toString(16) + ' — ' + reason + ' (respawn blocked, slot locked, body remains)');
}

function doResurrectHere(mp: any, store: any, actorId: number): void {
  const killer = safeGet(mp, actorId, 'private.deathKiller', 0);
  const count = safeGet(mp, actorId, 'private.resurrectCount', 0) + 1;
  safeSet(mp, actorId, 'isDead', false);   // revive in place (no teleport)
  setHealth(mp, actorId, FULL_HEALTH);
  safeSet(mp, actorId, 'private.injured', false);
  // Full-health outcome: don't leave the 1-HP wake armed for the engine.
  safeSet(mp, actorId, 'respawnPercentages', { health: FULL_HEALTH, magicka: 1, stamina: 1 });
  safeSet(mp, actorId, 'private.resurrectCount', count);
  safeSet(mp, actorId, 'private.resurrectArmedKiller', killer); // re-death to them = permadeath...
  safeSet(mp, actorId, 'private.resurrectArmedUntilMs', Date.now() + ARMED_KILLER_TTL_MS); // ...for 1h
  hideDeathScreen(mp, actorId);
  const name = (store.getAll().find((p: any) => p.actorId === actorId) || {}).name || actorId.toString(16);
  console.log('[respawn][AUDIT] RESURRECT-HERE by ' + name + ' (' + actorId.toString(16) + '), use #' + count + ', armed vs killer ' + (killer ? killer.toString(16) : 'none') + ' for 1h');
}

function doTempleFullHealth(mp: any, actorId: number): void {
  const deathPos = safeGet(mp, actorId, 'private.deathPos', null);
  const deathWorld = safeGet(mp, actorId, 'private.deathWorld', null);
  const temple = pickTemple(deathWorld, deathPos);
  safeSet(mp, actorId, 'isDead', false);                      // revive
  safeSet(mp, actorId, 'locationalData', temple.dest);        // move to temple now
  setHealth(mp, actorId, FULL_HEALTH);                        // skip the recovery system
  safeSet(mp, actorId, 'private.injured', false);
  // Full-health outcome: don't leave the 1-HP wake armed for the engine.
  safeSet(mp, actorId, 'respawnPercentages', { health: FULL_HEALTH, magicka: 1, stamina: 1 });
  // NO-RETURN SYSTEM DISABLED: clear any zone armed by an older build so
  // nobody stays locked, and never arm a new one. Kept for a future rework.
  safeSet(mp, actorId, 'private.noReturnUntilMs', 0);
  // if (zoneWouldTrapTemple(temple, deathWorld, deathPos)) {
  //   // The zone would cover the respawn temple: skip it (and clear any older
  //   // one) or the tick would teleport the player back every 30s for an hour.
  //   safeSet(mp, actorId, 'private.noReturnUntilMs', 0);
  //   console.log('[respawn] ' + actorId.toString(16) + ' chose Temple w/ Full Health -> ' + temple.name + ' (death spot at the temple, no-return skipped)');
  // } else {
  //   // Can't return to the death spot for an hour. Enforcement stays dormant
  //   // until the player is first seen outside the zone (see tick).
  //   safeSet(mp, actorId, 'private.noReturnPos', Array.isArray(deathPos) ? deathPos : [0, 0, 0]);
  //   safeSet(mp, actorId, 'private.noReturnWorld', typeof deathWorld === 'string' ? deathWorld : '');
  //   safeSet(mp, actorId, 'private.noReturnUntilMs', Date.now() + NO_RETURN_MS);
  //   safeSet(mp, actorId, 'private.noReturnSeenOutside', false);
  //   console.log('[respawn] ' + actorId.toString(16) + ' chose Temple w/ Full Health -> ' + temple.name + ' (no-return 1h)');
  // }
  console.log('[respawn] ' + actorId.toString(16) + ' chose Temple w/ Full Health -> ' + temple.name);
  hideDeathScreen(mp, actorId);
}

// ── Periodic tick: slow recovery (no-return enforcement disabled) ─────────────
// Granularity note: everything below runs every TICK_MS (30s). The injured
// health clamp lets client-side natural regen creep up for at most 30s before
// being pulled back down.
function tick(mp: any, store: any): void {
  const now = Date.now();
  for (const p of store.getAll()) {
    const actorId = p.actorId;
    if (!actorId) continue;

    // Slow recovery (offline-aware: based on the persisted timestamp).
    // private.injuredHealth is the authoritative recovery curve. The engine's
    // respawn message tells the client "full health" and natural-regen
    // cropping accepts the client's increases, so live server health drifts
    // back to full within minutes — pin it to the curve instead (preserving
    // the player's current magicka/stamina; the old code force-filled both).
    if (safeGet(mp, actorId, 'private.injured', false) === true) {
      const last = safeGet(mp, actorId, 'private.regenLastMs', now);
      const rate = safeGet(mp, actorId, 'private.regenRate', REGEN_NATURAL);
      let ceiling = safeGet(mp, actorId, 'private.injuredHealth', WAKE_HEALTH);
      const intervals = Math.floor((now - last) / REGEN_INTERVAL_MS);
      if (intervals > 0) {
        ceiling = Math.min(FULL_HEALTH, ceiling + intervals * rate);
        safeSet(mp, actorId, 'private.injuredHealth', ceiling);
        safeSet(mp, actorId, 'private.regenLastMs', last + intervals * REGEN_INTERVAL_MS);
      }
      if (ceiling >= FULL_HEALTH) {
        safeSet(mp, actorId, 'private.injured', false);
        safeSet(mp, actorId, 'respawnPercentages', { health: FULL_HEALTH, magicka: 1, stamina: 1 });
      } else {
        const cur = safeGet(mp, actorId, 'percentages', null) as any;
        const curHealth = cur && typeof cur.health === 'number' ? cur.health : ceiling;
        if (Math.abs(curHealth - ceiling) > HEALTH_EPSILON) {
          setHealthPreserving(mp, actorId, ceiling);
        }
      }
    }

    // NO-RETURN SYSTEM DISABLED: enforcement commented out, kept for a future
    // rework. Any zone persisted by an older build is cleared so nobody stays
    // locked out of the area they died in.
    const until = safeGet(mp, actorId, 'private.noReturnUntilMs', 0);
    if (until) {
      safeSet(mp, actorId, 'private.noReturnUntilMs', 0);
    }
    // No-return zone after a "temple w/ full health" choice. Compared by the
    // full worldOrCell desc: enforcement applies only while the player is in
    // the SAME cell-or-worldspace as the death (X/Y from different spaces
    // don't compare, and there is no cell→parent-world mapping in the
    // gamemode API — re-entering via a different interior cell is a known
    // gap). Checked every 30s tick; see the granularity note above.
    // Dormant until the player is first seen OUTSIDE the zone: the respawn
    // itself can land in the zone (death near the temple), and bouncing a
    // player who never left is the infinite-teleport bug, not enforcement.
    // if (until && now < until) {
    //   const zone = safeGet(mp, actorId, 'private.noReturnPos', null);
    //   const zoneWorld = safeGet(mp, actorId, 'private.noReturnWorld', '');
    //   const pos = safeGet(mp, actorId, 'pos', null);
    //   const world = safeGet(mp, actorId, 'worldOrCellDesc', '');
    //   if (Array.isArray(zone) && Array.isArray(pos)) {
    //     const dx = zone[0] - pos[0], dy = zone[1] - pos[1];
    //     const inZone = world === zoneWorld && Math.sqrt(dx * dx + dy * dy) < NO_RETURN_RADIUS;
    //     if (!inZone) {
    //       if (safeGet(mp, actorId, 'private.noReturnSeenOutside', false) !== true) {
    //         safeSet(mp, actorId, 'private.noReturnSeenOutside', true);
    //       }
    //     } else if (safeGet(mp, actorId, 'private.noReturnSeenOutside', false) === true) {
    //       const temple = pickTemple(zoneWorld, zone);
    //       safeSet(mp, actorId, 'locationalData', temple.dest);
    //       send(mp, actorId, { customPacketType: 'notification', text: 'You cannot return here yet.' });
    //     }
    //   }
    // } else if (until) {
    //   safeSet(mp, actorId, 'private.noReturnUntilMs', 0);
    // }
  }
}

// Call when a healer tends a downed/injured player to bump recovery to 5/8h.
// Wired below to the bus 'playerRisen' event (combat.risePlayer — currently
// the only "someone tended this player" signal in the gamemode).
// TODO: a dedicated healer/medic interaction should call this directly once
// one exists; there is no heal/spell event on the bus today.
export function applyHealerBoost(mp: any, actorId: number): void {
  safeSet(mp, actorId, 'private.regenRate', REGEN_HEALER);
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function init(mp: any, store: any, bus: any): void {
  console.log('[respawn] Initializing');

  mp.onDeath = (dyingActorId: number, killerId: number) => {
    try { onPlayerDeath(mp, store, dyingActorId, killerId || 0); }
    catch (err: any) { console.error('[respawn] onDeath error: ' + (err && err.message)); }
  };
  // The handler's return value matters: `false` blocks the engine respawn
  // (permadeath); anything else lets it proceed.
  mp.onRespawn = (actorId: number): boolean | void => {
    try { return onPlayerRespawn(mp, store, actorId); }
    catch (err: any) { console.error('[respawn] onRespawn error: ' + (err && err.message)); }
  };

  // Death-screen button choices come back as a custom packet (validated in
  // onDeathChoice — the sender must be dead with an unconsumed choice window).
  mp.on('customPacket', (userId: number, content: string) => {
    let c: any; try { c = JSON.parse(content); } catch (e) { return; }
    if (c && c.customPacketType === 'deathChoice') {
      try { onDeathChoice(mp, store, userId, String(c.choice)); }
      catch (err: any) { console.error('[respawn] deathChoice error: ' + (err && err.message)); }
    }
  });

  // A downed player being tended back up (combat.risePlayer → 'playerRisen')
  // accelerates an injured player's recovery — the closest thing the gamemode
  // has to a healer interaction today (see applyHealerBoost's TODO).
  if (bus && typeof bus.on === 'function') {
    bus.on('playerRisen', (e: any) => {
      try {
        const player = store.get ? store.get(e.playerId) : null;
        const actorId = player && player.actorId;
        if (actorId && safeGet(mp, actorId, 'private.injured', false) === true) {
          applyHealerBoost(mp, actorId);
          console.log('[respawn] ' + actorId.toString(16) + ' was tended — recovery boosted to healer rate');
        }
      } catch (err: any) { console.error('[respawn] playerRisen error: ' + (err && err.message)); }
    });
  }

  const loop = () => { setTimeout(() => { try { tick(mp, store); } catch (e) { /* keep ticking */ } loop(); }, TICK_MS); };
  loop();

  console.log('[respawn] Started');
}
