#pragma once
#include <memory>

#include "IDamageFormula.h"
#include <nlohmann/json_fwd.hpp>

class DamageMultFormula : public IDamageFormula
{
public:
  struct Settings
  {
    float multiplier = 2.f;
  };

  static Settings ParseConfig(const nlohmann::json& config);

  DamageMultFormula(std::unique_ptr<IDamageFormula> baseFormula_,
                    const Settings& settings_);

  [[nodiscard]] float CalculateDamage(const MpActor& aggressor,
                                      const MpActor& target,
                                      const HitData& hitData) const override;

  [[nodiscard]] float CalculateDamage(
    const MpActor& aggressor, const MpActor& target,
    const SpellCastData& spellCastData) const override;

private:
  std::unique_ptr<IDamageFormula> baseFormula;
  Settings settings;
};
