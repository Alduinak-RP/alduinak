#pragma once
#include "../ConditionTag.h"
#include "AlduinakCombatSettings.h"
#include <algorithm>
#include <cmath>
#include <optional>

// The wear and condition arithmetic of durability, free of server types
namespace DurabilityRules {

using Settings = AlduinakCombatSettings::Durability;

// eff(c): the share of its damage or DT a worn copy keeps, 1 from kneeCondition up, effectAtZero just above 0
inline float Eff(const Settings& d, float condition)
{
  const float knee = d.effect.kneeCondition;
  if (!std::isfinite(condition) || condition >= knee || !(knee > 0.f)) {
    return 1.f;
  }
  const float c = std::max(condition, 0.f);
  return d.effect.effectAtZero + (1.f - d.effect.effectAtZero) * c / knee;
}

struct WeaponEffect
{
  float mult = 1.f;
  // A broken weapon never crits
  bool broken = false;
};

// Damage share of a weapon copy: eff(c), brokenWeaponMult for a broken one
inline WeaponEffect WeaponEffectOf(const Settings& d,
                                   const std::optional<float>& condition)
{
  if (ConditionTag::IsBroken(condition)) {
    return { d.effect.brokenWeaponMult, true };
  }
  return { condition ? Eff(d, *condition) : 1.f, false };
}

// DT share of an armor piece or shield copy: eff(c), brokenArmorDT for a broken one
inline float ArmorEffectOf(const Settings& d,
                           const std::optional<float>& condition)
{
  if (ConditionTag::IsBroken(condition)) {
    return d.effect.brokenArmorDT;
  }
  return condition ? Eff(d, *condition) : 1.f;
}

struct HitFacts
{
  bool power = false;
  bool bash = false;
  bool blocked = false;
};

// Wear points of the weapon that hit; shoots for a bow or crossbow whose hit is no bash
inline float AggressorWear(const Settings::Wear& w, bool shoots,
                           const HitFacts& hit)
{
  if (hit.bash) {
    return w.bash;
  }
  if (shoots) {
    // Only an arrow that lands wears the bow
    return hit.blocked ? 0.f : w.bowHit;
  }
  if (hit.blocked) {
    return w.parriedHit;
  }
  return w.landedHit + (hit.power ? w.powerExtra : 0.f);
}

enum class TargetWear : uint8_t
{
  None,
  Shield,
  ParryingWeapon,
  Armor
};

// What a hit wears on the target's side: the shield or parrying weapon of a block, the armor of a hit of armorMinPreDT or more before DT
inline TargetWear TargetWearOf(const Settings::Wear& w, const HitFacts& hit,
                               bool shieldWorn, float preDT)
{
  if (hit.blocked) {
    return shieldWorn ? TargetWear::Shield : TargetWear::ParryingWeapon;
  }
  return preDT >= w.armorMinPreDT ? TargetWear::Armor : TargetWear::None;
}

inline float ShieldWear(const Settings::Wear& w, const HitFacts& hit)
{
  return w.shieldBlock + (hit.power ? w.powerExtra : 0.f);
}

inline float ParryWear(const Settings::Wear& w)
{
  return w.parriedHit;
}

// Points one hit spreads over the worn armor pieces
inline float ArmorWear(const Settings::Wear& w, const HitFacts& hit)
{
  return w.armorHit + (hit.power ? w.powerExtra : 0.f);
}

// A piece's part of the armor points: its slot share of the shares worn, so a full set loses the same percent on every piece
inline float ArmorPieceWear(float armorPoints, float pieceShare,
                            float wornShares)
{
  return wornShares > 0.f && pieceShare > 0.f
    ? armorPoints * pieceShare / wornShares
    : 0.f;
}

struct Worn
{
  // The condition to store, in steps of 1e-4
  float condition = 1.f;
  // Points the rounding left over, kept for the next write
  float carry = 0.f;
  bool broke = false;
};

// A copy of hp points at a condition after points of wear
inline Worn ApplyWear(const std::optional<float>& condition, float points,
                      float hp)
{
  Worn res;
  const float before = std::clamp(condition.value_or(1.f), 0.f, 1.f);
  if (!(hp > 0.f) || !std::isfinite(points)) {
    res.condition = ConditionTag::Rounded(before);
    return res;
  }
  const float exact = std::max(before - points / hp, 0.f);
  res.condition = ConditionTag::Rounded(exact);
  res.carry = exact > 0.f ? (res.condition - exact) * hp : 0.f;
  res.broke = res.condition <= 0.f && before > 0.f;
  return res;
}

// True when the wear moves the percent shown after the name
inline bool PercentChanges(const std::optional<float>& condition, float points,
                           float hp)
{
  if (!(points > 0.f)) {
    return false;
  }
  return ConditionTag::Percent(
           ConditionTag::Stored(ApplyWear(condition, points, hp).condition)) !=
    ConditionTag::Percent(condition);
}

// A flush is due when a shown percent would move and the last flush is minSeconds old
inline bool FlushDue(const Settings& d, bool percentChanges,
                     float secondsSinceFlush)
{
  return percentChanges && secondsSinceFlush >= d.flushMinSeconds;
}

}
