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
some dragon and Wabbajack effects), and there is no general magic resistance on other spells. The server computes no
weapon poison damage.
