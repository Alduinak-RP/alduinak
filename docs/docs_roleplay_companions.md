# Companions (summons, reanimated corpses)

A companion is an NPC ally owned by one player. The server keeps the list; the owner's game runs the AI. Horses, livestock and dogs are pets, a separate system (`docs_roleplay_pets.md`) whose X menu also reaches a companion (Pet, Unsummon) and whose E hands it the vanilla command mode.

- **Server:** `skymp5-server/ts/systems/companionSystem.ts` (`CompanionSystem`, created in `ts/index.ts`).
- **Owner's client:** `skymp5-client/src/services/services/companionService.ts`.
- **Magic that uses it:** `skymp5-server/ts/systems/conjurationSystem.ts` (Conjure spells, Reanimate, Banish).

## How it works

- A companion is a normal server actor, placed the same way as zone NPCs (`npcPlacement.ts`).
- Only its owner may host it. The server refuses every other host attempt through the `onHostAttempt` gamemode event (`ActionListener.cpp`) and assigns the owner as host the moment the companion spawns (`HostingSystem`, see `docs_roleplay_npc_spawns.md`), instead of waiting for the owner's client to notice it after 1.5 s. So the owner's engine drives it, and everyone else sees it through the owner's movement and animation stream.
- The owner's client makes it a teammate in the player faction (favors allowed, for the vanilla command mode), sets Assistance to help allies and Confidence to foolhardy so it joins the owner's fights and never flees, keeps it following the player (it runs once more than 256 units behind), and starts combat with the target the server recorded.
- **Following:** the keep-offset holds the heading toward the follow point, 128 units behind the owner, so the follower turns and walks forward instead of reversing; within 128 units of that point it settles facing the owner's way. The call is re-issued whenever that heading turns by more than 20 degrees and at least every 2 s, because a respawn and the first movement apply of a new local copy both reset it. It stands aside while the copy fights on its own or is in the vanilla favor state.
- Its hits go to the server like any hosted NPC's hits, and the server computes the damage. A companion never damages its owner or the owner's other companions (`onHitDamageAttempt`).
- **Activations:** the owner's client sends a companion's activations with the companion as caster, and the server accepts them because the owner hosts it. The server lets a companion open doors only and refuses everything else (`onActivate`): a picked-up item would land in the companion's server inventory, which nobody can take from and which is destroyed with the companion, and a container it opened would stay occupied by it and closed to players nearby. So a command-mode "take this" or "open that" does nothing on the server.
- **Ordering an attack:** when the owner hits a living actor with a weapon or a hostile spell, the client sends `companionCommand` / `attack`. The server checks ownership and range (4096 units, same cell), then records the target. Command mode sends the same packet with a `companionId`, so only the commanded one goes (`docs_roleplay_pets.md`).
- **Defending the owner:** when anyone damages the owner, or any pet or companion of theirs, every companion and ally of that owner targets the attacker. One that is already fighting switches target at most once every 3 s. Nothing of the owner's is ever a valid target, and nothing of theirs can damage anything else of theirs.
- **Following across cells:** if the owner changes cell or gets more than 4096 units away, the companion is moved behind them.

## Allies (pets that fight)

A pet has its own lifecycle and lives in `PetSystem`, so it is not a companion. It still fights through this system's targeting instead of a second copy of it.

- `PetSystem` hands over two callbacks (`setAllySource`, wired in `ts/index.ts`): the pets that may fight right now (out dogs that are alive and not carried, ridden or fleeing) and the owner of any pet in the world. Both are called live, never cached, so a dog that is picked up or stored stops being a fighter in the same instant.
- Allies share `defend`, the `companionCommand` handler, `orderAttack`, `orderFollow`, the 3 s retarget limit and the 6144-unit keep range. An ally's target is dropped when the target dies, leaves the range or the ally stops being offered, so a stored dog never resumes an old fight.
- The owner of *any* pet, not only a fighting one, is resolved for the target rule, so an owner who hits their own horse does not send the dog after it.
- Allies are sent in their own array, never in `companions`: the client's own-companion list, its NPC hostility and the world cleaner's burst all key on that one.

## API (call on the `CompanionSystem` instance)

| Call | What it does |
|---|---|
| `spawn(ownerId, baseId, opts)` | Places a companion of an NPC_ base near the owner. Returns its actor id, or `null`. |
| `dismiss(companionId, reason?)` | Ends it now. |
| `orderAttack(fighterId, targetId)` | That companion or ally fights that actor. Returns false if the target is invalid or out of range. |
| `orderFollow(fighterId)` | Drops the target and goes back to following. |
| `defend(ownerId, aggressorId)` | Every companion and ally of the owner targets the aggressor. Already runs on every damaging hit on an owner or on one of their pets. |
| `setAllySource(fighters, ownerOf)` | Registers the pets that may fight and the owner lookup for every pet. See Allies. |
| `list(ownerId)` / `info(companionId)` | `{ id, ownerId, baseId, kind, targetId, expiresAt, persistent, source }` |

Do not call `spawn` or `dismiss` synchronously inside a native gamemode event about the same actor (`mp.onSpellHit`, `mp.onHitDamageAttempt` and the like). The C++ caller keeps using that actor after the handler returns, so destroying it there crashes the server. Defer the call with `setImmediate`, as `conjurationSystem.ts` does.

`opts` fields:

- `kind`: `"summon"`, `"reanimated"` or `"companion"` (the default).
- `pos`, `rot`: where it stands. The default is 160 units in front of the owner.
- `durationSec`: when it ends on its own. 0 or omitted means it lasts until dismissed or killed.
- `persistent`: see below.
- `source`: the spell or form that created it, used in logs.
- `ashPile`: when it ends or dies, it turns to a lootable ash pile holding its items instead of leaving a body (see Kinds).

Example, a pet that stays with its owner (`petBaseId` is the global form id of an NPC_ record):

```ts
companionSystem.spawn(ownerActorId, petBaseId, { kind: "companion", persistent: true });
```

## Kinds

| Kind | Counts toward the command limit | Expiry or dismissal | On death |
|---|---|---|---|
| `summon` | yes | vanishes | inventory emptied, body removed after 3 s |
| `reanimated` | yes | dies again, body lootable for 5 minutes | body lootable for 5 minutes |
| `companion` | no | vanishes | body lootable for 120 s |

**Ash piles (`ashPile`):** the body lies for 1.25 s (the vanilla delay), then it is replaced by an ash pile container at the same spot.

- Every item of the body moves into the pile: worn flags are dropped and equal stacks merged, nothing is copied. The body is emptied and removed for everyone.
- The pile is looted like any container, through the server-authorized container window. Its own base items are never added.
- It lasts 5 minutes, like an NPC corpse, then it is removed for everyone.
- The base is `defaultGhostCorpse` (`c674b:Skyrim.esm`), the vanilla ash pile container. The optional `reanimateAshPileBase` setting (a form desc or a load-order id of a `CONT` record) replaces it.
- If no pile can be placed (a wrong base, a failed PlaceAtMe), the body simply stays for 5 minutes.

The 5 minutes for reanimated bodies and ash piles follow the optional `npcCorpseSeconds` setting (default 300), the same one zone NPC corpses use.

**Command limit:** the vanilla limit is one commanded actor per player, two with the Twin Souls perk (0xD5F1C), which the client reports. The newest one replaces the oldest.

Commanded companions (`summon`, `reanimated`) also end when the owner dies.

## Conjuration (conjurationSystem.ts)

The C++ server fires `onSpellCast(caster, spell)` and `onSpellHit(aggressor, target, spell)` for accepted casts and hits. A paralysed caster's cast fires no `onSpellCast`. A hit refused by `onHitDamageAttempt` (God Mode, a companion hitting its owner) or blocked by a ward fires no `onSpellHit`. Only player casters are handled.

- **Summons:** a spell whose effect is the SummonCreature archetype places a `summon` of the effect's associated NPC_. This covers the Conjure Atronach spells, Familiar, Dremora Lord, Ash Spawn and the Flame/Frost/Storm Thralls.
  - It appears 160 units in front of the caster and lasts the effect duration.
  - A duration of 10,000,000 s or more (the Thralls) lasts until the summon is killed or replaced.
  - The first summon effect is used. Perk-conditioned variants (Elemental Potency) and duration perks are not evaluated.
- **Reanimate:** Reanimate Corpse, Revenant, Dread Zombie and Dead Thrall raise a dead NPC as a `reanimated` companion.
  - The corpse must be within 4096 units and must not be a player body or a companion.
  - Only server-placed corpses (ids FF......, such as zone NPCs) can rise. A plugin-placed actor cannot be destroyed, because the world would load it again with its items.
  - Its level must be at most the effect magnitude.
  - It must pass the effect's HasKeyword conditions: no MagicNoReanimate, and ActorTypeNPC for Dead Thrall.
  - A new actor of the corpse's base takes its place and inventory, and the corpse is removed.
  - Reanimate Corpse, Revenant and Dread Zombie carry the vanilla `ReanimateAshPile` script effect, so their zombie turns to an ash pile when the spell ends or it is killed. Dead Thrall has no such effect and leaves a body, as in vanilla.
  - The target is the corpse the spell hit. If no hit arrives within 1.5 s, the nearest valid corpse within 20 degrees in front of the caster (up to 2048 units) is used.
- **Banish:** a Banish effect on a `summon` that passes its conditions (ActorTypeDaedra) and whose level is within the magnitude dismisses it.

## Lifetime

- **Owner logs out** (or switches character and is gone for 5 s):
  - non-persistent companions end;
  - persistent ones are stored and placed again at the owner's next login.
- **Server restart:** every companion from the previous run, with their bodies and ash piles, is removed at boot, right after the world DB has loaded (the `worldLoaded` event on `ctx.gm`). Persistent ones are placed again at the owner's next login. Summons never persist.
- The registry is `companions.json` in the server folder. The server writes it; do not edit it by hand.

## Protocol (MsgType.CustomPacket JSON)

| Direction | Packet |
|---|---|
| server -> owner | `{ customPacketType: "companionState", companions: [{ id, target, kind }], allies: [{ id, target }] }`, sent on every change and at login; every packet carries both arrays in full, because the client replaces its state from each one |
| owner -> server | `{ customPacketType: "companionCommand", action: "attack", targetId, companionId? }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "follow", companionId? }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "dismiss", companionId }` |
| owner -> server | `{ customPacketType: "companionCommand", action: "perks", twinSouls }` |

If `companionId` is left out, the command applies to all of the owner's companions.
