# Damage calculation and hit handling

When a local hit event occurs, client sends an OnHit packet to server.

It contains the following fields:
```c++
uint32_t aggressor = 0; // originating actor
bool isBashAttack = false;
bool isHitBlocked = false;
bool isPowerAttack = false;
bool isSneakAttack = false;
uint32_t projectile = 0;
uint32_t source = 0; // formId of weapon (or of bare hands)
uint32_t target = 0; // target actor
```

## Damage formula

There is an interface
[`IDamageFormula`](https://github.com/skyrim-multiplayer/skymp/blob/main/skymp5-server/cpp/server_guest_lib/formulas/IDamageFormula.h),
which allows calculating damage based on aggressor and target actors, as well as hit data.

By default, vanilla Skyrim damage formula is used (althrough it's not fully
implemented yet, see below):
[`TES5DamageFormula`](https://github.com/skyrim-multiplayer/skymp/blob/main/skymp5-server/cpp/server_guest_lib/formulas/TES5DamageFormula.cpp).
But abstract formula will allow custom server implementations to easily redefine
formula by something else.

### Implemented formula components

At the moment, `TES5DamageFormula` is not complete enough and only takes basic
values into account. If you notice something missing, consider creating an
issue if it's not present yet. If you have C++ knowledge, we would be glad to
see your [contributions](https://github.com/skyrim-multiplayer/skymp/blob/main/CONTRIBUTING.md)!

Incoming damage:
```
incomingDamage = isUnarmed ? raceUnarmedDamage : baseWeaponDamage;
```
Claws are that race unarmed damage. The proficiency patcher copies it from a weapon record (`unarmedDamageFrom` in
spec.json `races.passives`): Khajiit claws hit like a Steel Dagger (7) and, from plugin r27a, Argonian claws like an
Iron Dagger (6); every other race keeps 4. Being a race value, claws are never tempered, never wear and carry no
poison, and NPCs of those races hit the same way. Under the rebalance formula (test release B) the claws take the
dagger's damage and hit rules instead, through `alduinakDamageFormulaSettings.unarmed.raceOverride` (the Steel dagger
row for Khajiit, the Iron one for Argonians, vampire races included), with the fist's timing. See
`docs_racial_passives.md`.

**Item records from plugin r28.** The plugin's stat pass writes the rebalance rows into the item records, so the item
cards show them: a weapon's damage is its row damage rounded (Iron Sword 15, Steel Dagger 11, Daedric Sword 22), an
armour's rating its piece DT x 10 (Iron Armor 45, Daedric Armor 90, clothing 0), the Orcish and Dwarven heavy pieces
weigh what their row says and a record slower than its row swings at the row speed. The rebalance formula never reads
these fields; `baseWeaponDamage` and the armour ratings of the TES5 formula above do, and the claw races copy the
synced daggers (Khajiit 11, Argonian 10). So plugin r28 and an enabled `alduinakDamageFormulaSettings` block belong
together: with r28 and the block absent or `enabled: false`, the TES5 formula prices hits from the synced numbers,
which are not the ones it was balanced on. The lists come from `misc/combat-settings/generate.py` and land through
`misc/proficiency-patcher/patch.py --stats` (see its README).

Armor damage reduction:
```
armorRating = armorRating1 + armorRating2 + armorRating3 + ... + armorRatingN + magicArmorRating;
//fMaxArmorRating is [GMST:00037DEB], fArmorScalingFactor is [GMST:00021A72];
//fMaxArmorRating = 80 by default, fArmorScalingFactor = 0.12 by default
//magicArmorRating is sum of magnitudes of armors' enchantments with magic effect of damage resist
receivedDamage = incomingDamage * 0.01 * (100 - std::min(armorRating * fArmorScalingFactor, fMaxArmorRating));
```

Spell damage:
```
// every hostile or detrimental Health effect of the SPEL whose conditions hold (shouts count every effect)
spellDamage = sum(magnitude * resistMult(effect's MGEF resist value));
// resistance = magnitudes of the target's ability spells (learned, NPC_ and race SPLO) modifying that actor value,
// detrimental ones (weaknesses) subtracted; capped at 85 like fPlayerMaxResistance
resistMult = 1 - min(resistance, 85) / 100;
```
So the racial resistances act on server spell damage straight from the plugin's race abilities: from plugin r27a
(`AldRacial_*`, `docs_racial_passives.md`) Nord frost 75, Dark Elf fire 75, the High Elf's weakness to fire, frost and
shock (x1.25), Argonian poison 75 and Redguard poison 50. Only the resist value the effect names applies: magic
resistance or armor rating abilities count for the few effects that name them (Vampiric Drain, some dragon and
Wabbajack effects).

Magic resistance on every other spell, the Breton's 50 and the Orc's 25, comes from two
`damageMultConditionalFormulaSettings` entries of the Test settings, `racialMagicResistBreton` (`magicDamageMultiplier`
0.5) and `racialMagicResistOrc` (0.75), each keyed on `GetIsRace` of the target with its vampire race (the JSON is
under `racialPassives` in the configuration reference). They multiply every server spell hit on such a target, not
poisons, on top of the element resistance, as vanilla stacks the two; an effect that names MagicResist itself counts
the Breton's resistance twice (accepted). Without them only the client engine applies the magic resistance, to
non-damage effects. `RacialSystem` lists them at boot (`[racial] magic damage entries: ...`) and warns about a race
whose ability resists magic with no entry. The native magic pass (plan task NV7) will replace both entries.

Weapon poison:
```
// the aggressor's inventory copy of the weapon that hit carries poisonId/poisonCount (put there when the poison was applied)
// every hostile or detrimental Health, Stamina or Magicka value modifier effect of the ALCH:
poisonDamage[av] = sum(magnitude * max(1, duration) * resistMult(effect's MGEF resist value));
// a dual value modifier effect (Frostbite Venom: Health and Stamina) adds the same burst times its second AV weight
// to the second value's bucket
poisonDamage[secondAV] += magnitude * max(1, duration) * resistMult * secondAVWeight;
```
The Health part joins the weapon damage, so `onHitDamageAttempt`, god mode and bleedout see one total, and a blocked
swing still delivers the whole poison, while a bash (shield, bow or power bash) neither poisons nor spends a use, as in
the engine. Stamina and Magicka drop separately on the target. A lingering poison lands as
one burst (magnitude times seconds) because the hit path has no per-victim timer. Damage Health and Damage Magicka
poisons name PoisonResist, so the racial poison resistance cuts them (Argonian 75 and Redguard 50 from plugin r27a;
r22's Bosmer 25 is gone); the vanilla Damage Stamina poisons name no
resist value and land in full. Paralysis, rate drains (Damage Stamina Rate), weaknesses (PeakValueMod) and influence
effects, dual effects whose two values are neither Health, Stamina nor Magicka, and any effect whose conditions fail,
are only counted in the log line (`OnWeaponHit - <aggressor> poisons
<target> with <alch>: ... effects ignored`). Applying a poison puts one use on the server's copy of the worn weapon at
once; with Concentrated Poison the engine puts two, and the client's report within 15 s raises the copy to two on the
same credit (`poison up to 2 (perk)` in the crafted log).
Each landed hit spends one use of the poison on the server's copy and sends the attacker a SetInventory, which their
engine already matches because it spent the same charge; a hit refused by the attack speed check or the gamemode leaves
the charge, and the client's later crafted-extras report reconciles it. Copies of other players never carry the
poison extra on the client, so the victim's own engine cannot apply it a second time.

Creature hit spells are not weapon poisons. The Falmer poison is the perk `crFalmerPoison01-05` (Dawnguard adds
`DLC1crFalmerPoison06`) whose "Apply Combat Hit Spell" entry casts `crFalmerPoisonedWeapon0x` (SPEL type Poison,
delivery Contact, one Health effect resisted by PoisonResist); spider and chaurus bites, the giant club slam, the
spriggan claw and the atronach and death hound melee spells are race attack spells of the same delivery. All of them
are applied by the victim's own engine when the copy's swing connects: the perk hit spell raises no hit event the
client relays, and the race attack spells the client does send are refused by `CanHitWithSpell` (the NPC neither
holds nor learned them), so the server never sees them and its raised-shield rule cannot zero them. The client's
`NpcHitSpellBlockService` therefore dispels a Contact-delivery poison hit spell from an NPC aggressor when the paired
weapon hit (within 250 ms, in either order) counts as blocked by the server's own rule: the engine flagged it blocked,
or the player held a block with the aggressor within 1 rad of their facing (with a shield against arrows and bolts),
which the server resolves as blocked whatever the engine decided (see Blocked hits below: an NPC's blocked hit lets
`npcBlockedDamageShare` of its blade through, never its poison). Only a hit that is neither keeps the poison, and when no weapon
hit pairs with the spell the pose alone decides. The Falmer poison is known by its effect, `crFalmerFFContact`
(0x109D7C), and a landing is seen through `magicEffectApply`, `effectStart` (the effect is listed on the player by
then) and the spell's own hit event, whichever come; the dispel looks again one frame later and dispels once more
when the effect is still on the player. On top of that the server tells the victim's client about every swing of a
poison perk NPC it resolves as blocked (custom packet `npcHitPoisonBlocked` with the NPC's id), and that verdict
dispels the poison of that NPC's landing within the last 3 s even when the client's own verdict kept it; with no
landing seen, a Falmer poison still on the player is dispelled too. `dispelSpell` removes every caster's copy of a
spell, so a dispel goes through SkyrimPlatform's `dispelSpellFrom(actor, spell, caster)`, which removes only the
copies that NPC cast. A client without that export (an older SkyrimPlatform) spares a blocked landing instead while
another NPC's unblocked landing of the same spell is younger than its poison's duration, since dispelling would take
both; the blocked poison then lands, and the server's guard below stays shut for that time too.
It always dispels when the aggressor is a copy this client does not host (its swing is a replay, the host reports the
real hit), and puts the health back to the value before the effect when only the poison's own first tick was lost.
Each verdict is logged, at most once per NPC every 5 s (`NpcHitSpellBlockService: dispelled <spells> from <npc>
(<reason>, <sources>)`, `kept <spells> from <npc> (unblocked, ...)` or `left <spells> from <npc> (<reason>),
dispelSpell would also take the unblocked poison of <other npc>`). `hit` events from NPC aggressors with a
non-weapon source are logged once per source every 5 s (`HitService: npc ... hit the player with source ...`), which
says whether the engine raises a hit event for a given hit spell at all. An unblocked hit from a hosted NPC still
poisons the player locally as before, invisible to god mode and `onHitDamageAttempt`.

The poison's damage reaches the server only through the victim's own `ChangeValues` report, which `OnChangeValues`
used to accept whenever it lowered the health (only a rise is cropped as regeneration); a downing that follows reads
`[bleedout] <actor> downed by 0`, since a report carries no aggressor. So the server holds the line itself, for the
NPCs that carry such a perk: `FindHitPoison` reads the perk list the NPC's engine uses (its own `PRKR`, or its
template's when the template flags include Use Spell List) and looks for `crFalmerPoison01-05` or
`DLC1crFalmerPoison06`. The Falmer (FalmerRace 0x131F4) and Dawnguard's Frozen Falmer (`DLC1_BF_FrozenFalmerMelee01-05`,
FalmerFrozenVampRace 0x0201AACC through their Use Traits template) carry them, so a wolf, bandit or skeever never
opens the guard. The poison's size comes from its spell's record, magnitude times duration: 15 health over 3 s for
tier 01 (`crFalmerPoisonedWeapon01`, 5 a second), 18, 21, 27 and 36 over 3 s for tiers 02 to 05, and 48 over 4 s for
`DLC1crFalmerPoisonedWeapon06`. When `OnWeaponHit` resolves such an NPC's weapon hit on a player as blocked (the
raised-shield rule above, `hitData.isHitBlocked`), it opens a guard on that player for the poison's duration plus 3 s
(the client's 2 s `ChangeValues` throttle and the report's travel) holding that poison's health, turned into a share
of the bar with the base health the server's hit damage uses; each blocked hit restarts it with that NPC's poison and
sends the `npcHitPoisonBlocked` packet above. A health report lower than
the server's value inside the guard is refused up to what is left of those points: the server keeps its value (or
lowers it only by the part of the drop beyond them) and echoes it back, so the client's health returns to it, and the
points refused are spent. An unblocked hit from a poison perk NPC closes the guard at once (`OnWeaponHit - <actor>
poison guard closed, unblocked hit of <npc>`) and keeps it shut while that poison can still be reported (its
duration plus 3 s), because its poison lands and the report cannot tell it from a blocked one's: a blocked hit
meanwhile opens no guard (`OnWeaponHit - <actor> poison guard not opened for a blocked hit of <npc>, an unblocked
hit's poison is still reported`), and the client's per-caster dispel alone stops the blocked poison. The first
refusal of each guard logs `OnChangeValues - <actor> health report <server> -> <reported> kept at <value>, blocked a
hit of <npc> <ms> ms ago, <points> of <poison> poison health refused`. Other local-only damage reported inside the
guard (a chaurus bite or spit, which is a race attack spell the server never sees, a fall, a burn still ticking,
another player's damage over time) is refused only while points are left, so at most that poison's health of it per
blocked swing (15 to 36 for the Falmer the spawn file uses); damage the server computes (weapon and
spell hits) never passes through the report and is not affected. Two Falmer poisoning through a block at once can
exceed the points, and the excess lands.

## Blocked hits

`OnWeaponHit` resolves a weapon hit as blocked when the target holds a block (`IsBlockActive`) with the aggressor
within 1 rad of its facing, and against an arrow or bolt only with a shield worn; a bash counts as melee. The damage
formula prices a blocked hit at `kBlockedHitDamageMult` (0), for shields and wards alike. One case differs: when an
NPC's weapon hit is blocked by a player, `OnWeaponHit` prices it as unblocked through the whole formula chain (armor,
power attack, sneak and the multiplier formulas) and lets `npcBlockedDamageShare` of it through (server setting,
default 0.2, from 0 to 1; 0 restores full blocks). So a player's block is 80% effective against NPCs and 100%
effective against other players, and NPCs blocking are unchanged. The hit stays blocked everywhere else: Papyrus
`OnHit` gets `abHitBlocked`, `onHitDamageAttempt` is still asked, and the Falmer poison guard and the
`npcHitPoisonBlocked` packet above treat it as blocked, so the NPC's hit spell poison still does not land through a
block. A weapon poison on the NPC's blade lands in full through a block, as before. Wards are unchanged: a ward still
blocks a whole spell hit.

The server logs at boot `npcBlockedDamageShare is <share>: a player's block lets that share of an NPC's weapon hit
through, a player's hit stays fully blocked`, and for each blocked hit on a player `OnWeaponHit - <player> blocked
npc <npc> with <weapon>, <landed> of <unblocked> damage lands (npcBlockedDamageShare <share>)` or `OnWeaponHit -
<player> blocked player|npc <aggressor> with <weapon>, fully blocked` (another player, or any NPC when the share is 0).

## Crit notice, /armor and the pvp.log columns (rebalance)

Three readouts show players and staff what the rebalance formula and durability did. Without
`alduinakDamageFormulaSettings`, or with its `enabled` false and `durability.enabled` false, none of them exists:
hits, chat and `pvp.log` are as before, and `/armor` is an unknown command.

**Hit arguments.** A `scam_native.node` with the rebalance hit arguments calls `onHitDamageAttempt` and
`onHitDamage` with `aggressor, target, source, damage, blocked, power, bash, critical, preDT`; an older one stops
after `damage`. The gamemode part `62_mastery.js` passes every argument on to `60_admin_modes.js`, which reads the
five new ones in one place (`hitExtras`) and only while `enabled` is true. A hit without them is logged once per
gamemode load (`[combat] a hit arrived without the arguments blocked, power, bash, critical, preDT ...`) and
treated as before.

**Crit notice** (`60_admin_modes.js`). A hit with `critical` true sends the aggressor `Critical hit! <damage>
damage.` and the target `You took a critical hit: <damage> damage.`, each only to a player, so a player's crit on
an NPC and a humanoid NPC's crit on a player are announced too. The damage is what landed, after DT and the cap.
A hit that an admin mode replaced (god, smite, heal) is not announced. `combatCritNotice: false` in
`server-settings.json` keeps the notices off (default true); the gamemode reads it when it loads. The client has
no sound packet, so the notice is text in the System tab only.

**pvp.log.** A player's hit on a player is still one line, `<aggressor> hit <target> for <damage> (source
<weapon or spell id>)`. With the rebalance on and the new arguments present the line ends with five columns:
`crit=1 power=0 bash=0 blocked=0 preDT=26.5` (1 or 0 each, then `preDT` rounded to a tenth). `preDT` is the
weapon's damage after its temper, a bash and a crit and before the target's DT (`HitMath::PriceHit`). The power or
sneak multiplier, the speed factor, `playerToNpcMult`, the effect modifiers, the blocked share, poison and the 45
cap all come after it, so `preDT` minus the damage is what the armor took off only for a plain hit (`power=0`, no
sneak attack, `blocked=0`, a weapon no faster than its row, no poison, under the cap). A power attack on an
unarmored player reads about `for 33 ... power=1 ... preDT=16.5`: the damage is above `preDT` and nothing is wrong.

**/armor** (`86_combat_readout.js` and `skymp5-server/ts/systems/combatReadoutSystem.ts`). The chat command lists
what the player wears and holds, one System tab line each:

```
Armor: DT 14.31 (taken off each weapon hit), weight 52
Steel Armor: DT 8.34, Superior, 97% (262/270)
Steel Helmet: DT 2.03, 100% (68/68)
Steel Cuffed Boots: DT 1.69, Broken (0/56)
Steel Shield: DT 0.56, 50% (180/360)
Steel Sword: damage 16.75, Fine, 88% (308/350)
```

- The DT, the temper and the weapon lines come from the native `getCombatStats(actorId)` and exist while `enabled`
  is true. A piece below full condition reads `DT 6.4 of 8`. The temper is the quality name of its step (Fine to
  Legendary).
- The native lists what is held as `weapons`, one entry per hand (`{ baseId, hand: "left" | "right", kind, damage,
  temperStep, ... }`), and each entry gets a line, the right hand first: a dual wielder reads two damage lines. The
  damage is the row damage with the temper in it (Steel sword 16.5, Fine x1.015). A staff or another weapon the
  formula prices no attack for (`kind` `none`) reads `no weapon damage`; fists give no line.
- The condition comes from the native `getDurability(actorId)` and exists while `durability.enabled` is true: the
  percent of the name tag (rounded down, never 0 above broken), the word of `durability.nameTag.brokenLabel` at 0,
  and the HP of the copy out of its full HP. With durability alone (TES5 damage) the command lists the worn
  durable copies with their condition only.
- A weapon line takes the condition of the copy in its own hand (`wornLeft` of `getDurability`), so two swords of
  one base keep their own percent. Worn copies the stats do not name follow as condition lines. An unarmored
  player reads `You wear no armor: DT 0, every weapon hit lands in full.`
- Staff may name an online player: `/armor <name>`.

`CombatReadoutSystem` registers `globalThis.__alduinakArmorReport(actorId)` at boot only when at least one of the
two readouts is on and its native function exists, and the gamemode part answers `Unknown or unavailable command:
/armor` without it, so the parts can be on a server whose native or settings lack the rebalance. Boot logs
`[combat] /armor shows DT and temper per worn piece and condition`, or for a native without a function `[combat]
this scam_native.node has no getCombatStats (no DT lines)` (and the same for `getDurability (no condition)`, with
`, /armor is off` when neither is left). The field names read from the two natives are listed at the top of
`combatStats.ts` and in `copyOf` of `combatReadoutSystem.ts`; a renamed field is changed there. Tests:
`node tools/test-combat-readout.js` in `skymp5-server`.

The three gamemode parts are gitignored files of the server folder (`gamemode_extensions`): they reach the Test
Server through "Build gamemode only" and live through Migrate server.
