#include <catch2/catch_all.hpp>

#include "formulas/AlduinakHitMath.h"
#include <nlohmann/json.hpp>

namespace {

using Catch::Matchers::WithinAbs;
using HitMath::Attack;
using HitMath::AttackKind;
using HitMath::HitFlags;
using HitMath::Target;
using HitMath::WornDT;
using ItemRows::WeaponType;

// A cut of the generated block with the plan's numbers
std::shared_ptr<const AlduinakCombatSettings> Settings()
{
  const auto block = nlohmann::json::parse(R"({
    "source": "test",
    "enabled": true,
    "weaponTypes": {
      "dagger": {"speed": 1.3, "hands": 1, "dmgMult": 0.67, "critChance": 0.3, "critMult": 2.0, "penetration": 0.0,
                 "powerMult": 2.0, "sneakMult": 2.0, "floor": 0.2, "autoCritOnSneak": true},
      "sword": {"speed": 1.0, "hands": 1, "dmgMult": 1.0, "critChance": 0.2, "critMult": 1.5, "powerMult": 2.0,
                "sneakMult": 1.5, "floor": 0.2},
      "waraxe": {"speed": 0.9, "hands": 1, "dmgMult": 1.05, "critChance": 0.12, "critMult": 2.0, "powerMult": 2.0,
                 "sneakMult": 1.5, "floor": 0.2},
      "mace": {"speed": 0.8, "hands": 1, "dmgMult": 1.1, "critChance": 0.05, "critMult": 1.5, "penetration": 0.15,
               "powerMult": 2.0, "sneakMult": 1.5, "floor": 0.2},
      "greatsword": {"speed": 0.7, "hands": 2, "dmgMult": 1.17, "critChance": 0.12, "critMult": 1.5,
                     "powerMult": 2.0, "sneakMult": 1.25, "floor": 0.2},
      "battleaxe": {"speed": 0.7, "hands": 2, "dmgMult": 1.12, "critChance": 0.12, "critMult": 2.0,
                    "powerMult": 2.0, "sneakMult": 1.25, "floor": 0.2},
      "warhammer": {"speed": 0.6, "hands": 2, "dmgMult": 1.2, "critChance": 0.05, "critMult": 1.5,
                    "penetration": 0.15, "powerMult": 2.0, "sneakMult": 1.25, "floor": 0.2},
      "bow": {"hands": 2, "dmgMult": 1.0, "critChance": 0.1, "critMult": 1.5, "powerMult": 1.0, "sneakMult": 1.5,
              "floor": 0.2},
      "crossbow": {"speed": 1.0, "hands": 2, "dmgMult": 1.0, "critChance": 0.08, "critMult": 1.5,
                   "penetration": 0.5, "powerMult": 1.0, "sneakMult": 1.5, "floor": 0.2},
      "unarmed": {"speed": 1.0, "hands": 1, "dmgMult": 1.0, "critChance": 0.05, "critMult": 1.5,
                  "penetration": 0.5, "powerMult": 2.0, "sneakMult": 1.5, "floor": 0.5}
    },
    "weapons": {
      "Wood": {"base": 10.0}, "Iron": {"base": 15.0}, "Draugr": {"base": 15.5}, "Steel": {"base": 16.5},
      "Orcish": {"base": 18.5}, "Dwarven": {"base": 18.0, "penetration": 0.1},
      "Elven": {"base": 17.5, "critChance": 0.05}, "Glass": {"base": 19.0, "critChance": 0.05},
      "Ebony": {"base": 20.0}, "Daedric": {"base": 21.5}
    },
    "bows": {"Long": {"base": 13.25, "speed": 1.0}, "Hunting": {"base": 14.75, "speed": 0.9375},
             "Daedric": {"base": 20.25, "speed": 0.5}},
    "crossbows": {"Crossbow": {"base": 10.5}, "Dwarven": {"base": 11.75}},
    "unarmed": {
      "base": 5.0, "penetration": 0.5, "floor": 0.5, "critChance": 0.05, "critMult": 1.5,
      "raceOverride": {"KhajiitRace": {"weaponRow": "Steel", "type": "dagger"},
                       "ArgonianRace": {"weaponRow": "Iron", "type": "dagger"}}
    },
    "armor": {
      "Fur": {"class": "light", "setDT": 5.25}, "Hide": {"class": "light", "setDT": 6.0},
      "Forsworn": {"class": "light", "setDT": 6.25}, "Leather": {"class": "light", "setDT": 9.5},
      "Iron": {"class": "heavy", "setDT": 7.5}, "Steel": {"class": "heavy", "setDT": 9.75},
      "Orcish": {"class": "heavy", "setDT": 12.25}, "Daedric": {"class": "heavy", "setDT": 15.0}
    },
    "weaponKeywords": [["WeapMaterialSteel", "Steel"]],
    "armorKeywords": [["ArmorMaterialSteel", "Steel"]],
    "fallbackRows": {"weapon": "Iron", "bow": "Long", "crossbow": "Crossbow", "armorLight": "Fur",
                     "armorHeavy": "Iron", "shield": "Iron"}
  })");
  std::vector<std::string> problems, warnings;
  auto settings = AlduinakCombatSettings::FromJson(block, problems, warnings);
  INFO((problems.empty() ? std::string() : problems[0]));
  REQUIRE(settings);
  return settings;
}

constexpr uint8_t kSword = 1, kDagger = 2, kWarAxe = 3, kMace = 4,
                  kGreatsword = 5, kTwoHandAxe = 6, kBow = 7, kStaff = 8,
                  kCrossbow = 9;

Attack Melee(const AlduinakCombatSettings& s, uint8_t animType,
             const std::string& row, int temperStep = 0,
             float recordSpeed = 0.f, bool warhammer = false)
{
  std::vector<std::string> keywords;
  if (warhammer) {
    keywords.push_back("WeapTypeWarhammer");
  }
  const auto item = ItemRows::ClassifyWeapon(s, { animType, keywords, row });
  return HitMath::WeaponAttack(s, item, recordSpeed, temperStep, -1.f);
}

Attack Shooter(const AlduinakCombatSettings& s, uint8_t animType,
               const std::string& row, float ammoDamage)
{
  const auto item = ItemRows::ClassifyWeapon(s, { animType, {}, row });
  return HitMath::WeaponAttack(s, item, 0.f, 0, ammoDamage);
}

ItemRows::ItemRow Piece(const AlduinakCombatSettings& s,
                        const std::string& row, uint32_t slot,
                        uint32_t armorType = 1)
{
  return ItemRows::ClassifyArmor(s,
                                 { armorType, 1u << (slot - 30), {}, row });
}

// Cuirass, helmet, gauntlets and boots of one row, a shield of the same row when asked
float SetDT(const AlduinakCombatSettings& s, const std::string& row,
            bool shield = false, int temperStep = 0)
{
  const bool heavy = s.armor.at(row).cls == ItemRows::ArmorClass::Heavy;
  WornDT worn;
  for (uint32_t slot : { 32u, 30u, 33u, 37u }) {
    worn.Add(s, Piece(s, row, slot, heavy ? 1 : 0), temperStep);
  }
  if (shield) {
    worn.Add(s, Piece(s, row, 39, heavy ? 1 : 0), temperStep);
  }
  return worn.Total();
}

// A player's hit on a player, capped like the server caps it
float Damage(const AlduinakCombatSettings& s, const Attack& attack,
             float wornDT, HitFlags flags = {}, bool crit = false)
{
  const auto hit = HitMath::PriceHit(s, attack, { wornDT, 0.f, true }, flags,
                                     true, true, crit ? 0.f : 1.f);
  return HitMath::CapPlayerHit(s, hit.damage, true);
}

constexpr double kEps = 1e-4;

}

TEST_CASE("The plan's hand checks", "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;

  const float steel = SetDT(s, "Steel");
  const float daedricShield = SetDT(s, "Daedric", true);
  REQUIRE_THAT(steel, WithinAbs(9.75, kEps));
  REQUIRE_THAT(daedricShield, WithinAbs(15.9, kEps));
  REQUIRE_THAT(SetDT(s, "Hide"), WithinAbs(6.0, kEps));
  REQUIRE_THAT(SetDT(s, "Orcish", false, 4), WithinAbs(12.985, kEps));

  const auto steelSword = Melee(s, kSword, "Steel");
  REQUIRE_THAT(Damage(s, steelSword, steel), WithinAbs(6.75, kEps));
  REQUIRE_THAT(Damage(s, steelSword, steel, {}, true),
               WithinAbs(19.875, kEps));
  REQUIRE_THAT(Damage(s, steelSword, steel, { true, false, false }),
               WithinAbs(13.5, kEps));

  const auto ironDagger = Melee(s, kDagger, "Iron");
  REQUIRE_THAT(Damage(s, ironDagger, daedricShield), WithinAbs(2.01, kEps));
  REQUIRE_THAT(Damage(s, ironDagger, daedricShield, {}, true),
               WithinAbs(12.15, kEps));
  REQUIRE_THAT(Damage(s, ironDagger, daedricShield, { false, true, true }),
               WithinAbs(1.206, kEps));

  REQUIRE_THAT(
    Damage(s, Melee(s, kMace, "Ebony", 5), SetDT(s, "Orcish", false, 4)),
    WithinAbs(12.6127, kEps));
  REQUIRE_THAT(Damage(s, Melee(s, kWarAxe, "Steel", 0, 2.f), steel),
               WithinAbs(3.4087, kEps));
  REQUIRE_THAT(Damage(s, HitMath::UnarmedAttack(s), steel),
               WithinAbs(2.5, kEps));

  // Creatures: a wolf's 5, a giant's 60
  const auto wolf = HitMath::NaturalAttack(s, 5.f);
  const auto giant = HitMath::NaturalAttack(s, 60.f);
  const auto bite = HitMath::PriceHit(s, wolf, { SetDT(s, "Hide"), 0.f, true },
                                      {}, false, false, 0.f);
  REQUIRE_THAT(bite.damage, WithinAbs(2.0, kEps));
  REQUIRE(!bite.crit);
  const auto club = HitMath::PriceHit(s, giant, { daedricShield, 0.f, true },
                                      {}, false, false, 0.f);
  REQUIRE_THAT(club.damage, WithinAbs(29.1, kEps));
  REQUIRE_THAT(club.preDT, WithinAbs(45.0, kEps));
  const auto stomp = HitMath::PriceHit(s, giant, { 0.f, 0.f, true },
                                       { true, false, false }, false, false,
                                       0.f);
  REQUIRE_THAT(stomp.damage, WithinAbs(56.25, kEps));
  REQUIRE_THAT(HitMath::CapPlayerHit(s, stomp.damage, true),
               WithinAbs(45.0, kEps));

  // Poison comes after the plain worn DT and never loses more than half
  const float ironSword = Damage(s, Melee(s, kSword, "Iron"), steel);
  REQUIRE_THAT(ironSword + HitMath::PoisonAfterDT(s, 20.f, steel),
               WithinAbs(15.5, kEps));
  REQUIRE_THAT(HitMath::PoisonAfterDT(s, 10.f, steel), WithinAbs(5.0, kEps));
  REQUIRE(HitMath::PoisonAfterDT(s, 0.f, steel) == 0.f);

  REQUIRE_THAT(Damage(s, Melee(s, kTwoHandAxe, "Daedric", 0, 0.f, true),
                      SetDT(s, "Hide"), { true, false, false }, true),
               WithinAbs(45.0, kEps));
  REQUIRE_THAT(Damage(s, Shooter(s, kCrossbow, "Crossbow", 10.f), steel),
               WithinAbs(6.125, kEps));

  // A player on a bear with 2 natural DT
  const auto bear = HitMath::PriceHit(s, steelSword, { 0.f, 2.f, false }, {},
                                      true, true, 1.f);
  REQUIRE_THAT(bear.damage, WithinAbs(14.5, kEps));
}

TEST_CASE("Crits roll against the chance and never on a bash",
          "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  const auto sword = Melee(s, kSword, "Steel");
  const Target target{ 9.75f, 0.f, true };

  REQUIRE(HitMath::PriceHit(s, sword, target, {}, true, true, 0.19f).crit);
  REQUIRE(!HitMath::PriceHit(s, sword, target, {}, true, true, 0.2f).crit);
  REQUIRE(!HitMath::PriceHit(s, sword, target, {}, true, false, 0.f).crit);
  REQUIRE(!HitMath::PriceHit(s, sword, target, { false, false, true }, true,
                             true, 0.f)
             .crit);

  // Elven and Glass add 5 points, the dagger's 30 with them stays under the 40 cap
  REQUIRE_THAT(Melee(s, kSword, "Elven").critChance, WithinAbs(0.25, 1e-6));
  REQUIRE_THAT(Melee(s, kDagger, "Glass").critChance, WithinAbs(0.35, 1e-6));
  REQUIRE(Melee(s, kDagger, "Glass").critChance <= HitMath::kCritChanceCap);

  // A dagger's sneak attack is a crit without a roll, a sword's is not
  const auto dagger = Melee(s, kDagger, "Iron");
  const auto opener = HitMath::PriceHit(s, dagger, { 0.f, 0.f, true },
                                        { false, true, false }, true, true,
                                        1.f);
  REQUIRE(opener.crit);
  REQUIRE_THAT(opener.damage, WithinAbs(40.2, kEps));
  REQUIRE(!HitMath::PriceHit(s, sword, target, { false, true, false }, true,
                             true, 1.f)
             .crit);
  // A broken weapon never crits
  auto broken = dagger;
  broken.broken = true;
  broken.conditionMult = 0.25f;
  const auto dull = HitMath::PriceHit(s, broken, { 0.f, 0.f, true },
                                      { false, true, false }, true, true, 0.f);
  REQUIRE(!dull.crit);
  REQUIRE_THAT(dull.preDT, WithinAbs(10.05 * 0.25, kEps));
}

TEST_CASE("Power and sneak come after DT and do not stack",
          "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  const auto greatsword = Melee(s, kGreatsword, "Steel");
  const float steel = SetDT(s, "Steel");
  const float normal = Damage(s, greatsword, steel);
  REQUIRE_THAT(normal, WithinAbs(16.5 * 1.17 - 9.75, kEps));
  REQUIRE_THAT(Damage(s, greatsword, steel, { true, false, false }),
               WithinAbs(normal * 2.0, kEps));
  REQUIRE_THAT(Damage(s, greatsword, steel, { false, true, false }),
               WithinAbs(normal * 1.25, kEps));
  REQUIRE_THAT(Damage(s, greatsword, steel, { true, true, false }),
               WithinAbs(normal * 2.0, kEps));
  // A bow has no power attack
  const auto bow = Shooter(s, kBow, "Hunting", 10.f);
  REQUIRE_THAT(bow.base, WithinAbs(15.25, kEps));
  REQUIRE_THAT(Damage(s, bow, steel, { true, false, false }),
               WithinAbs(Damage(s, bow, steel), kEps));
  // A creature's power attack is x1.25
  const auto bear = HitMath::NaturalAttack(s, 30.f);
  const auto swipe = HitMath::PriceHit(s, bear, { steel, 0.f, true },
                                       { true, false, false }, false, false,
                                       1.f);
  REQUIRE_THAT(swipe.damage, WithinAbs((30.0 - 9.75) * 1.25, kEps));
}

TEST_CASE("The floor, the minimum and penetration", "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  const float daedricShield = SetDT(s, "Daedric", true);
  // 20 percent of the hit always lands
  REQUIRE_THAT(Damage(s, Melee(s, kSword, "Iron"), daedricShield),
               WithinAbs(3.0, kEps));
  // A mace ignores 15 percent of DT, a Dwarven one 25
  REQUIRE_THAT(Damage(s, Melee(s, kMace, "Steel"), daedricShield),
               WithinAbs(18.15 - 15.9 * 0.85, kEps));
  REQUIRE_THAT(Damage(s, Melee(s, kMace, "Dwarven"), daedricShield),
               WithinAbs(19.8 - 15.9 * 0.75, kEps));
  // Fists keep half, a critter bites through half of DT and keeps 30 percent
  REQUIRE_THAT(Damage(s, HitMath::UnarmedAttack(s), daedricShield),
               WithinAbs(2.5, kEps));
  const auto wolf = HitMath::NaturalAttack(s, 5.f);
  REQUIRE_THAT(wolf.penetration, WithinAbs(0.5, 1e-6));
  REQUIRE_THAT(HitMath::NaturalAttack(s, 25.f).penetration,
               WithinAbs(0.0, 1e-6));
  REQUIRE_THAT(HitMath::PriceHit(s, wolf, { daedricShield, 0.f, true }, {},
                                 false, false, 1.f)
                 .damage,
               WithinAbs(1.5, kEps));
  // Nothing that has a row lands for less than minDamage
  const auto weak = HitMath::NaturalAttack(s, 1.f);
  REQUIRE_THAT(HitMath::PriceHit(s, weak, { daedricShield, 0.f, true }, {},
                                 false, false, 1.f)
                 .damage,
               WithinAbs(0.5, kEps));
  // A staff and a dummy row deal nothing
  const auto staff = ItemRows::ClassifyWeapon(s, { kStaff, {}, {} });
  const auto none = HitMath::WeaponAttack(s, staff, 1.f, 0, -1.f);
  REQUIRE(none.kind == AttackKind::None);
  const auto ignored =
    HitMath::PriceHit(s, none, { 0.f, 0.f, true }, {}, true, true, 0.f);
  REQUIRE(ignored.ignored);
  REQUIRE(ignored.damage == 0.f);
  const auto dummy = ItemRows::ClassifyWeapon(
    s, { kSword, {}, std::optional<std::string>("Dummy") });
  REQUIRE(HitMath::WeaponAttack(s, dummy, 1.f, 0, -1.f).kind ==
          AttackKind::None);
}

TEST_CASE("Worn DT takes the best piece per slot and the shield",
          "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  WornDT worn;
  REQUIRE(worn.Total() == 0.f);
  // Two head pieces: the higher one counts
  worn.Add(s, Piece(s, "Steel", 30), 0);
  worn.Add(s, Piece(s, "Daedric", 42), 0);
  REQUIRE_THAT(worn.Total(), WithinAbs(15.0 * 0.15, kEps));
  worn.Add(s, Piece(s, "Steel", 32), 2);
  REQUIRE_THAT(worn.Total(), WithinAbs(2.25 + 5.85 * 1.03, kEps));
  // A light record on a heavy row gives 70 percent
  WornDT light;
  light.Add(s, Piece(s, "Steel", 32, 0), 0);
  REQUIRE_THAT(light.Total(), WithinAbs(5.85 * 0.7, kEps));
  // The shield counts 6 percent of its row whether raised or not
  WornDT shield;
  shield.Add(s, Piece(s, "Daedric", 39), 0);
  REQUIRE_THAT(shield.Total(), WithinAbs(0.9, kEps));
  shield.Add(s, Piece(s, "Steel", 39), 6);
  REQUIRE_THAT(shield.Total(), WithinAbs(0.9, kEps));
  // Clothing and a weapon add nothing, a condition share scales a piece
  WornDT other;
  other.Add(s, ItemRows::ClassifyArmor(s, { 2u, 1u << 2, {}, {} }), 3);
  other.Add(s, ItemRows::ClassifyWeapon(s, { kSword, {}, {} }), 3);
  REQUIRE(other.Total() == 0.f);
  other.Add(s, Piece(s, "Steel", 32), 0, 0.5f);
  REQUIRE_THAT(other.Total(), WithinAbs(5.85 * 0.5, kEps));
  REQUIRE_THAT(WornDT::PieceDT(s, Piece(s, "Steel", 32), 6),
               WithinAbs(5.85 * 1.09, kEps));
}

TEST_CASE("Temper steps, arrows and record speeds", "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  REQUIRE(HitMath::TemperStep(1.f) == 0);
  REQUIRE(HitMath::TemperStep(1.1f) == 1);
  REQUIRE(HitMath::TemperStep(1.3f) == 3);
  REQUIRE(HitMath::TemperStep(1.6f) == 6);
  REQUIRE(HitMath::TemperStep(5.f) == 6);
  REQUIRE(HitMath::TemperStep(0.4f) == 0);
  REQUIRE(HitMath::TemperStep(std::nanf("")) == 0);
  REQUIRE_THAT(Damage(s, Melee(s, kSword, "Steel", 5), 0.f),
               WithinAbs(16.5 * 1.075, kEps));

  REQUIRE(HitMath::ArrowBonus(s, 8.f) == 0.f);
  REQUIRE(HitMath::ArrowBonus(s, 7.f) == 0.f);
  REQUIRE_THAT(HitMath::ArrowBonus(s, 10.f), WithinAbs(0.5, kEps));
  REQUIRE_THAT(HitMath::ArrowBonus(s, 24.f), WithinAbs(4.0, kEps));
  REQUIRE_THAT(HitMath::ArrowBonus(s, 1000.f), WithinAbs(4.0, kEps));
  // No arrow seen: the bow's own base
  REQUIRE_THAT(Shooter(s, kBow, "Long", -1.f).base, WithinAbs(13.25, kEps));
  REQUIRE_THAT(Shooter(s, kBow, "Daedric", 24.f).base,
               WithinAbs(24.25, kEps));

  // A faster record deals its row's damage per second, a slower one the row's per hit
  REQUIRE_THAT(Melee(s, kWarAxe, "Steel", 0, 2.f).speedFactor,
               WithinAbs(0.45, kEps));
  REQUIRE_THAT(Melee(s, kSword, "Iron", 0, 5.f).speedFactor,
               WithinAbs(0.4, kEps));
  REQUIRE_THAT(Melee(s, kDagger, "Ebony", 0, 1.f).speedFactor,
               WithinAbs(1.0, kEps));
  REQUIRE_THAT(Melee(s, kSword, "Iron", 0, 0.f).speedFactor,
               WithinAbs(1.0, kEps));
  const auto hunting = ItemRows::ClassifyWeapon(
    s, { kBow, {}, std::optional<std::string>("Hunting") });
  REQUIRE_THAT(HitMath::WeaponAttack(s, hunting, 1.f, 0, 8.f).speedFactor,
               WithinAbs(1.5 / (0.5 + 1.0 / 0.9375), kEps));

  // The melee rate limit: 0.888 of the type's swing
  REQUIRE_THAT(HitMath::MeleeInterval(s, Melee(s, kDagger, "Iron")),
               WithinAbs(0.5922, kEps));
  REQUIRE_THAT(HitMath::MeleeInterval(s, Melee(s, kSword, "Iron")),
               WithinAbs(0.7699, kEps));
  REQUIRE_THAT(HitMath::MeleeInterval(s, Melee(s, kGreatsword, "Iron")),
               WithinAbs(0.9590, kEps));
  REQUIRE_THAT(HitMath::MeleeInterval(
                 s, Melee(s, kTwoHandAxe, "Iron", 0, 0.f, true)),
               WithinAbs(1.1189, kEps));
  REQUIRE_THAT(HitMath::MeleeInterval(s, HitMath::UnarmedAttack(s)),
               WithinAbs(0.7699, kEps));
  REQUIRE_THAT(HitMath::MeleeInterval(s, Melee(s, kWarAxe, "Steel", 0, 2.f)),
               WithinAbs(0.888 * 0.867 / 0.9 * 0.45, kEps));
}

TEST_CASE("Claws hit as the dagger of their row at the fist's timing",
          "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  const auto khajiit =
    HitMath::ClawAttack(s, ItemRows::ClawRow(s, s.raceOverride.at("KhajiitRace")));
  REQUIRE(khajiit.kind == AttackKind::Unarmed);
  REQUIRE(khajiit.type == WeaponType::Dagger);
  REQUIRE_THAT(khajiit.base, WithinAbs(11.055, kEps));
  REQUIRE_THAT(khajiit.critChance, WithinAbs(0.3, 1e-6));
  REQUIRE_THAT(khajiit.floor, WithinAbs(0.2, 1e-6));
  REQUIRE(khajiit.penetration == 0.f);
  REQUIRE(khajiit.autoCritOnSneak);
  REQUIRE(khajiit.temperStep == 0);
  REQUIRE(khajiit.speedFactor == 1.f);
  REQUIRE_THAT(khajiit.cycle, WithinAbs(0.867, kEps));
  const auto argonian = HitMath::ClawAttack(
    s, ItemRows::ClawRow(s, s.raceOverride.at("ArgonianRace")));
  REQUIRE_THAT(argonian.base, WithinAbs(10.05, kEps));
  REQUIRE_THAT(Damage(s, argonian, SetDT(s, "Steel")),
               WithinAbs(2.01, kEps));
}

TEST_CASE("A block stops a player's hit and leaks a share of an NPC's",
          "[AlduinakDamage]")
{
  REQUIRE(HitMath::BlockedShare(0.f, 1.f) == 0.f);
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 1.f), WithinAbs(0.2, 1e-6));
  // Weakened blocks at 70 percent
  REQUIRE_THAT(HitMath::BlockedShare(0.f, 0.7f), WithinAbs(0.3, 1e-6));
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 0.7f), WithinAbs(0.44, 1e-6));
  // A broken shield passes at least brokenBlockPass
  REQUIRE_THAT(HitMath::BlockedShare(0.f, 1.f, true, 0.5f),
               WithinAbs(0.5, 1e-6));
  REQUIRE_THAT(HitMath::BlockedShare(0.2f, 1.f, true, 0.5f),
               WithinAbs(0.5, 1e-6));
  REQUIRE_THAT(HitMath::BlockedShare(0.8f, 1.f, true, 0.5f),
               WithinAbs(0.8, 1e-6));
}

TEST_CASE("The cap and the snap", "[AlduinakDamage]")
{
  const auto settings = Settings();
  const auto& s = *settings;
  REQUIRE(HitMath::CapPlayerHit(s, 77.f, true) == 45.f);
  REQUIRE(HitMath::CapPlayerHit(s, 77.f, false) == 77.f);
  REQUIRE(HitMath::CapPlayerHit(s, 12.f, true) == 12.f);
  // An NPC takes the whole hit
  const auto hammer = Melee(s, kTwoHandAxe, "Daedric", 0, 0.f, true);
  const auto smash = HitMath::PriceHit(s, hammer, { 0.f, 0.f, false },
                                       { true, false, false }, true, true,
                                       0.f);
  REQUIRE_THAT(smash.damage, WithinAbs(25.8 * 1.5 * 2.0, kEps));

  REQUIRE(HitMath::SnapHealth(s, 0.00011f) == 0.f);
  REQUIRE(HitMath::SnapHealth(s, 0.0001f) == 0.f);
  REQUIRE(HitMath::SnapHealth(s, -0.2f) == 0.f);
  REQUIRE(HitMath::SnapHealth(s, 0.0002f) == 0.0002f);

  // Nine Ancient Nord battleaxe hits of 11.11 on Forsworn down 100 health in float32
  const float hit = Damage(s, Melee(s, kTwoHandAxe, "Draugr"),
                           SetDT(s, "Forsworn"));
  REQUIRE_THAT(hit, WithinAbs(11.11, kEps));
  float health = 1.f;
  for (int i = 0; i < 9; ++i) {
    REQUIRE(health > 0.f);
    health = HitMath::SnapHealth(s, health - hit / 100.f);
  }
  REQUIRE(health == 0.f);
}
