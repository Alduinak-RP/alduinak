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
So racial passives such as Nord frost, Dunmer fire, Redguard and Bosmer poison, and Argonian and Bosmer disease
resistance act on server spell damage straight from the plugin's race abilities. Only the resist value the effect
names applies: magic resistance or armor rating abilities count for the few effects that name them (Vampiric Drain,
some dragon and Wabbajack effects), and there is no general magic resistance on other spells.

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
poisons name PoisonResist, so the Redguard and Bosmer passives halve them; the vanilla Damage Stamina poisons name no
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
