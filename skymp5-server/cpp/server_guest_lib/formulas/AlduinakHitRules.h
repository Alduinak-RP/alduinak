#pragma once
#include "AlduinakHitMath.h"
#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <optional>
#include <string_view>
#include <vector>

// The hit validation rules of the rebalance formula and the per-actor memory they read, free of server types
namespace HitRules {

using Clock = std::chrono::steady_clock;
using TimePoint = Clock::time_point;

inline constexpr size_t kMaxPowerEvents = 8;
// A hit this long after a shot is still priced with the arrow that was fired
inline constexpr float kFiredAmmoSeconds = 10.f;

inline float SecondsBetween(TimePoint from, TimePoint to)
{
  return std::chrono::duration<float>(to - from).count();
}

// What the rebalance remembers about one actor between hits, never saved
struct CombatState
{
  // Set while the actor's movement reports sneaking
  std::optional<TimePoint> sneakingSince;
  // The last weapon or damaging spell hit dealt, taken or blocked
  std::optional<TimePoint> lastCombatAt;
  // Power attack starts no hit has used yet
  std::vector<TimePoint> powerEvents;
  // First hit of the last power attack that passed the check
  std::optional<TimePoint> lastPowerHitAt;
  uint32_t lastFiredAmmo = 0;
  uint32_t lastShotWeapon = 0;
  std::optional<TimePoint> lastShotAt;
};

inline void NoteSneaking(CombatState& state, bool sneaking, TimePoint now)
{
  if (!sneaking) {
    state.sneakingSince.reset();
  } else if (!state.sneakingSince) {
    state.sneakingSince = now;
  }
}

inline void NoteCombat(CombatState& state, TimePoint now)
{
  state.lastCombatAt = now;
}

inline void NoteShot(CombatState& state, uint32_t weaponId, uint32_t ammoId,
                     TimePoint now)
{
  state.lastShotWeapon = weaponId;
  state.lastFiredAmmo = ammoId;
  state.lastShotAt = now;
}

// The arrow or bolt of the last shot while a hit can still be its landing, 0 otherwise
inline uint32_t FiredAmmo(const CombatState& state, TimePoint now)
{
  return state.lastShotAt && state.lastFiredAmmo &&
      SecondsBetween(*state.lastShotAt, now) <= kFiredAmmoSeconds
    ? state.lastFiredAmmo
    : 0;
}

inline bool StartsWithNoCase(std::string_view text, std::string_view prefix)
{
  return text.size() >= prefix.size() &&
    std::equal(prefix.begin(), prefix.end(), text.begin(), [](char a, char b) {
           return std::tolower(static_cast<unsigned char>(a)) ==
             std::tolower(static_cast<unsigned char>(b));
         });
}

// The animation events that open a power attack or a power bash
inline bool IsPowerAttackStart(std::string_view animEventName)
{
  return StartsWithNoCase(animEventName, "attackPowerStart") ||
    StartsWithNoCase(animEventName, "bashPowerStart");
}

inline void NotePowerEvent(CombatState& state, TimePoint now)
{
  if (state.powerEvents.size() >= kMaxPowerEvents) {
    state.powerEvents.erase(state.powerEvents.begin());
  }
  state.powerEvents.push_back(now);
}

enum class SneakVerdict : uint8_t
{
  Ok,
  NotSneaking,
  TooShort,
  TargetInCombat
};

inline const char* SneakVerdictText(SneakVerdict verdict) noexcept
{
  switch (verdict) {
    case SneakVerdict::NotSneaking:
      return "the aggressor is not sneaking";
    case SneakVerdict::TooShort:
      return "the aggressor has not sneaked long enough";
    case SneakVerdict::TargetInCombat:
      return "the target dealt, took or blocked a hit too recently";
    default:
      return "ok";
  }
}

// sneak.calmRuleTargets: "players" asks calm of player targets, "all" of every target, anything else of none
inline bool CalmRuleApplies(const AlduinakCombatSettings& s,
                            bool targetIsPlayer)
{
  return s.sneakCalmRuleTargets == "all" ||
    (s.sneakCalmRuleTargets == "players" && targetIsPlayer);
}

// A sneak flag counts after minSneakSeconds of sneaking, on a target the calm rule covers only as a first strike
inline SneakVerdict CheckSneak(const AlduinakCombatSettings& s,
                               const CombatState& aggressor,
                               const CombatState& target, bool targetIsPlayer,
                               TimePoint now)
{
  if (!aggressor.sneakingSince) {
    return SneakVerdict::NotSneaking;
  }
  if (SecondsBetween(*aggressor.sneakingSince, now) < s.sneakMinSneakSeconds) {
    return SneakVerdict::TooShort;
  }
  if (CalmRuleApplies(s, targetIsPlayer) && target.lastCombatAt &&
      SecondsBetween(*target.lastCombatAt, now) < s.sneakTargetCalmSeconds) {
    return SneakVerdict::TargetInCombat;
  }
  return SneakVerdict::Ok;
}

enum class PowerVerdict : uint8_t
{
  Ok,
  // Another target of a swing that already passed
  SameSwing,
  NoEvent,
  TooSoon
};

inline const char* PowerVerdictText(PowerVerdict verdict) noexcept
{
  switch (verdict) {
    case PowerVerdict::SameSwing:
      return "same swing";
    case PowerVerdict::NoEvent:
      return "no power attack start arrived in the event window";
    case PowerVerdict::TooSoon:
      return "the last power attack landed too recently";
    default:
      return "ok";
  }
}

inline bool PowerPasses(PowerVerdict verdict) noexcept
{
  return verdict == PowerVerdict::Ok || verdict == PowerVerdict::SameSwing;
}

// A player's power flag needs a fresh power attack start; a passing hit uses up the starts and opens the splash window of its swing
inline PowerVerdict CheckPower(const AlduinakCombatSettings& s,
                               CombatState& state, TimePoint now)
{
  if (state.lastPowerHitAt &&
      SecondsBetween(*state.lastPowerHitAt, now) <=
        s.powerSplashWindowSeconds) {
    return PowerVerdict::SameSwing;
  }
  std::erase_if(state.powerEvents, [&](TimePoint at) {
    return SecondsBetween(at, now) > s.powerEventWindowSeconds;
  });
  if (state.powerEvents.empty()) {
    return PowerVerdict::NoEvent;
  }
  if (state.lastPowerHitAt &&
      SecondsBetween(*state.lastPowerHitAt, now) < s.powerMinIntervalSeconds) {
    return PowerVerdict::TooSoon;
  }
  state.powerEvents.clear();
  state.lastPowerHitAt = now;
  return PowerVerdict::Ok;
}

// Seconds the rate limit asks between two hits of the attack, below 0 for bows, crossbows and creatures, which keep the record's own limit
inline float HitInterval(const AlduinakCombatSettings& s,
                         const HitMath::Attack& attack)
{
  return attack.kind == HitMath::AttackKind::Melee ||
      attack.kind == HitMath::AttackKind::Unarmed
    ? HitMath::MeleeInterval(s, attack)
    : -1.f;
}

// Seconds a bow of the row needs between two shots, QuickShot shortens the draw
inline float BowShotInterval(const AlduinakCombatSettings& s, float rowSpeed,
                             float speedFactor, bool quickShot)
{
  const float draw =
    (quickShot ? s.quickShotDrawMult : 1.f) / std::clamp(rowSpeed, 0.5f, 1.f);
  return s.rateLimitFactor * (0.5f + draw) * speedFactor;
}

inline float CrossbowShotInterval(const AlduinakCombatSettings& s)
{
  return s.rateLimitFactor * s.crossbowReload;
}

// A weapon poison lands on hits that are neither blocked nor a bash
inline bool PoisonLands(bool blocked, bool bash) noexcept
{
  return !blocked && !bash;
}

}
