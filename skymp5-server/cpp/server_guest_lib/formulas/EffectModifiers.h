#pragma once
#include <algorithm>
#include <cmath>

// Damage or blocking multiplier of a summed skill modifier in percent
inline float EffectModifierMult(float sumPercent)
{
  if (!std::isfinite(sumPercent)) {
    return 1.f;
  }
  return std::clamp(1.f + sumPercent / 100.f, 0.25f, 2.f);
}

// Share of a blocked hit that lands when the blocked part is scaled by blockMult
inline float BlockedPassShare(float passShare, float blockMult)
{
  if (blockMult == 1.f) {
    return passShare;
  }
  return std::clamp(1.f - (1.f - passShare) * blockMult, 0.f, 1.f);
}

// effectModifiers key of a present block: absent is on, a value that is not true or false is off
inline bool EffectModifiersSetting(bool keyPresent, bool isBoolean, bool value)
{
  return !keyPresent || (isBoolean && value);
}

// effectModifiers of the settings block counts only while the formula or durability is on
inline bool EffectModifiersActive(bool blockPresent, bool enabled,
                                  bool durabilityEnabled, bool effectModifiers)
{
  return blockPresent && (enabled || durabilityEnabled) && effectModifiers;
}
