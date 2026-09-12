# Companions (summons, reanimated corpses, pets)

A companion is an NPC ally owned by one player. The server keeps the list; the owner's game runs the AI.

- **Server:** `skymp5-server/ts/systems/companionSystem.ts` (`CompanionSystem`, created in `ts/index.ts`).
- **Owner's client:** `skymp5-client/src/services/services/companionService.ts`.
- **Magic that uses it:** `skymp5-server/ts/systems/conjurationSystem.ts` (Conjure spells, Reanimate, Banish).

## How it works

- A companion is a normal server actor, placed the same way as zone NPCs (`npcPlacement.ts`).
- Only its owner may host it. The server refuses every other host attempt through the `onHostAttempt` gamemode event (`ActionListener.cpp`). So the owner's engine drives it, and everyone else sees it through the owner's movement and animation stream.
- The owner's client makes it a teammate in the player faction, keeps it following the player, and starts combat with the target the server recorded.
- Its hits go to the server like any hosted NPC's hits, and the server computes the damage. A companion never damages its owner or the owner's other companions (`onHitDamageAttempt`).
- **Ordering an attack:** when the owner hits a living actor with a weapon or a hostile spell, the client sends `companionCommand` / `attack`. The server checks ownership and range (4096 units, same cell), then records the target.
- **Defending the owner:** when anyone damages the owner, every companion of that owner targets the attacker. A companion that is already fighting switches target at most once every 3 s.
- **Following across cells:** if the owner changes cell or gets more than 4096 units away, the companion is moved behind them.

## API (call on the `CompanionSystem` instance)

| Call | What it does |
|---|---|
| `spawn(ownerId, baseId, opts)` | Places a companion of an NPC_ base near the owner. Returns its actor id, or `null`. |
| `dismiss(companionId, reason?)` | Ends it now. |
| `orderAttack(companionId, targetId)` | Fights that actor. Returns false if the target is invalid or out of range. |
| `orderFollow(companionId)` | Drops the target and goes back to following. |
| `defend(ownerId, aggressorId)` | Every companion of the owner targets the aggressor. Already runs on every damaging hit on an owner. |
| `list(ownerId)` / `info(companionId)` | `{ id, ownerId, baseId, kind, targetId, expiresAt, persistent, source }` |

`opts` fields:

- `kind`: `"summon"`, `"reanimated"` or `"companion"` (the default).
- `pos`, `rot`: where it stands. The default is 160 units in front of the owner.
- `durationSec`: when it ends on its own. 0 or omitted means it lasts until dismissed or killed.
- `persistent`: see below.
- `source`: the spell or form that created it, used in logs.

Example, a dog that stays with its owner:

```ts
companionSystem.spawn(ownerActorId, 0x00023a92, { kind: "companion", persistent: true });
```

## Kinds

| Kind | Counts toward the command limit | Expiry or dismissal | On death |
|---|---|---|---|
| `summon` | yes | vanishes | inventory emptied, body removed after 3 s |
| `reanimated` | yes | dies again, body lootable for 120 s | body lootable for 120 s |
| `companion` | no | vanishes | body lootable for 120 s |

**Command limit:** the vanilla limit is one commanded actor per player, two with the Twin Souls perk (0xD5F1C), which the client reports. The newest one replaces the oldest.

Commanded companions (`summon`, `reanimated`) also end when the owner dies.

## Lifetime

- **Owner logs out** (or switches character and is gone for 5 s):
  - non-persistent companions end;
  - persistent ones are stored and placed again at the owner's next login.
- **Server restart:** every companion from the previous run is removed at boot. Persistent ones are placed again at the owner's next login. Summons never persist.
- The registry is `companions.json` in the server folder. The server writes it; do not edit it by hand.

## Protocol (MsgType.CustomPacket JSON)

| Direction | Packet |
|---|---|
| server -> owner | `{ customPacketType: "companionState", companions: [{ id, target, kind }] }`, sent on every change and at login |
| owner -> server | `{ customPacketType: "companionCommand", action: "attack", targetId, companionId? }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "follow", companionId? }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "dismiss", companionId }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "perks", twinSouls }` |

If `companionId` is left out, the command applies to all of the owner's companions.
