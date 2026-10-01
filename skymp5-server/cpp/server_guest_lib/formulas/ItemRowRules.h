#pragma once
#include "AlduinakCombatSettings.h"
#include <algorithm>
#include <optional>
#include <string>
#include <vector>

// The rebalance's item classifier, the same rules as misc/combat-settings/classify.py
namespace ItemRows {

enum class Kind : uint8_t
{
  None,
  Weapon,
  Bow,
  Crossbow,
  Staff,
  Unarmed,
  Dummy,
  Armor,
  Shield,
  Clothing
};

inline const char* KindName(Kind kind) noexcept
{
  switch (kind) {
    case Kind::Weapon:
      return "weapon";
    case Kind::Bow:
      return "bow";
    case Kind::Crossbow:
      return "crossbow";
    case Kind::Staff:
      return "staff";
    case Kind::Unarmed:
      return "unarmed";
    case Kind::Dummy:
      return "dummy";
    case Kind::Armor:
      return "armor";
    case Kind::Shield:
      return "shield";
    case Kind::Clothing:
      return "clothing";
    default:
      return "none";
  }
}

// The settings row of one WEAP or ARMO base with the numbers that follow from it
struct ItemRow
{
  Kind kind = Kind::None;
  WeaponType type = WeaponType::None;
  // Class of the armor row, not of the record
  ArmorClass armorClass = ArmorClass::None;
  // Empty for a staff, fists, clothing and anything that is no weapon or armor
  std::string row;
  // How the row was found: override, keyword, AldCatMat, a fallback or a fixed rule
  std::string rule;
  bool fallback = false;

  // Untempered damage before DT: row base x type dmgMult for melee, the row base for bows and crossbows
  float damage = 0.f;
  // Standard speed of the type, of the row for a bow
  float speed = 0.f;
  // Material traits of the weapons row, added to the type's own values
  float penetration = 0.f;
  float critChance = 0.f;

  // Bit per SlotBucket this piece covers
  uint8_t buckets = 0;
  // Sum of slotShare over the covered buckets, 0 for a shield
  float slotShare = 0.f;
  // A light record on a heavy row counts lightItemHeavyRowFactor of the row
  bool lightOnHeavy = false;
  // Untempered DT of this piece at full condition
  float dt = 0.f;

  // HP of one copy at 100%, 0 for what never wears
  float hp = 0.f;

  [[nodiscard]] bool Covers(SlotBucket bucket) const noexcept
  {
    return (buckets & (1u << static_cast<unsigned>(bucket))) != 0;
  }
};

struct WeaponFacts
{
  // WEAP DNAM animation type, 0 without a DNAM
  uint8_t animType = 0;
  // Editor ids of the record's keywords
  std::vector<std::string> keywords;
  // The settings overrides entry of this base
  std::optional<std::string> overrideRow;
};

struct ArmorFacts
{
  // BOD2 or BODT armor type: 0 light, 1 heavy, 2 clothing
  std::optional<uint32_t> armorType;
  // Biped flags, bit n is slot 30 + n
  uint32_t bipedFlags = 0;
  std::vector<std::string> keywords;
  std::optional<std::string> overrideRow;
};

namespace detail {

inline bool Has(const std::vector<std::string>& keywords, const char* keyword)
{
  return std::find(keywords.begin(), keywords.end(), keyword) !=
    keywords.end();
}

inline std::string FallbackRule(const std::string& rule)
{
  return rule.rfind("fallback", 0) == 0 ? rule : rule + " -> fallback";
}

// Rule and row by override, material keyword and AldCatMat, an empty row for the fallback
inline std::pair<std::string, std::string> ResolveRow(
  const AlduinakCombatSettings& s,
  const std::vector<std::pair<std::string, std::string>>& keywordRows,
  const std::vector<std::string>& keywords,
  const std::optional<std::string>& overrideRow)
{
  if (overrideRow) {
    return { "override", *overrideRow };
  }
  const auto multi =
    std::count_if(keywords.begin(), keywords.end(), [](const std::string& k) {
      return k.rfind("IAKMaterial", 0) == 0;
    });
  if (multi >= s.multiIAKFallback) {
    return { "fallback(IA multi)", "" };
  }
  for (auto& [keyword, row] : keywordRows) {
    if (Has(keywords, keyword.data())) {
      return { "keyword", row };
    }
  }
  for (auto& [keyword, row] : s.aldCatMat) {
    if (Has(keywords, keyword.data())) {
      return { "AldCatMat", row };
    }
  }
  return { "fallback", "" };
}

inline float RowHP(const std::map<std::string, float>& table,
                   const std::string& row, float fallback)
{
  auto it = table.find(row);
  return it == table.end() ? fallback : it->second;
}

}

inline WeaponType WeaponTypeOf(uint8_t animType,
                               const std::vector<std::string>& keywords)
{
  switch (animType) {
    case 0:
      return WeaponType::Unarmed;
    case 1:
      return WeaponType::Sword;
    case 2:
      return WeaponType::Dagger;
    case 3:
      return WeaponType::WarAxe;
    case 4:
      return WeaponType::Mace;
    case 5:
      return WeaponType::Greatsword;
    case 6:
      return detail::Has(keywords, "WeapTypeWarhammer")
        ? WeaponType::Warhammer
        : WeaponType::Battleaxe;
    case 7:
      return WeaponType::Bow;
    case 8:
      return WeaponType::Staff;
    case 9:
      return WeaponType::Crossbow;
    default:
      return WeaponType::None;
  }
}

// A melee row with its type, also what a claw race's fists count as
inline void FillMelee(const AlduinakCombatSettings& s, ItemRow& item)
{
  const auto& type = s.TypeRow(item.type);
  auto it = s.weapons.find(item.row);
  if (it != s.weapons.end()) {
    item.damage = it->second.base * type.dmgMult;
    item.penetration = it->second.penetration;
    item.critChance = it->second.critChance;
  }
  item.speed = type.speed;
}

inline ItemRow ClassifyWeapon(const AlduinakCombatSettings& s,
                              const WeaponFacts& facts)
{
  const auto& d = s.durability;
  ItemRow item;
  item.type = WeaponTypeOf(facts.animType, facts.keywords);
  if (item.type == WeaponType::Staff) {
    item.kind = Kind::Staff;
    item.rule = "staff (0)";
    return item;
  }
  if (item.type == WeaponType::Unarmed) {
    item.kind = Kind::Unarmed;
    item.rule = "unarmed row";
    item.damage = s.unarmedBase;
    item.speed = s.TypeRow(WeaponType::Unarmed).speed;
    return item;
  }
  if (item.type == WeaponType::None) {
    item.rule = "unknown animation";
    return item;
  }

  if (item.type == WeaponType::Crossbow) {
    if (facts.overrideRow && *facts.overrideRow == s.dummyRow) {
      item.kind = Kind::Dummy;
      item.row = s.dummyRow;
      item.rule = "override";
      return item;
    }
    if (facts.overrideRow && s.crossbows.count(*facts.overrideRow)) {
      item.row = *facts.overrideRow;
      item.rule = "override";
    } else {
      const bool dwarven =
        detail::Has(facts.keywords, "WeapMaterialDwarven") &&
        s.crossbows.count("Dwarven");
      item.row = dwarven ? "Dwarven" : s.fallbackCrossbowRow;
      item.rule = "crossbow row";
    }
    item.kind = Kind::Crossbow;
    auto it = s.crossbows.find(item.row);
    item.damage = it == s.crossbows.end() ? 0.f : it->second.base;
    item.speed = s.TypeRow(WeaponType::Crossbow).speed;
    item.hp = detail::RowHP(d.crossbowHP, item.row, d.fallbackWeaponHP);
    return item;
  }

  auto [rule, row] =
    detail::ResolveRow(s, s.weaponKeywords, facts.keywords, facts.overrideRow);
  if (row == s.dummyRow) {
    item.kind = Kind::Dummy;
    item.row = row;
    item.rule = rule;
    return item;
  }

  if (item.type == WeaponType::Bow) {
    if (!s.bows.count(row)) {
      auto mapped = s.bowRowForMaterial.find(row);
      if (mapped != s.bowRowForMaterial.end() &&
          s.bows.count(mapped->second)) {
        row = mapped->second;
      } else {
        rule = detail::FallbackRule(rule);
        row = s.fallbackBowRow;
      }
    }
    item.kind = Kind::Bow;
    item.row = row;
    item.rule = rule;
    auto it = s.bows.find(row);
    if (it != s.bows.end()) {
      item.damage = it->second.base;
      item.speed = it->second.speed;
    }
    item.hp = detail::RowHP(d.bowHP, row, d.fallbackWeaponHP);
  } else {
    if (!s.weapons.count(row)) {
      rule = detail::FallbackRule(rule);
      row = s.fallbackWeaponRow;
    }
    item.kind = Kind::Weapon;
    item.row = row;
    item.rule = rule;
    FillMelee(s, item);
    item.hp = detail::RowHP(d.weaponHP, row, d.fallbackWeaponHP);
  }
  item.fallback = item.rule.find("fallback") != std::string::npos;
  return item;
}

inline ItemRow ClassifyArmor(const AlduinakCombatSettings& s,
                             const ArmorFacts& facts)
{
  constexpr uint32_t kLight = 0, kHeavy = 1, kClothing = 2;
  const auto& d = s.durability;
  ItemRow item;
  if (facts.armorType == kClothing ||
      detail::Has(facts.keywords, "ArmorClothing") ||
      detail::Has(facts.keywords, "ArmorJewelry")) {
    item.kind = Kind::Clothing;
    item.armorClass = ArmorClass::Clothing;
    item.rule = "clothing/jewelry (DT 0)";
    return item;
  }

  auto [rule, row] =
    detail::ResolveRow(s, s.armorKeywords, facts.keywords, facts.overrideRow);
  const auto shieldBit = static_cast<size_t>(SlotBucket::Shield);
  const bool shield = (facts.bipedFlags & s.slotMasks[shieldBit]) != 0 ||
    detail::Has(facts.keywords, "ArmorShield");
  if (shield) {
    item.buckets = static_cast<uint8_t>(1u << shieldBit);
  } else {
    for (size_t i = 0; i < kNumShareBuckets; ++i) {
      if (facts.bipedFlags & s.slotMasks[i]) {
        item.buckets |= static_cast<uint8_t>(1u << i);
        item.slotShare += s.slotShare[i];
      }
    }
  }

  auto it = s.armor.find(row);
  if (it == s.armor.end()) {
    rule = detail::FallbackRule(rule);
    row = shield                  ? s.fallbackShieldRow
      : facts.armorType == kHeavy ? s.fallbackArmorHeavyRow
                                  : s.fallbackArmorLightRow;
    it = s.armor.find(row);
  }
  item.row = row;
  item.rule = rule;
  item.fallback = rule.find("fallback") != std::string::npos;
  if (it == s.armor.end()) {
    return item;
  }
  const auto& armorRow = it->second;
  item.armorClass = armorRow.cls;
  if (armorRow.cls == ArmorClass::Clothing) {
    item.kind = Kind::Clothing;
    item.buckets = 0;
    item.slotShare = 0.f;
    return item;
  }
  item.lightOnHeavy =
    facts.armorType == kLight && armorRow.cls == ArmorClass::Heavy;
  const float setHP = detail::RowHP(d.armorSetHP, row, d.fallbackArmorSetHP);
  if (shield) {
    item.kind = Kind::Shield;
    item.dt =
      armorRow.shieldDT ? *armorRow.shieldDT : armorRow.setDT * s.shieldShare;
    item.hp = setHP * d.shieldHPShare;
  } else {
    item.kind = Kind::Armor;
    item.dt = armorRow.setDT * item.slotShare *
      (item.lightOnHeavy ? s.lightItemHeavyRowFactor : 1.f);
    item.hp = setHP * item.slotShare;
  }
  return item;
}

// What the fists of a race with an unarmed.raceOverride entry count as
inline ItemRow ClawRow(const AlduinakCombatSettings& s,
                       const AlduinakCombatSettings::RaceOverride& entry)
{
  ItemRow item;
  item.kind = Kind::Weapon;
  item.type = entry.type;
  item.row = entry.weaponRow;
  item.rule = "raceOverride";
  FillMelee(s, item);
  return item;
}

}
