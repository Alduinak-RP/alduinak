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
which the server zeroes whatever the engine decided. Only a hit that is neither keeps the poison, and when no weapon
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
