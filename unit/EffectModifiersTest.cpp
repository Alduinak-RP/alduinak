#include <catch2/catch_all.hpp>

#include "formulas/EffectModifiers.h"
#include <limits>

TEST_CASE("Effect modifier sums clamp between a quarter and double",
          "[EffectModifiers]")
{
  REQUIRE(EffectModifierMult(0.f) == 1.f);
  REQUIRE_THAT(EffectModifierMult(-30.f),
               Catch::Matchers::WithinAbs(0.7, 0.0001));
  REQUIRE_THAT(EffectModifierMult(-25.f),
               Catch::Matchers::WithinAbs(0.75, 0.0001));
  REQUIRE_THAT(EffectModifierMult(-55.f),
               Catch::Matchers::WithinAbs(0.45, 0.0001));
  REQUIRE(EffectModifierMult(-75.f) == 0.25f);
  REQUIRE(EffectModifierMult(-90.f) == 0.25f);
  REQUIRE(EffectModifierMult(-500.f) == 0.25f);
  REQUIRE_THAT(EffectModifierMult(40.f),
               Catch::Matchers::WithinAbs(1.4, 0.0001));
  REQUIRE(EffectModifierMult(100.f) == 2.f);
  REQUIRE(EffectModifierMult(350.f) == 2.f);
  REQUIRE(EffectModifierMult(std::numeric_limits<float>::quiet_NaN()) == 1.f);
  REQUIRE(EffectModifierMult(std::numeric_limits<float>::infinity()) == 1.f);
}

TEST_CASE("A block modifier scales the blocked part of a hit",
          "[EffectModifiers]")
{
  // Untouched shares stay bit for bit
  REQUIRE(BlockedPassShare(0.f, 1.f) == 0.f);
  REQUIRE(BlockedPassShare(0.2f, 1.f) == 0.2f);
  REQUIRE(BlockedPassShare(0.37f, 1.f) == 0.37f);

  // Weakened, block -30: a player's hit leaks 30%, an NPC's 44%
  REQUIRE_THAT(BlockedPassShare(0.f, 0.7f),
               Catch::Matchers::WithinAbs(0.3, 0.0001));
  REQUIRE_THAT(BlockedPassShare(0.2f, 0.7f),
               Catch::Matchers::WithinAbs(0.44, 0.0001));

  // The floor of a quarter block
  REQUIRE_THAT(BlockedPassShare(0.f, 0.25f),
               Catch::Matchers::WithinAbs(0.75, 0.0001));
  REQUIRE_THAT(BlockedPassShare(0.2f, 0.25f),
               Catch::Matchers::WithinAbs(0.8, 0.0001));

  // A better block never lets less than nothing through
  REQUIRE(BlockedPassShare(0.f, 2.f) == 0.f);
  REQUIRE(BlockedPassShare(0.2f, 1.25f) == 0.f);
  REQUIRE(BlockedPassShare(0.2f, 2.f) == 0.f);
  REQUIRE_THAT(BlockedPassShare(0.2f, 1.1f),
               Catch::Matchers::WithinAbs(0.12, 0.0001));
  REQUIRE(BlockedPassShare(1.f, 0.5f) == 1.f);
}

TEST_CASE("Effect modifiers need the settings block and one of its switches",
          "[EffectModifiers]")
{
  REQUIRE(!EffectModifiersActive(false, true, true, true));
  REQUIRE(!EffectModifiersActive(true, false, false, true));
  REQUIRE(!EffectModifiersActive(true, true, true, false));
  REQUIRE(EffectModifiersActive(true, true, false, true));
  REQUIRE(EffectModifiersActive(true, false, true, true));
  REQUIRE(EffectModifiersActive(true, true, true, true));
}
