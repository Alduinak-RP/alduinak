#include <catch2/catch_all.hpp>

#include "formulas/AlduinakHitRules.h"
#include <cmath>

namespace {

using Catch::Matchers::WithinAbs;
using HitMath::AttackKind;
using HitRules::CombatState;
using HitRules::PowerVerdict;
using HitRules::SneakVerdict;
using HitRules::TimePoint;
using ItemRows::WeaponType;

// The interval and shot interval columns of the design are rounded to four decimals
constexpr double kEps = 1e-4;

// The type speeds and hands of the plan, every other number is the code default
AlduinakCombatSettings Settings()
{
  AlduinakCombatSettings s;
  const auto type = [&](WeaponType weaponType, float speed, int hands) {
    auto& row = s.weaponTypes[static_cast<size_t>(weaponType)];
    row.speed = speed;
    row.hands = hands;
  };
  type(WeaponType::Dagger, 1.3f, 1);
  type(WeaponType::Sword, 1.f, 1);
  type(WeaponType::WarAxe, 0.9f, 1);
  type(WeaponType::Mace, 0.8f, 1);
  type(WeaponType::Greatsword, 0.7f, 2);
  type(WeaponType::Battleaxe, 0.7f, 2);
  type(WeaponType::Warhammer, 0.6f, 2);
  type(WeaponType::Unarmed, 1.f, 1);
  return s;
}

HitMath::Attack Swing(const AlduinakCombatSettings& s, WeaponType type,
                      float speedFactor = 1.f,
                      AttackKind kind = AttackKind::Melee)
{
  HitMath::Attack attack;
  attack.kind = kind;
  attack.type = type;
  const auto& row = s.TypeRow(type);
  attack.cycle = HitMath::MeleeCycle(row.hands, row.speed);
  attack.speedFactor = speedFactor;
  return attack;
}

// A moment the given milliseconds into the test
TimePoint At(int ms)
{
  return TimePoint() + std::chrono::hours(1) + std::chrono::milliseconds(ms);
}

}

TEST_CASE("The melee rate limit follows the type row", "[AlduinakRules]")
{
  const auto s = Settings();
  const auto interval = [&](WeaponType type) {
    return HitRules::HitInterval(s, Swing(s, type));
  };
  REQUIRE_THAT(interval(WeaponType::Dagger), WithinAbs(0.5922, kEps));
  REQUIRE_THAT(interval(WeaponType::Sword), WithinAbs(0.7699, kEps));
  REQUIRE_THAT(interval(WeaponType::WarAxe), WithinAbs(0.8554, kEps));
  REQUIRE_THAT(interval(WeaponType::Mace), WithinAbs(0.9624, kEps));
  REQUIRE_THAT(interval(WeaponType::Greatsword), WithinAbs(0.959, kEps));
  REQUIRE_THAT(interval(WeaponType::Battleaxe), WithinAbs(0.959, kEps));
  REQUIRE_THAT(interval(WeaponType::Warhammer), WithinAbs(1.1189, kEps));

  // Fists and claws swing at the fist's timing
  REQUIRE_THAT(HitRules::HitInterval(
                 s, Swing(s, WeaponType::Unarmed, 1.f, AttackKind::Unarmed)),
               WithinAbs(0.7699, kEps));

  // A record faster than its row hits for less and may hit that much sooner
  REQUIRE_THAT(HitRules::HitInterval(s, Swing(s, WeaponType::Sword, 0.8f)),
               WithinAbs(0.7699 * 0.8, kEps));

  // The record limit of a two-handed weapon, 0.605 / speed, is shorter than its swing margin
  REQUIRE(interval(WeaponType::Greatsword) > 0.605f / 0.7f);
  REQUIRE(interval(WeaponType::Warhammer) > 0.605f / 0.6f);
}

TEST_CASE("Bows, crossbows and creatures keep the record's own hit limit",
          "[AlduinakRules]")
{
  const auto s = Settings();
  for (auto kind : { AttackKind::Bow, AttackKind::Crossbow,
                     AttackKind::Natural, AttackKind::None }) {
    REQUIRE(HitRules::HitInterval(s, Swing(s, WeaponType::Sword, 1.f, kind)) <
            0.f);
  }
}

TEST_CASE("Shot intervals follow the draw of the bow row", "[AlduinakRules]")
{
  const auto s = Settings();
  // Long bow: draw cycle 1.5 s, 1.2 s with QuickShot
  REQUIRE_THAT(HitRules::BowShotInterval(s, 1.f, 1.f, false),
               WithinAbs(1.332, kEps));
  REQUIRE_THAT(HitRules::BowShotInterval(s, 1.f, 1.f, true),
               WithinAbs(0.888 * 1.2, kEps));
  // Hunting bow: 0.5 + 1 / 0.9375
  REQUIRE_THAT(HitRules::BowShotInterval(s, 0.9375f, 1.f, false),
               WithinAbs(0.888 * (0.5 + 1 / 0.9375), kEps));
  // Daedric bow: draw cycle 2.5 s, 1.9 s with QuickShot
  REQUIRE_THAT(HitRules::BowShotInterval(s, 0.5f, 1.f, false),
               WithinAbs(2.22, kEps));
  REQUIRE_THAT(HitRules::BowShotInterval(s, 0.5f, 1.f, true),
               WithinAbs(0.888 * 1.9, kEps));
  // Row speeds are clamped to 0.5 .. 1
  REQUIRE_THAT(HitRules::BowShotInterval(s, 0.3f, 1.f, false),
               WithinAbs(2.22, kEps));
  REQUIRE_THAT(HitRules::BowShotInterval(s, 1.4f, 1.f, false),
               WithinAbs(1.332, kEps));
  // A record faster than its row
  REQUIRE_THAT(HitRules::BowShotInterval(s, 1.f, 0.9f, false),
               WithinAbs(1.332 * 0.9, kEps));
  REQUIRE_THAT(HitRules::CrossbowShotInterval(s), WithinAbs(1.6872, kEps));
}

TEST_CASE("A sneak attack needs a second of sneaking", "[AlduinakRules]")
{
  const auto s = Settings();
  CombatState aggressor, target;
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(0)) ==
          SneakVerdict::NotSneaking);

  HitRules::NoteSneaking(aggressor, true, At(0));
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(500)) ==
          SneakVerdict::TooShort);
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(1000)) ==
          SneakVerdict::Ok);

  // Later movement reports keep the first moment
  HitRules::NoteSneaking(aggressor, true, At(900));
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(1000)) ==
          SneakVerdict::Ok);

  // Standing up starts the count again
  HitRules::NoteSneaking(aggressor, false, At(1100));
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(1200)) ==
          SneakVerdict::NotSneaking);
  HitRules::NoteSneaking(aggressor, true, At(1300));
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(2000)) ==
          SneakVerdict::TooShort);
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(2300)) ==
          SneakVerdict::Ok);
}

TEST_CASE("A sneak attack on a player is a first strike", "[AlduinakRules]")
{
  auto s = Settings();
  CombatState aggressor, target;
  HitRules::NoteSneaking(aggressor, true, At(0));
  HitRules::NoteCombat(target, At(5000));

  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(14900)) ==
          SneakVerdict::TargetInCombat);
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(15000)) ==
          SneakVerdict::Ok);
  // The stealth archer loop on NPCs stays
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, false, At(6000)) ==
          SneakVerdict::Ok);

  s.sneakCalmRuleTargets = "all";
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, false, At(6000)) ==
          SneakVerdict::TargetInCombat);
  REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(6000)) ==
          SneakVerdict::TargetInCombat);

  for (const char* off : { "", "none" }) {
    s.sneakCalmRuleTargets = off;
    REQUIRE(HitRules::CheckSneak(s, aggressor, target, true, At(6000)) ==
            SneakVerdict::Ok);
  }
}

TEST_CASE("A power flag needs a fresh power attack start", "[AlduinakRules]")
{
  const auto s = Settings();
  CombatState state;
  REQUIRE(HitRules::CheckPower(s, state, At(0)) == PowerVerdict::NoEvent);
  REQUIRE_FALSE(HitRules::PowerPasses(PowerVerdict::NoEvent));

  HitRules::NotePowerEvent(state, At(0));
  REQUIRE(HitRules::CheckPower(s, state, At(400)) == PowerVerdict::Ok);
  REQUIRE(state.powerEvents.empty());

  // The Warrior's Sweep: every target inside 0.1 s of the first hit
  REQUIRE(HitRules::CheckPower(s, state, At(450)) == PowerVerdict::SameSwing);
  REQUIRE(HitRules::CheckPower(s, state, At(490)) == PowerVerdict::SameSwing);
  REQUIRE(HitRules::PowerPasses(PowerVerdict::SameSwing));

  // The start is used up
  REQUIRE(HitRules::CheckPower(s, state, At(800)) == PowerVerdict::NoEvent);

  // Power hits at least 1.5 s apart, the start waits for a later hit
  HitRules::NotePowerEvent(state, At(1000));
  REQUIRE(HitRules::CheckPower(s, state, At(1300)) == PowerVerdict::TooSoon);
  REQUIRE(state.powerEvents.size() == 1);
  REQUIRE(HitRules::CheckPower(s, state, At(1950)) == PowerVerdict::Ok);

  // A start older than 1.6 s no longer counts
  HitRules::NotePowerEvent(state, At(10000));
  REQUIRE(HitRules::CheckPower(s, state, At(11700)) == PowerVerdict::NoEvent);
  REQUIRE(state.powerEvents.empty());
  HitRules::NotePowerEvent(state, At(20000));
  REQUIRE(HitRules::CheckPower(s, state, At(21500)) == PowerVerdict::Ok);
}

TEST_CASE("Unused power attack starts are bounded", "[AlduinakRules]")
{
  CombatState state;
  for (int i = 0; i < 100; ++i) {
    HitRules::NotePowerEvent(state, At(i));
  }
  REQUIRE(state.powerEvents.size() == HitRules::kMaxPowerEvents);
  REQUIRE(state.powerEvents.back() == At(99));
}

TEST_CASE("Power attack starts are told by their animation event",
          "[AlduinakRules]")
{
  for (const char* name :
       { "attackPowerStartInPlace", "attackPowerStartForward",
         "attackPowerStartBackward", "attackPowerStartLeft",
         "attackPowerStartRight", "attackPowerStartDualWield",
         "attackPowerStart_2HWSprint", "attackPowerStart_2HMSprint",
         "AttackPowerStartForwardH2HRightHand", "ATTACKPOWERSTART",
         "bashPowerStart" }) {
    INFO(name);
    REQUIRE(HitRules::IsPowerAttackStart(name));
  }
  for (const char* name :
       { "attackStart", "attackStartSprint", "bashStart", "attackPower",
         "blockStart", "attackRelease", "" }) {
    INFO(name);
    REQUIRE_FALSE(HitRules::IsPowerAttackStart(name));
  }
}

TEST_CASE("The fired arrow prices its hit for ten seconds", "[AlduinakRules]")
{
  CombatState state;
  REQUIRE(HitRules::FiredAmmo(state, At(0)) == 0);

  HitRules::NoteShot(state, 0x13985, 0x139c0, At(0));
  REQUIRE(state.lastShotWeapon == 0x13985);
  REQUIRE(HitRules::FiredAmmo(state, At(0)) == 0x139c0);
  REQUIRE(HitRules::FiredAmmo(state, At(10000)) == 0x139c0);
  REQUIRE(HitRules::FiredAmmo(state, At(10001)) == 0);

  HitRules::NoteShot(state, 0x13985, 0x1397d, At(20000));
  REQUIRE(HitRules::FiredAmmo(state, At(21000)) == 0x1397d);
}

TEST_CASE("Poison lands on open hits only, after worn DT and inside the cap",
          "[AlduinakRules]")
{
  const auto s = Settings();
  REQUIRE(HitRules::PoisonLands(false, false));
  REQUIRE_FALSE(HitRules::PoisonLands(true, false));
  REQUIRE_FALSE(HitRules::PoisonLands(false, true));
  REQUIRE_FALSE(HitRules::PoisonLands(true, true));

  // Iron dagger 2.01 against Daedric with a shield (DT 15.9) and a 20 point poison: 9 hits down 100 health
  const float poisoned = 2.01f + HitMath::PoisonAfterDT(s, 20.f, 15.9f);
  REQUIRE_THAT(poisoned, WithinAbs(12.01, kEps));
  REQUIRE(std::ceil(100.f / poisoned) == 9.f);

  // Iron sword 5.25 against Steel (DT 9.75)
  REQUIRE_THAT(5.25f + HitMath::PoisonAfterDT(s, 20.f, 9.75f),
               WithinAbs(15.5, kEps));
  // A strong poison on a power crit stays inside the cap of a player
  REQUIRE(HitMath::CapPlayerHit(
            s, 40.f + HitMath::PoisonAfterDT(s, 60.f, 9.75f), true) == 45.f);
  REQUIRE_THAT(HitMath::CapPlayerHit(
                 s, 40.f + HitMath::PoisonAfterDT(s, 60.f, 9.75f), false),
               WithinAbs(90.25, kEps));
}
