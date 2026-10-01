#pragma once
#include <algorithm>
#include <optional>

// Spell damage rules of alduinakDamageFormulaSettings.magic, free of server types
namespace MagicRules {

// Share of its magnitude one damaging effect keeps: its own resist value, then magic resistance unless the rule is off, the spell ignores resistance or the effect's own value is magic resistance
inline float EffectMult(float ownResistMult, float magicResistMult,
                        bool magicResistance, bool ignoresResistance,
                        bool ownIsMagicResist)
{
  if (!magicResistance || ignoresResistance || ownIsMagicResist) {
    return ownResistMult;
  }
  return ownResistMult * magicResistMult;
}

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

// magic.resistance: true or false decides, unset is on unless damageMultConditionalFormulaSettings still holds racial magic entries; off without the formula
inline bool NativeMagicResistance(bool formulaOn, std::optional<bool> setting,
                                  bool racialEntries)
{
  if (!formulaOn) {
    return false;
  }
  return setting ? *setting : !racialEntries;
}

}
