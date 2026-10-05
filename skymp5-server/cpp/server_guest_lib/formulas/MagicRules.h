#pragma once
#include <algorithm>

// Spell damage rules of alduinakDamageFormulaSettings.magic, free of server types
namespace MagicRules {

// DT a spell meets: dtShare of what the target wears
inline float SpellDT(float wornDT, float dtShare)
{
  return std::max(wornDT, 0.f) * std::max(dtShare, 0.f);
}

// Spell damage after worn DT, floor of the damage always lands
inline float SpellAfterDT(float damage, float wornDT, float dtShare,
                          float floor)
{
  const float dt = SpellDT(wornDT, dtShare);
  if (!(damage > 0.f) || !(dt > 0.f)) {
    return damage;
  }
  return std::max(damage - dt, floor * damage);
}

}
