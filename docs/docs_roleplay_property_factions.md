# Roleplay Property & Factions — Houses, Locks, Holds

This covers:

- **4. House claiming** — players claim the door to an interior cell.
- **5. Locks** — owners lock/unlock doors and containers inside cells they own.
- **6. Factions** — Jarls of a hold automatically own the houses in their hold;
  guards of a hold may arrest others.

As before, the **client** ships the interaction UI in this repo and the
**gamemode** owns all policy and persistence. None of this needs an ESP.

Client piece: `skymp5-client/src/services/services/housingService.ts`.

---

## 4 & 5. Claim / abandon / lock / unlock

### Client behaviour (implemented)

Looking at a door or container, the player presses the **housing key** (default
`H`, configurable — see below) to open a small menu:

> **Manage: \<target name\>** — claim · abandon · lock · unlock · transfer · cancel

The service resolves the targeted reference to its **server-format form id** and
sends the chosen action. It never opens for a person (actors are skipped) and is
inert until the key is pressed.

```json
{ "customPacketType": "propertyRequest",
  "action": "claim" | "abandon" | "lock" | "unlock" | "transfer",
  "target": 134669556 }
```

**Transfer** is a two-step flow: choosing *transfer* closes the menu and prompts
"Look at the new owner and press the housing key". The next key press, while the
crosshair is on a player, sends the same packet with the recipient added (its
server-format form id — resolve with `mp.getUserByActor`):

```json
{ "customPacketType": "propertyRequest", "action": "transfer",
  "target": 134669556, "recipient": 4278190101 }
```

The gamemode replies with feedback shown as a corner notification:

```json
{ "customPacketType": "propertyNotice", "text": "You now own this house." }
```

#### Configuration

In `server-settings.json` under the client settings (or the client's
`skymp5-client` settings block), optional keys:

- `housingMenuKeyCode` — DirectInput scan code for the housing key (default is
  `H`).
- `language` — `"en"` / `"ru"` for the menu labels.

### Gamemode TODO

The `target` is a form id you can resolve with `mp.getDescFromId(target)` /
`mp.lookupEspmRecordById(target)`. Handle `propertyRequest` in your
`mp.on("customPacket", ...)` handler:

1. **Identify the property.** For a door, find the **interior cell** it leads to
   (the house). For a container, find the cell it sits in. Treat the cell as the
   unit of ownership; the door is the claim handle.
2. **claim** — if the cell is unowned (or the requester is a Jarl/admin with
   override), set the owner to the requesting player and persist it. Reject with
   a `propertyNotice` if it's already owned by someone else.
   - Persist e.g. `mp.set(cellOrDoorId, "private.owner", profileId)`. Consider an
     indexed property (`private.indexed.ownerProfileId`) so you can look up a
     player's houses with `mp.findFormsByPropertyValue(...)`.
3. **abandon** — only the owner (or a Jarl/admin) may release ownership; clear
   the owner and any locks.
4. **lock / unlock** — only the owner (or a Jarl/guard/admin per your rules) may
   toggle the lock. Persist the locked state (e.g. `private.locked`) on the door
   or container.
5. **transfer** — only the owner (or a Jarl/admin) may transfer. Map the
   `recipient` form id to a profile (`mp.getUserByActor(recipient)` → userId →
   `mp.get(actor, "profileId")`) and set that as the new owner. Reject if the
   requester isn't the owner or the recipient isn't a valid player.
6. **Enforce locks server-side.** This is the important half: in your door/
   container **activation** handling (the existing `DoorActivation` /
   activation path), if the target is locked and the activator isn't an owner
   (or doesn't hold a key/faction override), **block the activation** and send a
   `propertyNotice` ("This door is locked."). The client lock menu is only UX;
   security must be server-side.
7. Always reply with a `propertyNotice` so the player gets feedback.

Ownership and lock state should be **persistent** (survive restarts) and
re-evaluated on activation, not cached on the client.

---

## 6. Factions — Jarls and guards

**Model: fixed holds.** There are the nine vanilla holds; each has a Jarl and
guards, and membership/rank is hold-based. Factions are membership data the
gamemode owns. `MpActor` exposes a faction API server-side (`AddToFaction` /
`IsInFaction` / `GetFactions` / `RemoveFromFaction`), but the simplest approach
is persisted properties on the player's actor, e.g. `private.hold` (hold name)
and `private.holdRank` (`"citizen" | "guard" | "steward" | "jarl"`), plus your
own **hold → Jarl** table so you can resolve who rules each hold.

Most faction policy is server-side, but there is now an **in-game management
UI** (see below) that Jarls/leaders use to edit their hold's roster.

### Jarl auto-claim

- Maintain a **hold → houses** mapping (which interior cells belong to which
  hold) and a **player → faction/rank** mapping (who is the Jarl of each hold).
- When a player becomes (or logs in as) the **Jarl** of a hold, treat them as
  the owner of every house in that hold for claim/lock/key purposes — either by
  assigning ownership or by special-casing Jarl in the ownership checks in §4/§5.
- When they stop being Jarl, drop the automatic ownership (but keep any houses
  they personally claimed as a citizen, if you want that distinction).

### Guards and arrest

Guards of a hold may **arrest** others. This reuses the survival-loop arrest:

- When a guard binds a subdued/bleeding-out target, validate server-side that
  the binder is a **guard of the relevant hold** (or an admin) before applying.
- Apply the bind by sending the victim's client the restraint packet from the
  survival-loop doc:

  ```json
  { "customPacketType": "restraintState", "boundHands": true }
  ```

See [Survival Loop](docs_roleplay_survival_loop.md) for the full arrest/carry
flow; this section only adds the **permission** check (guard-of-hold) on top.

### Hold management (in-game UI)

Client piece: `skymp5-client/src/services/services/factionService.ts`. The
player presses the **faction key** (default `G`, set via `factionMenuKeyCode`)
to request their hold roster. The server validates the player may manage a hold
and replies with the member list; the menu offers add / remove / promote /
demote per member.

```json
// Client -> Server: open my roster
{ "customPacketType": "factionMenuRequest" }

// Server -> Client: the roster (only sent if the player may manage a hold)
{ "customPacketType": "factionMenu", "title": "Whiterun Hold",
  "members": [ { "name": "Lydia", "profileId": 7, "rank": "guard" } ] }

// Client -> Server: a management action
{ "customPacketType": "factionRequest", "action": "add",     "recipient": 4278190101 }
{ "customPacketType": "factionRequest", "action": "remove",  "profileId": 7 }
{ "customPacketType": "factionRequest", "action": "promote", "profileId": 7 }
{ "customPacketType": "factionRequest", "action": "demote",  "profileId": 7 }

// Server -> Client: feedback
{ "customPacketType": "factionNotice", "text": "Lydia is now a guard." }
```

**Gamemode TODO:**
1. On `factionMenuRequest`, check the requester is a Jarl/steward of a hold; if
   not, reply with a `factionNotice` ("You don't lead a hold.") and send no menu.
2. On `factionRequest`:
   - `add` — resolve `recipient` (`mp.getUserByActor` → profileId) and set that
     player's `private.hold`/`private.holdRank` (default `citizen`).
   - `remove` — clear the target profile's hold membership.
   - `promote` / `demote` — step the target's rank up/down through your rank
     ladder (e.g. citizen → guard → steward).
   - Validate every action server-side against the requester's authority and the
     fixed-holds rules; never trust the client's `profileId`.
3. After any change, **re-send `factionMenu`** so the open menu refreshes, and a
   `factionNotice` for feedback.

---

## Message reference (quick)

| Packet (`customPacketType`) | Direction | Purpose |
| --- | --- | --- |
| `propertyRequest` `{ action, target, recipient? }` | Client → Server | Claim/abandon/lock/unlock/transfer the targeted door/container |
| `propertyNotice` `{ text }` | Server → Client | Housing feedback notification |
| `factionMenuRequest` `{}` | Client → Server | Ask for the player's hold roster |
| `factionMenu` `{ title, members }` | Server → Client | Render the hold-management menu |
| `factionRequest` `{ action, profileId? / recipient? }` | Client → Server | add/remove/promote/demote a member |
| `factionNotice` `{ text }` | Server → Client | Faction feedback notification |
| `restraintState` `{ boundHands }` | Server → victim client | Apply arrest (guard permission checked server-side) |

All ownership, lock enforcement, faction membership, Jarl auto-claim and guard
permissions are **server-authoritative**; the client only sends requests and
shows the resulting notices.
