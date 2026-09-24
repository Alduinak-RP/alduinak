#pragma once

#include "IDamageFormula.h"
#include <cstdint>

// Share of the damage a blocked hit keeps, for shields and wards alike (none)
inline constexpr float kBlockedHitDamageMult = 0.f;

// What one charge of a weapon poison takes from the actor hit, effects the server cannot play are counted in ignored
struct PoisonHit
{
  float health = 0.f;
  float stamina = 0.f;
  float magicka = 0.f;
  unsigned ignored = 0;
};

// Hostile Health/Stamina/Magicka value and dual value effects of an ALCH poison, per-second ones as one burst, scaled by the target's resist abilities
[[nodiscard]] PoisonHit CalculatePoisonHit(const MpActor& aggressor,
                                           const MpActor& target,
                                           uint32_t poisonId);

// Implements vanilla Skyrim damage formula.
// Some parts may be missing. If they are, there should be a TODO regarding it.
// If there's no corresponding TODO, consider adding it and/or filing an issue.

class TES5DamageFormula : public IDamageFormula
{
public:
  [[nodiscard]] float CalculateDamage(const MpActor& aggressor,
                                      const MpActor& target,
                                      const HitData& hitData) const override;

  [[nodiscard]] float CalculateDamage(
    const MpActor& aggressor, const MpActor& target,
    const SpellCastData& spellCastData) const override;
};
