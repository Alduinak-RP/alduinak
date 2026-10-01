#include <catch2/catch_all.hpp>

#include "formulas/AlduinakHitMath.h"
#include "formulas/DurabilityRules.h"
#include <cmath>
#include <optional>
#include <string>

namespace {

using Catch::Matchers::WithinAbs;
using DurabilityRules::HitFacts;
using DurabilityRules::TargetWear;

constexpr double kEps = 1e-4;

// The defaults of the code are the numbers of durability design 3.1
AlduinakCombatSettings::Durability Settings()
{
  AlduinakCombatSettings::Durability d;
  d.enabled = true;
  return d;
}

// Wears one copy of hp points hit by hit, storing the condition as the server does
struct Copy
{
  float hp = 0.f;
  std::optional<float> condition;
  float carry = 0.f;
  bool broke = false;

  void Take(float points)
  {
    const auto after =
      DurabilityRules::ApplyWear(condition, points + carry, hp);
    condition = ConditionTag::Stored(after.condition);
    carry = after.carry;
    broke = broke || after.broke;
  }
};

}

TEST_CASE("The percent tag reads a condition as clients show it",
          "[Durability]")
{
  REQUIRE(ConditionTag::Percent(std::nullopt) == 100);
  REQUIRE(ConditionTag::Percent(1.f) == 100);
  REQUIRE(ConditionTag::Percent(0.97f) == 97);
  REQUIRE(ConditionTag::Percent(0.9799f) == 97);
  // 0.29 is 0.28999999 as a float, the stored step keeps it at 29
  REQUIRE(ConditionTag::Percent(0.29f) == 29);
  REQUIRE(ConditionTag::Percent(0.4f) == 40);
  REQUIRE(ConditionTag::Percent(0.0099f) == 1);
  REQUIRE(ConditionTag::Percent(0.0001f) == 1);
  REQUIRE(ConditionTag::Percent(0.f) == 0);
  REQUIRE(ConditionTag::Percent(-0.5f) == 0);
  REQUIRE(ConditionTag::Percent(0.00004f) == 0);

  REQUIRE(ConditionTag::IsBroken(0.f));
  REQUIRE_FALSE(ConditionTag::IsBroken(0.0001f));
  REQUIRE_FALSE(ConditionTag::IsBroken(std::nullopt));

  REQUIRE(ConditionTag::Tag(0.97f, "Broken") == "(97%)");
  REQUIRE(ConditionTag::Tag(std::nullopt, "Broken") == "(100%)");
  REQUIRE(ConditionTag::Tag(0.f, "Broken") == "(Broken)");
  REQUIRE(ConditionTag::Tag(0.f, "Kaputt") == "(Kaputt)");
}

TEST_CASE("A condition is stored in steps of 1e-4 and absent at 100%",
          "[Durability]")
{
  REQUIRE_FALSE(ConditionTag::Stored(1.f).has_value());
  REQUIRE_FALSE(ConditionTag::Stored(0.99996f).has_value());
  REQUIRE_FALSE(ConditionTag::Stored(1.5f).has_value());
  REQUIRE(ConditionTag::Stored(0.97143f) == std::optional<float>(0.9714f));
  REQUIRE(ConditionTag::Stored(0.f) == std::optional<float>(0.f));
  REQUIRE(ConditionTag::Stored(-1.f) == std::optional<float>(0.f));
  REQUIRE(ConditionTag::Rounded(std::nanf("")) == 1.f);
}

TEST_CASE("The tag of a described name is read back", "[Durability]")
{
  const std::string label = "Broken";
  const auto tag = [&](const char* name) {
    return ConditionTag::TagPercent(std::string(name), label);
  };
  REQUIRE(tag("Steel Sword (97%)") == std::optional<int>(97));
  REQUIRE(tag("Steel Sword (100%)") == std::optional<int>(100));
  REQUIRE(tag("Steel Sword (1%)") == std::optional<int>(1));
  REQUIRE(tag("Steel Sword (Broken)") == std::optional<int>(0));
  // The engine appends the quality after the tag
  REQUIRE(tag("Steel Sword (97%) (Fine)") == std::optional<int>(97));
  REQUIRE(tag("Steel Sword (Broken) (Legendary)") == std::optional<int>(0));
  // The last tag counts
  REQUIRE(tag("Sword (40%) (97%)") == std::optional<int>(97));
  REQUIRE_FALSE(tag("Steel Sword").has_value());
  REQUIRE_FALSE(tag("Steel Sword (Fine)").has_value());
  REQUIRE_FALSE(tag("Steel Sword (150%)").has_value());
  REQUIRE_FALSE(tag("Steel Sword (%)").has_value());
  REQUIRE_FALSE(tag("Steel Sword (9a%)").has_value());
  REQUIRE_FALSE(tag("Steel Sword 97%").has_value());
  REQUIRE_FALSE(tag("").has_value());
  REQUIRE_FALSE(tag(")(").has_value());
  REQUIRE_FALSE(ConditionTag::TagPercent(std::nullopt, label).has_value());
  REQUIRE(ConditionTag::TagPercent(std::string("Axe (Kaputt)"), "Kaputt") ==
          std::optional<int>(0));
  REQUIRE_FALSE(ConditionTag::TagPercent(std::string("Axe (Broken)"), "Kaputt")
                  .has_value());
}

TEST_CASE("eff(c) is 1 down to the knee and falls to effectAtZero",
          "[Durability]")
{
  const auto d = Settings();
  REQUIRE_THAT(DurabilityRules::Eff(d, 1.f), WithinAbs(1.0, kEps));
  REQUIRE_THAT(DurabilityRules::Eff(d, 0.5f), WithinAbs(1.0, kEps));
  REQUIRE_THAT(DurabilityRules::Eff(d, 0.25f), WithinAbs(0.875, kEps));
  REQUIRE_THAT(DurabilityRules::Eff(d, 0.1f), WithinAbs(0.8, kEps));
  REQUIRE_THAT(DurabilityRules::Eff(d, 0.0001f), WithinAbs(0.75005, kEps));

  auto flat = d;
  flat.effect.kneeCondition = 0.f;
  REQUIRE(DurabilityRules::Eff(flat, 0.1f) == 1.f);
}

TEST_CASE("A broken weapon deals 25% and broken armor gives no DT",
          "[Durability]")
{
  const auto d = Settings();

  const auto full = DurabilityRules::WeaponEffectOf(d, std::nullopt);
  REQUIRE(full.mult == 1.f);
  REQUIRE_FALSE(full.broken);

  const auto worn = DurabilityRules::WeaponEffectOf(d, 0.25f);
  REQUIRE_THAT(worn.mult, WithinAbs(0.875, kEps));
  REQUIRE_FALSE(worn.broken);

  const auto broken = DurabilityRules::WeaponEffectOf(d, 0.f);
  REQUIRE_THAT(broken.mult, WithinAbs(0.25, kEps));
  REQUIRE(broken.broken);

  REQUIRE(DurabilityRules::ArmorEffectOf(d, std::nullopt) == 1.f);
  REQUIRE_THAT(DurabilityRules::ArmorEffectOf(d, 0.1f), WithinAbs(0.8, kEps));
  REQUIRE(DurabilityRules::ArmorEffectOf(d, 0.f) == 0.f);
}

TEST_CASE("Condition scales the hit of the rebalance formula before DT",
          "[Durability]")
{
  AlduinakCombatSettings s;
  const auto& d = s.durability;

  // A Steel sword of 16.5 against a Steel set of 9.75 DT lands 6.75
  HitMath::Attack sword;
  sword.kind = HitMath::AttackKind::Melee;
  sword.type = ItemRows::WeaponType::Sword;
  sword.base = 16.5f;
  sword.critChance = 0.2f;
  sword.critMult = 1.5f;
  sword.floor = 0.2f;
  sword.powerMult = 2.f;
  HitMath::Target steel;
  steel.wornDT = 9.75f;

  const auto price = [&](const HitMath::Attack& attack, float roll) {
    return HitMath::PriceHit(s, attack, steel, {}, true, true, roll);
  };
  REQUIRE_THAT(price(sword, 0.9f).damage, WithinAbs(6.75, kEps));

  // At 25% the sword keeps 87.5%: 14.4375 - 9.75
  auto worn = sword;
  const auto wornEffect = DurabilityRules::WeaponEffectOf(d, 0.25f);
  worn.conditionMult = wornEffect.mult;
  worn.broken = wornEffect.broken;
  REQUIRE_THAT(price(worn, 0.9f).damage, WithinAbs(4.6875, kEps));
  REQUIRE(price(worn, 0.1f).crit);

  // Broken: 4.125 before DT, the floor of 20% and minDamage decide, no crit on any roll
  auto broken = sword;
  const auto brokenEffect = DurabilityRules::WeaponEffectOf(d, 0.f);
  broken.conditionMult = brokenEffect.mult;
  broken.broken = brokenEffect.broken;
  const auto brokenHit = price(broken, 0.f);
  REQUIRE_FALSE(brokenHit.crit);
  REQUIRE_THAT(brokenHit.preDT, WithinAbs(4.125, kEps));
  REQUIRE_THAT(brokenHit.damage, WithinAbs(0.825, kEps));

  // A dagger's sneak attack crits by rule, a broken one does not
  auto dagger = broken;
  dagger.autoCritOnSneak = true;
  HitMath::HitFlags sneak;
  sneak.sneak = true;
  REQUIRE_FALSE(
    HitMath::PriceHit(s, dagger, steel, sneak, true, true, 0.99f).crit);

  // Worn DT: a Steel cuirass of 5.85 at 10% gives 80%, a broken one nothing
  ItemRows::ItemRow cuirass;
  cuirass.kind = ItemRows::Kind::Armor;
  cuirass.dt = 5.85f;
  cuirass.slotShare = 0.6f;
  cuirass.buckets = 1;
  REQUIRE_THAT(HitMath::WornDT::PieceDT(
                 s, cuirass, 0, DurabilityRules::ArmorEffectOf(d, 0.1f)),
               WithinAbs(4.68, kEps));
  REQUIRE(HitMath::WornDT::PieceDT(
            s, cuirass, 0, DurabilityRules::ArmorEffectOf(d, 0.f)) == 0.f);
  // Temper and condition stack: Legendary (+9%) at 25% (87.5%)
  REQUIRE_THAT(HitMath::WornDT::PieceDT(
                 s, cuirass, 6, DurabilityRules::ArmorEffectOf(d, 0.25f)),
               WithinAbs(5.85 * 1.09 * 0.875, kEps));
}

TEST_CASE("A block with a broken shield or weapon lets half through",
          "[Durability]")
{
  const auto d = Settings();
  const float pass = d.effect.brokenBlockPass;
  // Player on player: 0 with an intact blocker, 50% with a broken one
  REQUIRE(HitMath::BlockedShare(0.f, 1.f, false, pass) == 0.f);
  REQUIRE_THAT(HitMath::BlockedShare(0.f, 1.f, true, pass),
               WithinAbs(0.5, kEps));
  // NPC on player: npcBlockedDamageShare 0.2, the larger of it and 50%
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 1.f, false, pass),
               WithinAbs(0.2, kEps));
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 1.f, true, pass),
               WithinAbs(0.5, kEps));
  // A weakened blocker (BlockMod x0.3) leaks 76% through an NPC's hit, more than the broken share
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 0.3f, true, pass),
               WithinAbs(0.76, kEps));
}

TEST_CASE("Wear points of the weapon that hit", "[Durability]")
{
  const auto w = Settings().wear;
  HitFacts plain;
  HitFacts power;
  power.power = true;
  HitFacts blocked;
  blocked.blocked = true;
  HitFacts blockedPower;
  blockedPower.blocked = true;
  blockedPower.power = true;
  HitFacts bash;
  bash.bash = true;

  REQUIRE(DurabilityRules::AggressorWear(w, false, plain) == 1.f);
  REQUIRE(DurabilityRules::AggressorWear(w, false, power) == 2.f);
  // A parried swing costs the parry point alone
  REQUIRE(DurabilityRules::AggressorWear(w, false, blocked) == 1.f);
  REQUIRE(DurabilityRules::AggressorWear(w, false, blockedPower) == 1.f);
  REQUIRE(DurabilityRules::AggressorWear(w, false, bash) == 1.f);
  // A bow wears per arrow that lands
  REQUIRE(DurabilityRules::AggressorWear(w, true, plain) == 1.f);
  REQUIRE(DurabilityRules::AggressorWear(w, true, blocked) == 0.f);

  auto custom = w;
  custom.landedHit = 2.f;
  custom.powerExtra = 3.f;
  custom.parriedHit = 0.5f;
  custom.bash = 4.f;
  custom.bowHit = 0.25f;
  REQUIRE(DurabilityRules::AggressorWear(custom, false, power) == 5.f);
  REQUIRE(DurabilityRules::AggressorWear(custom, false, blocked) == 0.5f);
  REQUIRE(DurabilityRules::AggressorWear(custom, false, bash) == 4.f);
  REQUIRE(DurabilityRules::AggressorWear(custom, true, plain) == 0.25f);
}

TEST_CASE("What a hit wears on the target's side", "[Durability]")
{
  const auto w = Settings().wear;
  HitFacts plain;
  HitFacts power;
  power.power = true;
  HitFacts blocked;
  blocked.blocked = true;
  HitFacts blockedPower;
  blockedPower.blocked = true;
  blockedPower.power = true;

  REQUIRE(DurabilityRules::TargetWearOf(w, blocked, true, 0.f) ==
          TargetWear::Shield);
  REQUIRE(DurabilityRules::TargetWearOf(w, blocked, false, 0.f) ==
          TargetWear::ParryingWeapon);
  // Fists at 5 never wear armor, a hit of 8 or more before DT does
  REQUIRE(DurabilityRules::TargetWearOf(w, plain, true, 5.f) ==
          TargetWear::None);
  REQUIRE(DurabilityRules::TargetWearOf(w, plain, false, 7.99f) ==
          TargetWear::None);
  REQUIRE(DurabilityRules::TargetWearOf(w, plain, false, 8.f) ==
          TargetWear::Armor);
  REQUIRE(DurabilityRules::TargetWearOf(w, plain, true, 16.5f) ==
          TargetWear::Armor);

  REQUIRE(DurabilityRules::ShieldWear(w, blocked) == 1.f);
  REQUIRE(DurabilityRules::ShieldWear(w, blockedPower) == 2.f);
  REQUIRE(DurabilityRules::ParryWear(w) == 1.f);
  REQUIRE(DurabilityRules::ArmorWear(w, plain) == 1.f);
  REQUIRE(DurabilityRules::ArmorWear(w, power) == 2.f);
}

TEST_CASE("A full set loses the same percent on every piece and absorbs its "
          "set HP",
          "[Durability]")
{
  // Steel: set HP 450, pieces 270 / 67.5 / 56.25 / 56.25
  const float setHP = 450.f;
  const float shares[] = { 0.6f, 0.15f, 0.125f, 0.125f };
  Copy pieces[4];
  for (int i = 0; i < 4; ++i) {
    pieces[i].hp = setHP * shares[i];
  }
  const auto hit = [&] {
    for (int i = 0; i < 4; ++i) {
      pieces[i].Take(DurabilityRules::ArmorPieceWear(1.f, shares[i], 1.f));
    }
  };

  for (int i = 0; i < 225; ++i) {
    hit();
  }
  for (const auto& piece : pieces) {
    REQUIRE(ConditionTag::Percent(piece.condition) == 50);
    REQUIRE_FALSE(piece.broke);
  }
  for (int i = 0; i < 224; ++i) {
    hit();
  }
  for (const auto& piece : pieces) {
    REQUIRE(ConditionTag::Percent(piece.condition) == 1);
    REQUIRE_FALSE(piece.broke);
  }
  hit();
  for (const auto& piece : pieces) {
    REQUIRE(ConditionTag::IsBroken(piece.condition));
    REQUIRE(piece.broke);
  }

  // A cuirass worn alone takes the whole hit: 270 hits
  REQUIRE_THAT(DurabilityRules::ArmorPieceWear(1.f, 0.6f, 0.6f),
               WithinAbs(1.0, kEps));
  // Nothing worn, nothing to spread
  REQUIRE(DurabilityRules::ArmorPieceWear(1.f, 0.6f, 0.f) == 0.f);
}

TEST_CASE("Weapon lifetimes of the design table", "[Durability]")
{
  const auto w = Settings().wear;
  HitFacts plain;
  HitFacts power;
  power.power = true;
  HitFacts blocked;
  blocked.blocked = true;

  // Landed hits until the copy breaks, 2 power hits in 25 (8%), one parried swing per three landed when parries is set
  const auto landedToBreak = [&](float hp, bool parries) {
    Copy copy;
    copy.hp = hp;
    int landed = 0;
    while (!copy.broke && landed < 100000) {
      const bool isPower = landed % 25 == 5 || landed % 25 == 17;
      copy.Take(
        DurabilityRules::AggressorWear(w, false, isPower ? power : plain));
      ++landed;
      if (parries && landed % 3 == 0 && !copy.broke) {
        copy.Take(DurabilityRules::AggressorWear(w, false, blocked));
      }
    }
    return landed;
  };

  // durability design 3.1: Wood 111 / 85, Iron 231 / 177, Steel 324 / 248, Daedric 648 / 496
  REQUIRE(std::abs(landedToBreak(120.f, false) - 111) <= 1);
  REQUIRE(std::abs(landedToBreak(250.f, false) - 231) <= 1);
  REQUIRE(std::abs(landedToBreak(350.f, false) - 324) <= 1);
  REQUIRE(std::abs(landedToBreak(700.f, false) - 648) <= 1);
  REQUIRE(std::abs(landedToBreak(120.f, true) - 85) <= 1);
  REQUIRE(std::abs(landedToBreak(250.f, true) - 177) <= 1);
  REQUIRE(std::abs(landedToBreak(350.f, true) - 248) <= 1);
  REQUIRE(std::abs(landedToBreak(700.f, true) - 496) <= 1);

  // A Steel shield of 450 x 0.8 holds 360 blocks
  Copy shield;
  shield.hp = 360.f;
  int blocks = 0;
  while (!shield.broke) {
    shield.Take(DurabilityRules::ShieldWear(w, blocked));
    ++blocks;
  }
  REQUIRE(blocks == 360);
}

TEST_CASE("ApplyWear rounds what it stores and carries the rest",
          "[Durability]")
{
  // One point of a Steel sword's 350
  const auto first = DurabilityRules::ApplyWear(std::nullopt, 1.f, 350.f);
  REQUIRE(first.condition == 0.9971f);
  REQUIRE_FALSE(first.broke);
  // 1 - 1/350 is 0.997143, the 0.000043 the rounding took is owed back
  REQUIRE_THAT(first.carry, WithinAbs(-0.015, 1e-3));

  const auto broke = DurabilityRules::ApplyWear(0.002f, 1.f, 350.f);
  REQUIRE(broke.condition == 0.f);
  REQUIRE(broke.broke);
  REQUIRE(broke.carry == 0.f);

  // An already broken copy does not break again
  const auto again = DurabilityRules::ApplyWear(0.f, 5.f, 350.f);
  REQUIRE(again.condition == 0.f);
  REQUIRE_FALSE(again.broke);

  // No HP, no wear
  const auto none = DurabilityRules::ApplyWear(0.5f, 10.f, 0.f);
  REQUIRE(none.condition == 0.5f);
  REQUIRE_FALSE(none.broke);

  // The carried rounding never drifts: 350 single points end exactly at 0
  Copy copy;
  copy.hp = 350.f;
  for (int i = 0; i < 349; ++i) {
    copy.Take(1.f);
  }
  REQUIRE_FALSE(copy.broke);
  REQUIRE(ConditionTag::Percent(copy.condition) == 1);
  copy.Take(1.f);
  REQUIRE(copy.broke);
}

TEST_CASE("A flush waits for a moved percent and minSeconds", "[Durability]")
{
  const auto d = Settings();
  // Steel sword, 350 HP: 3 points keep 100% -> 99% hidden until the fourth
  REQUIRE(DurabilityRules::PercentChanges(std::nullopt, 1.f, 350.f));
  REQUIRE_FALSE(DurabilityRules::PercentChanges(0.9971f, 1.f, 350.f));
  REQUIRE_FALSE(DurabilityRules::PercentChanges(0.9971f, 2.f, 350.f));
  REQUIRE(DurabilityRules::PercentChanges(0.9971f, 3.f, 350.f));
  REQUIRE_FALSE(DurabilityRules::PercentChanges(0.9971f, 0.f, 350.f));
  REQUIRE_FALSE(DurabilityRules::PercentChanges(0.9971f, -0.2f, 350.f));
  // The last step to broken always shows
  REQUIRE(DurabilityRules::PercentChanges(0.0029f, 1.f, 350.f));

  REQUIRE(DurabilityRules::FlushDue(d, true, 5.f));
  REQUIRE(DurabilityRules::FlushDue(d, true, 60.f));
  REQUIRE_FALSE(DurabilityRules::FlushDue(d, true, 4.9f));
  REQUIRE_FALSE(DurabilityRules::FlushDue(d, false, 60.f));
}
