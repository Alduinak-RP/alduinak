#pragma once

#include "IDamageFormula.h"

// Share of the damage a blocked hit keeps, for shields and wards alike (none)
inline constexpr float kBlockedHitDamageMult = 0.f;

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
