#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <chrono>

#include "GetBaseActorValues.h"
#include "HitData.h"
#include "PacketParser.h"
#include "condition_functions/ConditionFunctionFactory.h"
#include "formulas/TES5DamageFormula.h"
#include "libespm/Loader.h"

namespace {
const auto kExtraWornTrue = [] {
  Inventory::ExtraData extra;
  extra.worn_ = true;
  return extra;
}();
const auto kExtraWornFalse = [] {
  Inventory::ExtraData extra;
  extra.worn_ = false;
  return extra;
}();
}

PartOne& GetPartOne();
extern espm::Loader l;
using namespace std::chrono_literals;

TEST_CASE("Formula takes weapon damage into account", "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  ac.SetEquipment(Equipment());

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitData hitData;
  hitData.target = 0x14;
  hitData.aggressor = 0x14;
  hitData.source = 0x0001397E; // iron dagger 4 damage

  TES5DamageFormula formula{};
  REQUIRE(formula.CalculateDamage(ac, ac, hitData) == 4.0f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Damage is reduced based on target's armor", "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitData hitData;
  hitData.target = 0x14;
  hitData.aggressor = 0x14;
  hitData.source = 0x0001397E; // iron dagger 4 damage

  // 77382 = 0x12e46: Iron Gauntlets, rating = 10
  // 77387 = 0x12e4b: Iron Boots, rating = 10
  // 77389 = 0x12e4d: Iron Helmet, rating = 15
  // Total rating for worn armor: 10 + 10 = 20

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(77382, 1, kExtraWornTrue));
  eq.inv.entries.push_back(Inventory::Entry(77387, 1, kExtraWornTrue));
  eq.inv.entries.push_back(Inventory::Entry(77389, 1, kExtraWornFalse));
  ac.SetEquipment(eq);

  TES5DamageFormula formula{};
  // 4 * 0.01 * (100 - 20 * .12) = 3,904
  REQUIRE(formula.CalculateDamage(ac, ac, hitData) == 3.903999805f);

  auto repeatativeEntry = Inventory::Entry(77382, 1, kExtraWornTrue);
  Equipment eq2;

  for (int i = 0; i < 70; i++) {
    eq2.inv.entries.push_back(repeatativeEntry);
  }

  // Total rating for worn armor: 10 * 70 = 700
  ac.SetEquipment(eq2);

  // Armor rating is 700 * 0.12% = 84%
  // But fMaxArmorRating = 80%
  // 4 * 0.01 * (100 - 80) = 4 * 0.2 = 0.8
  REQUIRE(formula.CalculateDamage(ac, ac, hitData) == 0.7999999523f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Enchanted armor from a plugin loaded past its master count counts",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  HitData hitData;
  hitData.target = 0x14;
  hitData.aggressor = 0x14;
  hitData.source = 0x0001397E; // iron dagger 4 damage

  // Dragonborn Acolyte Mask, rating 23: its raw enchantment 0x020250E1 loads as 0x040250E1
  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(0x040240FE, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  TES5DamageFormula formula{};
  // 4 * 0.01 * (100 - 23 * .12) = 3.8896
  REQUIRE(formula.CalculateDamage(ac, ac, hitData) == Catch::Approx(3.8896f));

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Spell damage sums the hostile Health effects of a spell",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  TES5DamageFormula formula{};
  SpellCastData spellCastData{};

  spellCastData.spell = 0x0001C789; // Fireball, 40 fire damage
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 40.f);

  spellCastData.spell = 0x0002B96C; // Ice Spike, 25 frost damage plus a slow
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 25.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Spell damage from a plugin loaded past its master count counts",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  TES5DamageFormula formula{};
  SpellCastData spellCastData{};

  // Dragonborn Freeze: its raw effect 0x0202732E loads as 0x0402732E, 20 frost damage
  spellCastData.spell = 0x0402732D;
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 20.f);

  // Frost Breath 1: Dragonborn overrides it, raw effect 0x02020E96 loads as 0x04020E96
  spellCastData.spell = 0x0005D172;
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 10.f);

  spellCastData.spell = 0x0001397E; // iron dagger, not a SPEL
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 0.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Spell damage skips effects whose conditions the server cannot "
          "evaluate",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  p.worldState.conditionFunctionMap =
    ConditionFunctionFactory::CreateConditionFunctions();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  TES5DamageFormula formula{};
  SpellCastData spellCastData{};

  // Below 15% health, but the Disintegrate rider (+200) also needs HasPerk and HasKeyword
  ac.SetPercentages({ 0.1f, 1.f, 1.f });

  spellCastData.spell = 0x0002DD2A; // Sparks, 8 shock damage
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 8.f);

  spellCastData.spell = 0x0002DD29; // Lightning Bolt, 25 shock damage
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 25.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Spell damage of unconditional spells and shouts is unchanged",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  p.worldState.conditionFunctionMap =
    ConditionFunctionFactory::CreateConditionFunctions();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  TES5DamageFormula formula{};
  SpellCastData spellCastData{};

  spellCastData.spell = 0x00012FCD; // Flames, 8 fire damage
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 8.f);

  spellCastData.spell = 0x00012FD0; // Firebolt, 25 fire damage
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 25.f);

  // Unrelenting Force 3: 10 plus the conditional 40 from Dragonborn
  spellCastData.spell = 0x00013F3A;
  REQUIRE(formula.CalculateDamage(ac, ac, spellCastData) == 50.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Spell damage counts a conditional effect when its conditions hold",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  p.worldState.conditionFunctionMap =
    ConditionFunctionFactory::CreateConditionFunctions();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  p.CreateActor(0xff000001, { 0, 0, 0 }, 0, 0x3c);
  auto& caster = p.worldState.GetFormAt<MpActor>(0xff000000);
  auto& target = p.worldState.GetFormAt<MpActor>(0xff000001);

  TES5DamageFormula formula{};
  SpellCastData spellCastData{};

  // Labyrinthian reward spell: 25 damage while the actor hit has less than full Magicka
  spellCastData.spell = 0x000DA746;
  caster.SetPercentages({ 1.f, 0.5f, 1.f });
  target.SetPercentages({ 1.f, 1.f, 1.f });
  REQUIRE(formula.CalculateDamage(caster, target, spellCastData) == 0.f);

  target.SetPercentages({ 1.f, 0.5f, 1.f });
  REQUIRE(formula.CalculateDamage(caster, target, spellCastData) == 25.f);

  p.DestroyActor(0xff000001);
  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("Formula is race-dependent for unarmed attack",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  // Nord bu default
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  ac.SetEquipment(Equipment());

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitData hitData;
  hitData.target = 0x14;
  hitData.aggressor = 0x14;
  hitData.source = 0x1f4; // unarmed attack

  {
    TES5DamageFormula formula{};
    REQUIRE(formula.CalculateDamage(ac, ac, hitData) == 4.0f);
  }

  Appearance appearance;
  appearance.raceId = 0x13745; // KhajiitRace
  ac.SetAppearance(&appearance);
  ac.SetPercentages({ 1, 1, 1 });

  {
    TES5DamageFormula formula{};
    REQUIRE(formula.CalculateDamage(ac, ac, hitData) == 10.0f);
  }

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}
