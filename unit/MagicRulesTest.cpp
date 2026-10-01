#include <catch2/catch_all.hpp>

#include "HealthScale.h"
#include "formulas/MagicRules.h"
#include <limits>
#include <optional>

using Catch::Matchers::WithinAbs;

TEST_CASE("Magic resistance multiplies an effect's own resistance",
          "[MagicRules]")
{
  // Flames (8) on a Breton, Firebolt (25) on an Orc
  REQUIRE_THAT(8.f * MagicRules::EffectMult(1.f, 0.5f, true, false, false),
               WithinAbs(4.0, 0.0001));
  REQUIRE_THAT(25.f * MagicRules::EffectMult(1.f, 0.75f, true, false, false),
               WithinAbs(18.75, 0.0001));
  // Fire resistance 50 beside magic resistance 50
  REQUIRE_THAT(MagicRules::EffectMult(0.5f, 0.5f, true, false, false),
               WithinAbs(0.25, 0.0001));
  // A weakness to magic raises the damage
  REQUIRE_THAT(MagicRules::EffectMult(1.f, 1.25f, true, false, false),
               WithinAbs(1.25, 0.0001));
}

TEST_CASE("Magic resistance skips what it must not touch", "[MagicRules]")
{
  // The rule off: the effect's own multiplier bit for bit
  REQUIRE(MagicRules::EffectMult(1.f, 0.5f, false, false, false) == 1.f);
  REQUIRE(MagicRules::EffectMult(0.37f, 0.5f, false, false, false) == 0.37f);
  REQUIRE(MagicRules::EffectMult(1.25f, 0.5f, false, true, true) == 1.25f);
  // A spell that ignores resistance
  REQUIRE(MagicRules::EffectMult(0.5f, 0.5f, true, true, false) == 0.5f);
  // An effect resisted by magic resistance itself counts it once
  REQUIRE(MagicRules::EffectMult(0.5f, 0.5f, true, false, true) == 0.5f);
}

TEST_CASE("A spell loses a share of the worn DT and keeps its floor",
          "[MagicRules]")
{
  constexpr float kSteel = 9.75f;
  constexpr float kDaedric = 15.f;
  // Firebolt, Fireball and Incinerate against a Steel set
  REQUIRE_THAT(MagicRules::SpellAfterDT(25.f, kSteel, 0.5f, 0.5f),
               WithinAbs(20.125, 0.0001));
  REQUIRE_THAT(MagicRules::SpellAfterDT(40.f, kSteel, 0.5f, 0.5f),
               WithinAbs(35.125, 0.0001));
  REQUIRE_THAT(MagicRules::SpellAfterDT(60.f, kSteel, 0.5f, 0.5f),
               WithinAbs(55.125, 0.0001));
  // Against a Daedric set
  REQUIRE_THAT(MagicRules::SpellAfterDT(25.f, kDaedric, 0.5f, 0.5f),
               WithinAbs(17.5, 0.0001));
  // One hit of Flames stops at the floor
  REQUIRE_THAT(MagicRules::SpellAfterDT(8.f, kSteel, 0.5f, 0.5f),
               WithinAbs(4.0, 0.0001));
  REQUIRE_THAT(MagicRules::SpellAfterDT(8.f, kDaedric, 0.5f, 0.2f),
               WithinAbs(1.6, 0.0001));
  REQUIRE_THAT(MagicRules::SpellAfterDT(8.f, 6.f, 0.5f, 0.5f),
               WithinAbs(5.0, 0.0001));
  // The whole DT
  REQUIRE_THAT(MagicRules::SpellAfterDT(25.f, kSteel, 1.f, 0.5f),
               WithinAbs(15.25, 0.0001));
  // A Breton in Steel: Firebolt halves first, then meets the DT
  REQUIRE_THAT(MagicRules::SpellAfterDT(
                 25.f * MagicRules::EffectMult(1.f, 0.5f, true, false, false),
                 kSteel, 0.5f, 0.5f),
               WithinAbs(7.625, 0.0001));
  REQUIRE_THAT(MagicRules::SpellDT(kSteel, 0.5f), WithinAbs(4.875, 0.0001));
}

TEST_CASE("Without DT or a share the spell damage stays bit for bit",
          "[MagicRules]")
{
  REQUIRE(MagicRules::SpellAfterDT(25.3f, 0.f, 0.5f, 0.5f) == 25.3f);
  REQUIRE(MagicRules::SpellAfterDT(25.3f, 9.75f, 0.f, 0.5f) == 25.3f);
  REQUIRE(MagicRules::SpellAfterDT(25.3f, -4.f, 0.5f, 0.5f) == 25.3f);
  REQUIRE(MagicRules::SpellAfterDT(0.f, 9.75f, 0.5f, 0.5f) == 0.f);
  REQUIRE(MagicRules::SpellAfterDT(-3.f, 9.75f, 0.5f, 0.5f) == -3.f);
  REQUIRE(MagicRules::SpellDT(-4.f, 0.5f) == 0.f);
  REQUIRE(MagicRules::SpellDT(9.75f, -1.f) == 0.f);
}

TEST_CASE("magic.resistance follows the racial entries unless it is set",
          "[MagicRules]")
{
  const std::optional<bool> unset;
  // Not set: on once the racial entries are gone
  REQUIRE(MagicRules::NativeMagicResistance(true, unset, false));
  REQUIRE(!MagicRules::NativeMagicResistance(true, unset, true));
  // true and false decide whatever the entries say
  REQUIRE(MagicRules::NativeMagicResistance(true, true, true));
  REQUIRE(MagicRules::NativeMagicResistance(true, true, false));
  REQUIRE(!MagicRules::NativeMagicResistance(true, false, false));
  REQUIRE(!MagicRules::NativeMagicResistance(true, false, true));
  // Never without the formula
  REQUIRE(!MagicRules::NativeMagicResistance(false, unset, false));
  REQUIRE(!MagicRules::NativeMagicResistance(false, true, false));
}

TEST_CASE("private.healthScale reads a number and nothing else",
          "[HealthScale]")
{
  REQUIRE(HealthScale::FromDump("null") == 1.f);
  REQUIRE(HealthScale::FromDump("") == 1.f);
  REQUIRE(HealthScale::FromDump("1") == 1.f);
  REQUIRE(HealthScale::FromDump("1.0") == 1.f);
  REQUIRE_THAT(HealthScale::FromDump("0.6"), WithinAbs(0.6, 0.00001));
  REQUIRE_THAT(HealthScale::FromDump("0.2"), WithinAbs(0.2, 0.00001));
  REQUIRE_THAT(HealthScale::FromDump("1.5"), WithinAbs(1.5, 0.00001));
  REQUIRE_THAT(HealthScale::FromDump("6e-1"), WithinAbs(0.6, 0.00001));
  REQUIRE(HealthScale::FromDump("true") == 1.f);
  REQUIRE(HealthScale::FromDump("\"0.5\"") == 1.f);
  REQUIRE(HealthScale::FromDump("[0.5]") == 1.f);
  REQUIRE(HealthScale::FromDump("{\"v\":0.5}") == 1.f);
  REQUIRE(HealthScale::FromDump("0.5x") == 1.f);
  REQUIRE(HealthScale::FromDump(" 0.5") == 1.f);
  REQUIRE(HealthScale::FromDump("nan") == 1.f);
  REQUIRE(HealthScale::FromDump("inf") == 1.f);
  REQUIRE(HealthScale::FromDump("1e999") == 1.f);
  // Kept inside its bounds
  REQUIRE(HealthScale::FromDump("0.00001") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("250") == HealthScale::kMax);
  REQUIRE(HealthScale::FromDump("1e-50") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("1e39") == HealthScale::kMax);
  // A cold penalty of 100% writes 0: the smallest pool, not the full one
  REQUIRE(HealthScale::FromDump("0") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("0.0") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("-0.0") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("-2.220446049250313e-16") == HealthScale::kMin);
  REQUIRE(HealthScale::FromDump("-0.5") == HealthScale::kMin);
  REQUIRE_THAT(20.f / HealthScale::Maximum(100.f, HealthScale::FromDump("0")),
               WithinAbs(20.0, 0.001));
}

TEST_CASE("Health points count against the scaled maximum", "[HealthScale]")
{
  // Unscaled: the base maximum bit for bit
  REQUIRE(HealthScale::Maximum(100.f, HealthScale::FromDump("null")) == 100.f);
  REQUIRE(HealthScale::Maximum(150.f, 1.f) == 150.f);
  // 20 damage on 100 health at a cold penalty of 40%: a third of the bar
  const float cold = HealthScale::Maximum(100.f, HealthScale::FromDump("0.6"));
  REQUIRE_THAT(cold, WithinAbs(60.0, 0.0001));
  REQUIRE_THAT(20.f / cold, WithinAbs(0.33333, 0.0001));
  // A 30 point potion restores half of that bar
  REQUIRE_THAT(30.f / cold, WithinAbs(0.5, 0.0001));
  // An Orc at the largest penalty of 80%
  REQUIRE_THAT(HealthScale::Maximum(150.f, HealthScale::FromDump("0.2")),
               WithinAbs(30.0, 0.0001));
}
