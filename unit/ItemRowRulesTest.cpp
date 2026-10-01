#include <catch2/catch_all.hpp>

#include "formulas/ItemRowRules.h"
#include <nlohmann/json.hpp>

namespace {

using Catch::Matchers::WithinAbs;
using ItemRows::Kind;
using ItemRows::SlotBucket;
using ItemRows::WeaponType;

// A cut of the generated block with the plan's numbers
nlohmann::json ValidBlock()
{
  return nlohmann::json::parse(R"({
    "source": "test",
    "enabled": false,
    "shieldShare": 0.06,
    "lightItemHeavyRowFactor": 0.7,
    "weaponTypes": {
      "dagger": {"speed": 1.3, "hands": 1, "dmgMult": 0.67, "critChance": 0.3, "critMult": 2.0, "sneakMult": 2.0, "autoCritOnSneak": true},
      "sword": {"speed": 1.0, "hands": 1, "dmgMult": 1.0, "critChance": 0.2},
      "waraxe": {"speed": 0.9, "dmgMult": 1.05},
      "mace": {"speed": 0.8, "dmgMult": 1.1, "penetration": 0.15},
      "greatsword": {"speed": 0.7, "hands": 2, "dmgMult": 1.17},
      "battleaxe": {"speed": 0.7, "hands": 2, "dmgMult": 1.12},
      "warhammer": {"speed": 0.6, "hands": 2, "dmgMult": 1.2, "penetration": 0.15},
      "bow": {"hands": 2, "dmgMult": 1.0, "powerMult": 1.0},
      "crossbow": {"speed": 1.0, "hands": 2, "dmgMult": 1.0, "penetration": 0.5},
      "unarmed": {"speed": 1.0, "dmgMult": 1.0, "penetration": 0.5, "floor": 0.5}
    },
    "weapons": {
      "Wood": {"base": 10.0}, "Iron": {"base": 15.0}, "Steel": {"base": 16.5}, "Draugr": {"base": 15.5},
      "DraugrHoned": {"base": 17.5}, "Dwarven": {"base": 18.0, "penetration": 0.1},
      "Elven": {"base": 17.5, "critChance": 0.05}, "Ebony": {"base": 20.0}, "Daedric": {"base": 21.5}
    },
    "dummyRow": "Dummy",
    "bows": {
      "Long": {"base": 13.25, "speed": 1.0}, "Hunting": {"base": 14.75, "speed": 0.9375},
      "Ebony": {"base": 18.75, "speed": 0.5625}, "Daedric": {"base": 20.25, "speed": 0.5}
    },
    "bowRowForMaterial": {"Iron": "Long", "Wood": "Long", "Steel": "Hunting"},
    "crossbows": {"Crossbow": {"base": 10.5}, "Dwarven": {"base": 11.75}},
    "unarmed": {
      "base": 5.0,
      "raceOverride": {
        "KhajiitRace": {"weaponRow": "Steel", "type": "dagger"},
        "ArgonianRace": {"weaponRow": "Iron", "type": "dagger"}
      }
    },
    "armor": {
      "Clothing": {"class": "clothing", "setDT": 0},
      "Fur": {"class": "light", "setDT": 5.25},
      "Leather": {"class": "light", "setDT": 9.5},
      "Iron": {"class": "heavy", "setDT": 7.5},
      "Steel": {"class": "heavy", "setDT": 9.75},
      "SteelPlate": {"class": "heavy", "setDT": 10.75},
      "Daedric": {"class": "heavy", "setDT": 15.0},
      "GuardShield": {"class": "heavy", "setDT": 0, "shieldDT": 0.27}
    },
    "slotShare": {"cuirass": 0.6, "helmet": 0.15, "gauntlets": 0.125, "boots": 0.125},
    "slotBipeds": {"cuirass": [32], "helmet": [30, 31, 41, 42, 43], "gauntlets": [33], "boots": [37], "shield": [39]},
    "weaponKeywords": [["WeapMaterialDraugrHoned", "DraugrHoned"], ["WeapMaterialDraugr", "Draugr"],
                       ["WeapMaterialDaedric", "Daedric"], ["WeapMaterialEbony", "Ebony"],
                       ["WeapMaterialDwarven", "Dwarven"], ["WeapMaterialSteel", "Steel"],
                       ["WeapMaterialIron", "Iron"], ["WeapMaterialWood", "Wood"]],
    "armorKeywords": [["ArmorMaterialDaedric", "Daedric"], ["ArmorMaterialSteelPlate", "SteelPlate"],
                      ["ArmorMaterialSteel", "Steel"], ["ArmorMaterialIron", "Iron"],
                      ["ArmorMaterialLeather", "Leather"], ["IAKMaterialSteel", "Steel"],
                      ["IAKMaterialIron", "Iron"], ["IAKMaterialLeather", "Leather"]],
    "aldCatMat": [["AldCatMat_Steel", "Steel"], ["AldCatMat_Leather", "Leather"], ["AldCatMat_Wood", "Wood"]],
    "multiIAKFallback": 3,
    "fallbackRows": {"weapon": "Iron", "bow": "Long", "crossbow": "Crossbow", "armorLight": "Fur",
                     "armorHeavy": "Iron", "shield": "Iron"},
    "overrides": {"e3c16:Skyrim.esm": "Wood", "1019ca:Skyrim.esm": "Iron", "800:RihadSwordsmanSet.esl": "Dummy"},
    "npc": {"naturalDT": {"131f8:Skyrim.esm": 1.0, "131f1:Skyrim.esm": 8.0}},
    "durability": {
      "enabled": true,
      "weaponHP": {"Wood": 120, "Iron": 250, "Steel": 350, "Draugr": 250, "DraugrHoned": 400, "Dwarven": 550,
                   "Elven": 350, "Ebony": 650, "Daedric": 700},
      "bowHP": {"Long": 250, "Hunting": 350, "Ebony": 650, "Daedric": 700},
      "crossbowHP": {"Crossbow": 450, "Dwarven": 550},
      "armorSetHP": {"Fur": 150, "Leather": 280, "Iron": 350, "Steel": 450, "SteelPlate": 480, "Daedric": 700,
                     "GuardShield": 200},
      "shieldHPShare": 0.8,
      "fallbackHP": {"weapon": 250, "armorSet": 300},
      "exempt": ["12eb7:Skyrim.esm"],
      "repair": {"fallbackMaterial": {"weapon": {"Iron": "5ace4:Skyrim.esm"}, "armor": {"Leather": "db5d2:Skyrim.esm"}}}
    }
  })");
}

std::shared_ptr<const AlduinakCombatSettings> Parsed(
  const nlohmann::json& block)
{
  std::vector<std::string> problems, warnings;
  auto settings = AlduinakCombatSettings::FromJson(block, problems, warnings);
  INFO((problems.empty() ? std::string() : problems[0]));
  REQUIRE(problems.empty());
  REQUIRE(settings);
  return settings;
}

// The first problem FromJson reports, the block must be rejected
std::string Rejected(const nlohmann::json& block)
{
  std::vector<std::string> problems, warnings;
  REQUIRE(!AlduinakCombatSettings::FromJson(block, problems, warnings));
  REQUIRE(!problems.empty());
  return problems[0];
}

ItemRows::ItemRow Weapon(const AlduinakCombatSettings& s, uint8_t animType,
                         std::vector<std::string> keywords,
                         std::optional<std::string> overrideRow = {})
{
  return ItemRows::ClassifyWeapon(s, { animType, keywords, overrideRow });
}

ItemRows::ItemRow Armor(const AlduinakCombatSettings& s,
                        std::optional<uint32_t> armorType, uint32_t slot,
                        std::vector<std::string> keywords,
                        std::optional<std::string> overrideRow = {})
{
  return ItemRows::ClassifyArmor(
    s, { armorType, slot ? 1u << (slot - 30) : 0u, keywords, overrideRow });
}

constexpr uint8_t kSword = 1, kDagger = 2, kTwoHandAxe = 6, kBow = 7,
                  kStaff = 8, kCrossbow = 9;
constexpr uint32_t kLight = 0, kHeavy = 1, kClothing = 2;

}

TEST_CASE("The settings block parses into rows and tables", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());
  REQUIRE(!s->enabled);
  REQUIRE(s->durability.enabled);
  REQUIRE(s->weapons.size() == 9);
  REQUIRE(s->weapons.at("Dwarven").penetration == 0.1f);
  REQUIRE(s->weapons.at("Elven").critChance == 0.05f);
  REQUIRE(s->bows.at("Hunting").speed == 0.9375f);
  REQUIRE(s->crossbows.at("Dwarven").base == 11.75f);
  REQUIRE(s->TypeRow(WeaponType::Dagger).dmgMult == 0.67f);
  REQUIRE(s->TypeRow(WeaponType::Dagger).autoCritOnSneak);
  REQUIRE(s->TypeRow(WeaponType::Warhammer).hands == 2);
  // Keys a type leaves out take the block's own values
  REQUIRE(s->TypeRow(WeaponType::Sword).powerMult == 2.f);
  REQUIRE(s->TypeRow(WeaponType::Sword).floor == 0.2f);
  REQUIRE(s->TypeRow(WeaponType::Bow).powerMult == 1.f);
  REQUIRE(s->TypeRow(WeaponType::Unarmed).floor == 0.5f);
  REQUIRE(s->armor.at("GuardShield").shieldDT == 0.27f);
  REQUIRE(!s->armor.at("Steel").shieldDT);
  REQUIRE(s->weaponKeywords.front().first == "WeapMaterialDraugrHoned");
  REQUIRE(s->overrides.at("e3c16:Skyrim.esm") == "Wood");
  REQUIRE(s->raceOverride.at("KhajiitRace").weaponRow == "Steel");
  REQUIRE(s->raceOverride.at("KhajiitRace").type == WeaponType::Dagger);
  REQUIRE(s->naturalDT.at("131f1:Skyrim.esm") == 8.f);
  REQUIRE(s->durability.weaponHP.at("Daedric") == 700.f);
  REQUIRE(s->durability.exempt.size() == 1);
  REQUIRE(s->durability.repair.fallbackMaterial.at("armor").at("Leather") ==
          "db5d2:Skyrim.esm");
  // Helmet slots 30, 31, 41, 42, 43 and the shield slot 39
  REQUIRE(s->slotMasks[static_cast<size_t>(SlotBucket::Helmet)] == 0x3803u);
  REQUIRE(s->slotMasks[static_cast<size_t>(SlotBucket::Shield)] == 0x200u);
}

TEST_CASE("Defaults are the plan's numbers", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());
  REQUIRE(s->floor == 0.2f);
  REQUIRE(s->minDamage == 0.5f);
  REQUIRE(s->critDTMult == 0.5f);
  REQUIRE(s->bashMult == 0.3f);
  REQUIRE(s->playerHitCap == 45.f);
  REQUIRE(s->healthSnap == 0.00011f);
  REQUIRE(s->temperingWeaponPerStep == 0.015f);
  REQUIRE(s->powerLogOnly);
  REQUIRE(s->effectModifiers);
  REQUIRE(s->durability.wear.armorMinPreDT == 8.f);
  REQUIRE(s->durability.effect.brokenWeaponMult == 0.25f);
  REQUIRE(s->durability.effect.brokenBlockPass == 0.5f);
  REQUIRE(s->durability.nameTagBrokenLabel == "Broken");
  REQUIRE(s->durability.repair.chatCommand == "repair");
}

TEST_CASE("A malformed block is rejected with the key it trips on",
          "[ItemRows]")
{
  REQUIRE_THAT(Rejected(nlohmann::json::array()),
               Catch::Matchers::ContainsSubstring("should be an object"));

  auto block = ValidBlock();
  block.erase("weapons");
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("weapons is missing"));

  block = ValidBlock();
  block["enabled"] = "true";
  REQUIRE_THAT(
    Rejected(block),
    Catch::Matchers::ContainsSubstring("enabled should be true or"));

  block = ValidBlock();
  block["weapons"]["Steel"]["base"] = "16.5";
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("weapons.Steel.base"));

  block = ValidBlock();
  block["weaponTypes"].erase("mace");
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("weaponTypes.mace"));

  block = ValidBlock();
  block["weaponTypes"]["sword"].erase("dmgMult");
  REQUIRE_THAT(
    Rejected(block),
    Catch::Matchers::ContainsSubstring("weaponTypes.sword.dmgMult"));

  block = ValidBlock();
  block["armorKeywords"].push_back({ "ArmorMaterialGlass", "Glass" });
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("ArmorMaterialGlass"));

  block = ValidBlock();
  block["weaponKeywords"][0] = "WeapMaterialDraugrHoned";
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("weaponKeywords[0]"));

  block = ValidBlock();
  block["fallbackRows"]["armorLight"] = "Hide";
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("fallbackRows.armorLight"));

  block = ValidBlock();
  block["overrides"]["Skyrim.esm"] = "Iron";
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("overrides entry"));

  block = ValidBlock();
  block["overrides"]["13986:Skyrim.esm"] = "Mithril";
  REQUIRE_THAT(Rejected(block), Catch::Matchers::ContainsSubstring("Mithril"));

  // The old number table of the claws
  block = ValidBlock();
  block["unarmed"]["raceOverride"]["KhajiitRace"] = 7;
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("raceOverride.KhajiitRace"));

  block = ValidBlock();
  block["unarmed"]["raceOverride"]["KhajiitRace"]["type"] = "bow";
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("melee type"));

  block = ValidBlock();
  block["durability"]["weaponHP"]["Steel"] = 0;
  REQUIRE_THAT(
    Rejected(block),
    Catch::Matchers::ContainsSubstring("durability.weaponHP.Steel"));

  block = ValidBlock();
  block["durability"]["enabled"] = 1;
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("durability.enabled"));

  block = ValidBlock();
  block["slotBipeds"]["helmet"] = { 30, 99 };
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("slotBipeds.helmet"));

  block = ValidBlock();
  block["npc"]["naturalDT"]["WolfRace"] = 1;
  REQUIRE_THAT(Rejected(block),
               Catch::Matchers::ContainsSubstring("npc.naturalDT"));
}

TEST_CASE("Warnings never reject the block", "[ItemRows]")
{
  auto block = ValidBlock();
  block["enabeld"] = true;
  block["durability"]["weaponHP"].erase("Wood");
  std::vector<std::string> problems, warnings;
  auto s = AlduinakCombatSettings::FromJson(block, problems, warnings);
  REQUIRE(s);
  REQUIRE(problems.empty());
  REQUIRE(warnings.size() == 2);
  REQUIRE_THAT(warnings[0], Catch::Matchers::ContainsSubstring("enabeld"));
  REQUIRE_THAT(warnings[1], Catch::Matchers::ContainsSubstring("Wood"));
}

TEST_CASE("Weapons price by row and type", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());

  auto sword = Weapon(*s, kSword, { "WeapMaterialSteel" });
  REQUIRE(sword.kind == Kind::Weapon);
  REQUIRE(sword.type == WeaponType::Sword);
  REQUIRE(sword.row == "Steel");
  REQUIRE(sword.rule == "keyword");
  REQUIRE(!sword.fallback);
  REQUIRE_THAT(sword.damage, WithinAbs(16.5, 0.0001));
  REQUIRE(sword.speed == 1.f);
  REQUIRE(sword.hp == 350.f);

  // Iron dagger 10.05 and Steel dagger 11.055, the plan's claw values
  REQUIRE_THAT(Weapon(*s, kDagger, { "WeapMaterialIron" }).damage,
               WithinAbs(10.05, 0.0001));
  REQUIRE_THAT(Weapon(*s, kDagger, { "WeapMaterialSteel" }).damage,
               WithinAbs(11.055, 0.0001));

  auto hammer =
    Weapon(*s, kTwoHandAxe, { "WeapTypeWarhammer", "WeapMaterialDaedric" });
  REQUIRE(hammer.type == WeaponType::Warhammer);
  REQUIRE_THAT(hammer.damage, WithinAbs(25.8, 0.0001));
  REQUIRE(hammer.speed == 0.6f);
  REQUIRE(hammer.hp == 700.f);

  auto axe = Weapon(*s, kTwoHandAxe, { "WeapMaterialDwarven" });
  REQUIRE(axe.type == WeaponType::Battleaxe);
  REQUIRE_THAT(axe.damage, WithinAbs(20.16, 0.0001));
  REQUIRE(axe.penetration == 0.1f);
}

TEST_CASE("The row comes from the override, then keywords in list order, "
          "then AldCatMat, then the fallback",
          "[ItemRows]")
{
  auto s = Parsed(ValidBlock());

  auto tool = Weapon(*s, kSword, { "WeapMaterialSteel" }, "Wood");
  REQUIRE(tool.row == "Wood");
  REQUIRE(tool.rule == "override");
  REQUIRE(tool.hp == 120.f);

  // Honed is listed before Draugr, the record's own keyword order does not count
  auto honed =
    Weapon(*s, kSword, { "WeapMaterialDraugr", "WeapMaterialDraugrHoned" });
  REQUIRE(honed.row == "DraugrHoned");

  auto own = Weapon(*s, kSword, { "AldCatMat_Steel" });
  REQUIRE(own.row == "Steel");
  REQUIRE(own.rule == "AldCatMat");

  auto bare = Weapon(*s, kSword, {});
  REQUIRE(bare.row == "Iron");
  REQUIRE(bare.rule == "fallback");
  REQUIRE(bare.fallback);
  REQUIRE_THAT(bare.damage, WithinAbs(15.0, 0.0001));

  // AldCatMat_Leather is an armor row, a weapon falls back from it
  auto odd = Weapon(*s, kSword, { "AldCatMat_Leather" });
  REQUIRE(odd.row == "Iron");
  REQUIRE(odd.rule == "AldCatMat -> fallback");
  REQUIRE(odd.fallback);

  auto dummy = Weapon(*s, kSword, { "WeapMaterialSteel" }, "Dummy");
  REQUIRE(dummy.kind == Kind::Dummy);
  REQUIRE(dummy.damage == 0.f);
  REQUIRE(dummy.hp == 0.f);

  auto staff = Weapon(*s, kStaff, { "WeapMaterialDaedric" }, "Daedric");
  REQUIRE(staff.kind == Kind::Staff);
  REQUIRE(staff.row.empty());
  REQUIRE(staff.hp == 0.f);

  auto fists = Weapon(*s, 0, {});
  REQUIRE(fists.kind == Kind::Unarmed);
  REQUIRE(fists.damage == 5.f);

  REQUIRE(Weapon(*s, 12, {}).kind == Kind::None);
}

TEST_CASE("Bows and crossbows take their own rows", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());

  auto hunting = Weapon(*s, kBow, { "WeapMaterialSteel" });
  REQUIRE(hunting.kind == Kind::Bow);
  REQUIRE(hunting.row == "Hunting");
  REQUIRE(hunting.rule == "keyword");
  REQUIRE(hunting.damage == 14.75f);
  REQUIRE(hunting.speed == 0.9375f);
  REQUIRE(hunting.hp == 350.f);

  auto ebony = Weapon(*s, kBow, { "WeapMaterialSteel" }, "Ebony");
  REQUIRE(ebony.row == "Ebony");
  REQUIRE(ebony.damage == 18.75f);

  // Dwarven has no bow row and no mapping in this cut
  auto fallback = Weapon(*s, kBow, { "WeapMaterialDwarven" });
  REQUIRE(fallback.row == "Long");
  REQUIRE(fallback.rule == "keyword -> fallback");
  REQUIRE(fallback.fallback);

  auto steel = Weapon(*s, kCrossbow, { "WeapMaterialSteel" });
  REQUIRE(steel.kind == Kind::Crossbow);
  REQUIRE(steel.row == "Crossbow");
  REQUIRE(steel.damage == 10.5f);
  REQUIRE(steel.hp == 450.f);
  REQUIRE(!steel.fallback);

  auto dwarven = Weapon(*s, kCrossbow, { "WeapMaterialDwarven" });
  REQUIRE(dwarven.row == "Dwarven");
  REQUIRE(dwarven.damage == 11.75f);
  REQUIRE(dwarven.hp == 550.f);

  // The audit may move a crossbow between the crossbow rows
  REQUIRE(Weapon(*s, kCrossbow, { "WeapMaterialDwarven" }, "Crossbow").row ==
          "Crossbow");
}

TEST_CASE("Armor pieces share the set DT and HP by slot", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());

  auto cuirass = Armor(*s, kHeavy, 32, { "ArmorMaterialSteel" });
  REQUIRE(cuirass.kind == Kind::Armor);
  REQUIRE(cuirass.row == "Steel");
  REQUIRE(cuirass.armorClass == ItemRows::ArmorClass::Heavy);
  REQUIRE(cuirass.Covers(SlotBucket::Cuirass));
  REQUIRE(!cuirass.Covers(SlotBucket::Helmet));
  REQUIRE_THAT(cuirass.dt, WithinAbs(5.85, 0.0001));
  REQUIRE_THAT(cuirass.hp, WithinAbs(270.0, 0.001));

  auto helmet = Armor(*s, kHeavy, 31, { "ArmorMaterialSteel" });
  auto circlet = Armor(*s, kHeavy, 42, { "ArmorMaterialSteel" });
  auto gauntlets = Armor(*s, kHeavy, 33, { "ArmorMaterialSteel" });
  auto boots = Armor(*s, kHeavy, 37, { "ArmorMaterialSteel" });
  REQUIRE(helmet.Covers(SlotBucket::Helmet));
  REQUIRE(circlet.Covers(SlotBucket::Helmet));
  REQUIRE_THAT(helmet.dt, WithinAbs(1.4625, 0.0001));
  REQUIRE_THAT(helmet.hp, WithinAbs(67.5, 0.001));
  REQUIRE_THAT(gauntlets.dt, WithinAbs(1.21875, 0.0001));
  REQUIRE_THAT(boots.hp, WithinAbs(56.25, 0.001));
  // A full Steel set is the 9.75 the plan's Steel sword hits for 6.75
  REQUIRE_THAT(cuirass.dt + helmet.dt + gauntlets.dt + boots.dt,
               WithinAbs(9.75, 0.0001));

  auto shield = Armor(*s, kHeavy, 39, { "ArmorMaterialDaedric" });
  REQUIRE(shield.kind == Kind::Shield);
  REQUIRE(shield.Covers(SlotBucket::Shield));
  REQUIRE(shield.slotShare == 0.f);
  // Daedric set 15 plus its shield 0.9, the plan's 15.9
  REQUIRE_THAT(shield.dt, WithinAbs(0.9, 0.0001));
  REQUIRE_THAT(shield.hp, WithinAbs(560.0, 0.001));

  // A shield by keyword alone
  REQUIRE(Armor(*s, kHeavy, 0, { "ArmorShield", "ArmorMaterialIron" }).kind ==
          Kind::Shield);

  auto guard = Armor(*s, kHeavy, 39, {}, "GuardShield");
  REQUIRE_THAT(guard.dt, WithinAbs(0.27, 0.0001));
  REQUIRE_THAT(guard.hp, WithinAbs(160.0, 0.001));

  // A light record on a heavy row keeps 70% of the row
  auto light = Armor(*s, kLight, 32, { "ArmorMaterialSteel" });
  REQUIRE(light.lightOnHeavy);
  REQUIRE_THAT(light.dt, WithinAbs(4.095, 0.0001));
  REQUIRE_THAT(light.hp, WithinAbs(270.0, 0.001));

  // A piece on a slot no bucket names gives no DT and never wears
  auto cape = Armor(*s, kLight, 46, { "ArmorMaterialLeather" });
  REQUIRE(cape.kind == Kind::Armor);
  REQUIRE(cape.buckets == 0);
  REQUIRE(cape.dt == 0.f);
  REQUIRE(cape.hp == 0.f);
}

TEST_CASE("Armor rows resolve like the generator's classifier", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());

  // Clothing is decided before any override
  auto robe = Armor(*s, kClothing, 32, { "ArmorMaterialDaedric" }, "Daedric");
  REQUIRE(robe.kind == Kind::Clothing);
  REQUIRE(robe.row.empty());
  REQUIRE(robe.dt == 0.f);
  REQUIRE(Armor(*s, kLight, 35, { "ArmorJewelry" }).kind == Kind::Clothing);
  REQUIRE(Armor(*s, kHeavy, 32, {}, "Clothing").kind == Kind::Clothing);

  auto multi =
    Armor(*s, kHeavy, 32,
          { "IAKMaterialSteel", "IAKMaterialIron", "IAKMaterialLeather" });
  REQUIRE(multi.row == "Iron");
  REQUIRE(multi.rule == "fallback(IA multi)");
  REQUIRE(multi.fallback);

  auto two = Armor(*s, kHeavy, 32, { "IAKMaterialIron", "IAKMaterialSteel" });
  REQUIRE(two.row == "Steel");
  REQUIRE(two.rule == "keyword");

  auto plate =
    Armor(*s, kHeavy, 32, { "ArmorMaterialSteel", "ArmorMaterialSteelPlate" });
  REQUIRE(plate.row == "SteelPlate");

  auto bareLight = Armor(*s, kLight, 32, {});
  REQUIRE(bareLight.row == "Fur");
  REQUIRE(bareLight.fallback);
  REQUIRE_THAT(bareLight.hp, WithinAbs(90.0, 0.001));
  REQUIRE(Armor(*s, kHeavy, 32, {}).row == "Iron");
  REQUIRE(Armor(*s, {}, 32, {}).row == "Fur");
  REQUIRE(Armor(*s, kLight, 39, {}).row == "Iron");

  auto audited = Armor(*s, kHeavy, 37, { "ArmorMaterialDaedric" }, "Iron");
  REQUIRE(audited.row == "Iron");
  REQUIRE(audited.rule == "override");
  REQUIRE_THAT(audited.dt, WithinAbs(0.9375, 0.0001));

  auto own = Armor(*s, kLight, 33, { "AldCatMat_Leather" });
  REQUIRE(own.row == "Leather");
  REQUIRE(own.rule == "AldCatMat");
  REQUIRE_THAT(own.hp, WithinAbs(35.0, 0.001));
}

TEST_CASE("Claw races hit as the dagger of their row", "[ItemRows]")
{
  auto s = Parsed(ValidBlock());
  auto khajiit = ItemRows::ClawRow(*s, s->raceOverride.at("KhajiitRace"));
  REQUIRE(khajiit.kind == Kind::Weapon);
  REQUIRE(khajiit.type == WeaponType::Dagger);
  REQUIRE(khajiit.row == "Steel");
  REQUIRE_THAT(khajiit.damage, WithinAbs(11.055, 0.0001));
  REQUIRE(khajiit.speed == 1.3f);
  REQUIRE(khajiit.hp == 0.f);
  auto argonian = ItemRows::ClawRow(*s, s->raceOverride.at("ArgonianRace"));
  REQUIRE_THAT(argonian.damage, WithinAbs(10.05, 0.0001));
}
