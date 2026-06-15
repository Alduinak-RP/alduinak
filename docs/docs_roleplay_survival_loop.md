# Roleplay Survival Loop — Bleedout, Arrest & Carry

This covers the interlinked "survival loop" features:

- **8. Respawn / bleedout** — on lethal damage a player drops into bleedout for
  ~1 minute, can be healed by others, otherwise is sent to the nearest temple
  at 1 HP.
- **9. Arrest** — binding the hands of a player who is in bleedout.
- **10. Carry** — picking up a consenting player, or a player in bleedout, which
  also pauses their respawn timer.

As with the other roleplay features, the **client** pieces ship in this repo
and the **server** orchestration lives in the gamemode. Client pieces here:

- `skymp5-client/src/services/services/restraintService.ts` — local-player
  restraint (bound hands + carried) via the `restraintState` CustomPacket.
- `skymp5-client/src/sync/animation.ts` — `forcedSyncAnims` now also syncs the
  bound-hands offset pose to other clients (it already synced the carry pose).
- Existing `deathService.ts` — already downs/revives the local player when the
  server toggles its death state. Bleedout reuses this; **no new code needed**.

All offset poses used here (`OffsetCarryBasketStart`, `OffsetBoundStandingStart`,
`OffsetStop`) are **vanilla Skyrim behaviour-graph events — no ESP required.**

---

## 8. Respawn / bleedout

### How the client already behaves

The client's `DeathService` reacts to the server's death-state for an actor
(`applyDeathStateEvent` / the `DeathStateContainer` message path):

- death-state **on**  → the local player is downed: ragdolled, `setDontMove`,
  animations locked. They stay down and can't act.
- death-state **off** → the player is revived (get-up animation, controls
  restored).

So "bleedout" is the downed state held open by the server, and "healed" is the
server clearing it. The client needs no changes for this.

### Gamemode TODO (the orchestration)

On lethal damage, instead of a normal kill:

1. **Enter bleedout** — put the actor into the downed death-state and record a
   bleedout deadline (`now + 60s`). Do **not** respawn yet.
2. **Allow healing** — while downed, if another player heals the victim (a
   restoration spell/healing hand on them, or a `/heal`-style interaction you
   define), clear the death-state to revive them and cancel the deadline.
   - Suggested contract for a heal action: the healer's client already syncs
     restoration spell casts (`SpellCastMessage` / magic sync). Detect a
     healing effect targeting a downed player server-side and revive.
3. **Timeout** — when the deadline passes and they were not healed or carried
   (see §10), teleport the actor to the **nearest temple**, set health to 1, and
   clear the death-state. Use your `startPoints`/temple table for the nearest
   temple per hold (Kynareth–Whiterun, Mara–Riften, Talos–Windhelm, etc.).
4. **Persistence** — keep the bleedout deadline server-side; never trust the
   client for timing.

Recommended temple anchors (fill in real cell/pos in `server-settings.json`):
Whiterun (Kynareth), Riften (Mara), Windhelm (Talos), Solitude (the Divines),
Markarth (Dibella), Morthal, Dawnstar, Falkreath.

---

## 9. Arrest — bind hands

A player may bind the hands of a victim **who is in bleedout** (feature 9).
Guards of a hold get this right via the factions system (feature 6).

### Client (implemented)

The gamemode sends, to the **victim's** client:

```json
{ "customPacketType": "restraintState", "boundHands": true }
```

`RestraintService` plays the bound-hands pose (`OffsetBoundStandingStart`) and
disables fighting/sneaking/activation, while leaving movement enabled so the
prisoner can be marched. To release:

```json
{ "customPacketType": "restraintState", "boundHands": false }
```

The pose is synced to nearby players via `forcedSyncAnims`, so everyone sees the
bound hands, not just the victim.

### Gamemode TODO

1. Validate the actor is **eligible** to be bound (in bleedout, or already
   subdued) — don't allow binding an upright, free player.
2. Validate the **binder's** permission: a guard of the hold (faction check,
   feature 6) or an admin. Reject otherwise.
3. Persist the bound state on the victim (e.g. `private.boundHands`) so it
   survives reconnects and is re-sent on login, and re-send `restraintState`
   when the victim respawns/gets up so the pose re-applies.
4. Gate hands-bound actions server-side too (can't equip/attack/loot) — the
   client lock is cosmetic/UX, not security.

---

## 10. Carry

A player can pick up either a **consenting** player or a player **in bleedout**.
Carrying also **pauses the victim's respawn timer**.

### Client (implemented + existing)

- **Carrier pose** — the gamemode's existing `CarryAnimSystem` drives the
  carry animation (`OffsetCarryBasketStart`) on the carrier; it already syncs.
- **Carried lock** — the gamemode sends, to the **carried** player's client:

  ```json
  { "customPacketType": "restraintState", "carried": true }
  ```

  `RestraintService` immobilises them (`setDontMove`, controls disabled) so the
  server can move the body, while leaving the camera free. Release with:

  ```json
  { "customPacketType": "restraintState", "carried": false }
  ```

`boundHands` and `carried` are independent flags and may be combined (a bound
prisoner can also be carried).

### Gamemode TODO

1. **Consent / eligibility** — allow carry only if the target is in bleedout
   **or** has consented (a prompt/`/carryaccept`-style flow you define).
2. **Move the body** — while carried, keep the victim positioned on/just behind
   the carrier each tick (server-side `moveTo`/position update, or a follow
   offset). Mark the carried actor so movement sync doesn't fight it.
3. **Pause respawn** — while carried, **suspend the bleedout deadline** from §8
   so a carried, bleeding-out player is not auto-sent to the temple. Resume (or
   reset) the timer when they're put down, unless they were healed.
4. **Put down / drop** — on release send `carried: false`; if still bleeding
   out, resume the timer; if at a temple/jail, hand off to that flow.

---

## Message reference (quick)

| Packet (`customPacketType`) | Direction | Purpose |
| --- | --- | --- |
| `restraintState` `{ boundHands?, carried? }` | Server → victim client | Apply bound-hands / carried state |
| *(death-state sync, existing)* | Server → clients | Bleedout down / revive |
| *(CarryAnimSystem, existing gamemode)* | Server → clients | Carrier pose |

All restraint/bleedout **rules, timers, permissions and persistence are
server-authoritative.** The client services only render the resulting state.
