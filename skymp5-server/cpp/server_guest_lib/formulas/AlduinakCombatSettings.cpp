#include "AlduinakCombatSettings.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <initializer_list>
#include <limits>
#include <nlohmann/json.hpp>
#include <set>

namespace ItemRows {

namespace {
constexpr std::array<const char*, kNumWeaponTypes> kWeaponTypeNames = {
  "",          "dagger",    "sword", "waraxe",   "mace",    "greatsword",
  "battleaxe", "warhammer", "bow",   "crossbow", "unarmed", "staff"
};
constexpr std::array<const char*, kNumSlotBuckets> kSlotBucketNames = {
  "cuirass", "helmet", "gauntlets", "boots", "shield"
};
}

const char* WeaponTypeName(WeaponType type) noexcept
{
  const auto i = static_cast<size_t>(type);
  return i < kNumWeaponTypes ? kWeaponTypeNames[i] : "";
}

WeaponType WeaponTypeFromName(const std::string& name) noexcept
{
  for (size_t i = 1; i < kNumWeaponTypes; ++i) {
    if (name == kWeaponTypeNames[i]) {
      return static_cast<WeaponType>(i);
    }
  }
  return WeaponType::None;
}

const char* SlotBucketName(SlotBucket bucket) noexcept
{
  const auto i = static_cast<size_t>(bucket);
  return i < kNumSlotBuckets ? kSlotBucketNames[i] : "";
}

const char* ArmorClassName(ArmorClass cls) noexcept
{
  switch (cls) {
    case ArmorClass::Light:
      return "light";
    case ArmorClass::Heavy:
      return "heavy";
    case ArmorClass::Clothing:
      return "clothing";
    default:
      return "";
  }
}

bool IsMeleeType(WeaponType type) noexcept
{
  return type >= WeaponType::Dagger && type <= WeaponType::Warhammer;
}

}

namespace {

using json = nlohmann::json;
using ItemRows::WeaponType;

constexpr float kMax = 1000000.f;

std::string Shown(const json& value)
{
  std::string text = value.dump();
  if (text.size() > 60) {
    text = text.substr(0, 57) + "...";
  }
  return text;
}

// "<hex id>:<plugin>", the shape FormDesc::FromString reads
bool IsFormKey(const std::string& key)
{
  const auto colon = key.find(':');
  if (colon == std::string::npos || colon == 0 || colon > 8 ||
      colon + 1 >= key.size()) {
    return false;
  }
  return std::all_of(key.begin(), key.begin() + colon,
                     [](unsigned char c) { return std::isxdigit(c) != 0; });
}

class Reader
{
public:
  Reader(std::vector<std::string>& problems_,
         std::vector<std::string>& warnings_)
    : problems(problems_)
    , warnings(warnings_)
  {
  }

  void Problem(std::string text) { problems.push_back(std::move(text)); }
  void Warning(std::string text) { warnings.push_back(std::move(text)); }

  // The object at key, null when absent (a problem if required) or of another type (always a problem)
  const json* Object(const json& parent, const std::string& path,
                     const char* key, bool required)
  {
    auto it = parent.find(key);
    if (it == parent.end() || it->is_null()) {
      if (required) {
        Problem(path + key + " is missing, should be an object");
      }
      return nullptr;
    }
    if (!it->is_object()) {
      Problem(path + key + " should be an object, found " + Shown(*it));
      return nullptr;
    }
    return &*it;
  }

  bool Number(const json& parent, const std::string& path, const char* key,
              float& out, float min = 0.f, float max = kMax,
              bool required = false)
  {
    auto it = parent.find(key);
    if (it == parent.end()) {
      if (required) {
        Problem(path + key + " is missing, should be a number");
      }
      return false;
    }
    return NumberValue(*it, path + key, out, min, max);
  }

  bool NumberValue(const json& value, const std::string& name, float& out,
                   float min = 0.f, float max = kMax)
  {
    const double number = value.is_number()
      ? value.get<double>()
      : std::numeric_limits<double>::quiet_NaN();
    if (!std::isfinite(number) || number < min || number > max) {
      Problem(name + " should be a number from " + Trim(min) + " to " +
              Trim(max) + ", found " + Shown(value));
      return false;
    }
    out = static_cast<float>(number);
    return true;
  }

  void Integer(const json& parent, const std::string& path, const char* key,
               int& out, int min, int max)
  {
    auto it = parent.find(key);
    if (it == parent.end()) {
      return;
    }
    if (!it->is_number_integer() || it->get<int64_t>() < min ||
        it->get<int64_t>() > max) {
      Problem(path + key + " should be a whole number from " +
              std::to_string(min) + " to " + std::to_string(max) + ", found " +
              Shown(*it));
      return;
    }
    out = static_cast<int>(it->get<int64_t>());
  }

  void Bool(const json& parent, const std::string& path, const char* key,
            bool& out)
  {
    auto it = parent.find(key);
    if (it == parent.end()) {
      return;
    }
    if (!it->is_boolean()) {
      Problem(path + key + " should be true or false, found " + Shown(*it));
      return;
    }
    out = it->get<bool>();
  }

  void String(const json& parent, const std::string& path, const char* key,
              std::string& out, bool required = false,
              bool allowEmpty = false)
  {
    auto it = parent.find(key);
    if (it == parent.end()) {
      if (required) {
        Problem(path + key + " is missing, should be a text");
      }
      return;
    }
    if (!it->is_string()) {
      Problem(path + key + " should be a text, found " + Shown(*it));
      return;
    }
    if (!allowEmpty && it->get_ref<const std::string&>().empty()) {
      Problem(path + key + " should be a text that is not empty");
      return;
    }
    out = it->get<std::string>();
  }

  // Row name to number table
  void NumberTable(const json& parent, const std::string& path,
                   const char* key, std::map<std::string, float>& out,
                   float min, bool formKeys)
  {
    const json* table = Object(parent, path, key, false);
    if (!table) {
      return;
    }
    for (auto& [name, value] : table->items()) {
      if (formKeys && !IsFormKey(name)) {
        Problem(path + key + " key \"" + name +
                "\" should be a form key like \"13986:Skyrim.esm\"");
        continue;
      }
      float number = 0.f;
      if (NumberValue(value, path + key + "." + name, number, min)) {
        out[name] = number;
      }
    }
  }

  // Array of [keyword editor id, row] pairs
  void KeywordList(const json& parent, const char* key,
                   std::vector<std::pair<std::string, std::string>>& out,
                   bool required)
  {
    auto it = parent.find(key);
    if (it == parent.end()) {
      if (required) {
        Problem(std::string(key) +
                " is missing, should be a list of [keyword, row] pairs");
      }
      return;
    }
    if (!it->is_array() || (required && it->empty())) {
      Problem(std::string(key) +
              " should be a list of [keyword, row] pairs, found " +
              Shown(*it));
      return;
    }
    for (size_t i = 0; i < it->size(); ++i) {
      const json& pair = (*it)[i];
      if (!pair.is_array() || pair.size() != 2 || !pair[0].is_string() ||
          !pair[1].is_string() ||
          pair[0].get_ref<const std::string&>().empty()) {
        Problem(std::string(key) + "[" + std::to_string(i) +
                "] should be a [keyword, row] pair, found " + Shown(pair));
        continue;
      }
      out.emplace_back(pair[0].get<std::string>(), pair[1].get<std::string>());
    }
  }

private:
  static std::string Trim(float value)
  {
    std::string text = std::to_string(value);
    text.erase(text.find_last_not_of('0') + 1);
    if (!text.empty() && text.back() == '.') {
      text.pop_back();
    }
    return text;
  }

  std::vector<std::string>& problems;
  std::vector<std::string>& warnings;
};

const std::set<std::string> kKnownKeys = { "source",
                                           "enabled",
                                           "floor",
                                           "minDamage",
                                           "critDTMult",
                                           "powerMult",
                                           "npcNaturalPowerMult",
                                           "bashMult",
                                           "playerHitCap",
                                           "shieldShare",
                                           "lightItemHeavyRowFactor",
                                           "speedNorm",
                                           "rateLimitFactor",
                                           "quickShotDrawMult",
                                           "crossbowReload",
                                           "poisonFloor",
                                           "healthSnap",
                                           "sneak",
                                           "power",
                                           "effectModifiers",
                                           "magic",
                                           "tempering",
                                           "weaponTypes",
                                           "weapons",
                                           "dummyRow",
                                           "bows",
                                           "bowRowForMaterial",
                                           "crossbows",
                                           "arrow",
                                           "unarmed",
                                           "armor",
                                           "slotShare",
                                           "slotBipeds",
                                           "weaponKeywords",
                                           "armorKeywords",
                                           "aldCatMat",
                                           "multiIAKFallback",
                                           "fallbackRows",
                                           "overrides",
                                           "npc",
                                           "blockStamina",
                                           "durability" };

void ReadWeaponTypes(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  const json* types = r.Object(block, "", "weaponTypes", true);
  if (!types) {
    return;
  }
  for (size_t i = static_cast<size_t>(WeaponType::Dagger);
       i <= static_cast<size_t>(WeaponType::Unarmed); ++i) {
    const auto type = static_cast<WeaponType>(i);
    const char* name = ItemRows::WeaponTypeName(type);
    auto& row = s.weaponTypes[i];
    row.powerMult = s.powerMult;
    row.floor = s.floor;
    const json* entry = r.Object(*types, "weaponTypes.", name, true);
    if (!entry) {
      continue;
    }
    const std::string path = std::string("weaponTypes.") + name + ".";
    r.Number(*entry, path, "speed", row.speed, 0.01f, 100.f);
    r.Integer(*entry, path, "hands", row.hands, 1, 2);
    r.Number(*entry, path, "dmgMult", row.dmgMult, 0.f, 100.f,
             ItemRows::IsMeleeType(type));
    r.Number(*entry, path, "critChance", row.critChance, 0.f, 1.f);
    r.Number(*entry, path, "critMult", row.critMult, 0.f, 100.f);
    r.Number(*entry, path, "penetration", row.penetration, 0.f, 1.f);
    r.Number(*entry, path, "powerMult", row.powerMult, 0.f, 100.f);
    r.Number(*entry, path, "sneakMult", row.sneakMult, 0.f, 100.f);
    r.Number(*entry, path, "floor", row.floor, 0.f, 1.f);
    r.Bool(*entry, path, "autoCritOnSneak", row.autoCritOnSneak);
  }
  for (auto& [name, value] : types->items()) {
    const auto type = ItemRows::WeaponTypeFromName(name);
    if (type == WeaponType::None || type == WeaponType::Staff) {
      r.Warning("weaponTypes." + name + " is not a type the server prices, " +
                "it is not read");
    }
  }
}

void ReadRows(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  if (const json* weapons = r.Object(block, "", "weapons", true)) {
    for (auto& [name, value] : weapons->items()) {
      const std::string path = "weapons." + name + ".";
      if (!value.is_object()) {
        r.Problem("weapons." + name +
                  " should be an object with base, found " + Shown(value));
        continue;
      }
      AlduinakCombatSettings::WeaponRow row;
      r.Number(value, path, "base", row.base, 0.f, kMax, true);
      r.Number(value, path, "penetration", row.penetration, 0.f, 1.f);
      r.Number(value, path, "critChance", row.critChance, 0.f, 1.f);
      s.weapons[name] = row;
    }
    if (weapons->empty()) {
      r.Problem("weapons has no row");
    }
  }

  if (const json* bows = r.Object(block, "", "bows", true)) {
    for (auto& [name, value] : bows->items()) {
      const std::string path = "bows." + name + ".";
      if (!value.is_object()) {
        r.Problem("bows." + name +
                  " should be an object with base and speed, found " +
                  Shown(value));
        continue;
      }
      AlduinakCombatSettings::BowRow row;
      r.Number(value, path, "base", row.base, 0.f, kMax, true);
      r.Number(value, path, "speed", row.speed, 0.01f, 100.f);
      s.bows[name] = row;
    }
    if (bows->empty()) {
      r.Problem("bows has no row");
    }
  }

  if (const json* crossbows = r.Object(block, "", "crossbows", true)) {
    for (auto& [name, value] : crossbows->items()) {
      AlduinakCombatSettings::CrossbowRow row;
      if (value.is_object()) {
        r.Number(value, "crossbows." + name + ".", "base", row.base, 0.f, kMax,
                 true);
      } else {
        r.NumberValue(value, "crossbows." + name, row.base);
      }
      s.crossbows[name] = row;
    }
    if (crossbows->empty()) {
      r.Problem("crossbows has no row");
    }
  }

  if (const json* armor = r.Object(block, "", "armor", true)) {
    for (auto& [name, value] : armor->items()) {
      const std::string path = "armor." + name + ".";
      if (!value.is_object()) {
        r.Problem("armor." + name +
                  " should be an object with class and setDT, found " +
                  Shown(value));
        continue;
      }
      AlduinakCombatSettings::ArmorRow row;
      std::string cls;
      r.String(value, path, "class", cls, true);
      if (cls == "light") {
        row.cls = ItemRows::ArmorClass::Light;
      } else if (cls == "heavy") {
        row.cls = ItemRows::ArmorClass::Heavy;
      } else if (cls == "clothing") {
        row.cls = ItemRows::ArmorClass::Clothing;
      } else if (!cls.empty()) {
        r.Problem(path + "class should be light, heavy or clothing, found \"" +
                  cls + "\"");
      }
      r.Number(value, path, "setDT", row.setDT);
      float shieldDT = 0.f;
      if (r.Number(value, path, "shieldDT", shieldDT)) {
        row.shieldDT = shieldDT;
      }
      s.armor[name] = row;
    }
    if (armor->empty()) {
      r.Problem("armor has no row");
    }
  }

  if (const json* map = r.Object(block, "", "bowRowForMaterial", false)) {
    for (auto& [name, value] : map->items()) {
      if (!value.is_string()) {
        r.Problem("bowRowForMaterial." + name +
                  " should be a bows row name, found " + Shown(value));
        continue;
      }
      s.bowRowForMaterial[name] = value.get<std::string>();
    }
  }
}

void ReadUnarmed(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  const json* unarmed = r.Object(block, "", "unarmed", false);
  if (!unarmed) {
    return;
  }
  r.Number(*unarmed, "unarmed.", "base", s.unarmedBase);
  r.Number(*unarmed, "unarmed.", "penetration", s.unarmedPenetration, 0.f,
           1.f);
  r.Number(*unarmed, "unarmed.", "floor", s.unarmedFloor, 0.f, 1.f);
  r.Number(*unarmed, "unarmed.", "critChance", s.unarmedCritChance, 0.f, 1.f);
  r.Number(*unarmed, "unarmed.", "critMult", s.unarmedCritMult, 0.f, 100.f);
  if (unarmed->contains("race")) {
    r.Warning("unarmed.race is the old number table and is not read, claws "
              "go in unarmed.raceOverride as {weaponRow, type} objects");
  }
  const json* races = r.Object(*unarmed, "unarmed.", "raceOverride", false);
  if (!races) {
    return;
  }
  for (auto& [race, value] : races->items()) {
    const std::string path = "unarmed.raceOverride." + race + ".";
    if (!value.is_object()) {
      r.Problem("unarmed.raceOverride." + race +
                " should be an object {weaponRow, type}, found " +
                Shown(value));
      continue;
    }
    AlduinakCombatSettings::RaceOverride entry;
    std::string type;
    r.String(value, path, "weaponRow", entry.weaponRow, true);
    r.String(value, path, "type", type, true);
    entry.type = ItemRows::WeaponTypeFromName(type);
    if (!type.empty() && !ItemRows::IsMeleeType(entry.type)) {
      r.Problem(path +
                "type should be a melee type (dagger, sword, waraxe, "
                "mace, greatsword, battleaxe, warhammer), found \"" +
                type + "\"");
    }
    if (!entry.weaponRow.empty() && !s.weapons.count(entry.weaponRow)) {
      r.Problem(path + "weaponRow \"" + entry.weaponRow +
                "\" is not a row of weapons");
    }
    s.raceOverride[race] = entry;
  }
}

void ReadSlots(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  if (const json* share = r.Object(block, "", "slotShare", false)) {
    for (size_t i = 0; i < ItemRows::kNumShareBuckets; ++i) {
      r.Number(*share, "slotShare.",
               ItemRows::SlotBucketName(static_cast<ItemRows::SlotBucket>(i)),
               s.slotShare[i], 0.f, 1.f);
    }
  }
  const json* bipeds = r.Object(block, "", "slotBipeds", false);
  if (!bipeds) {
    return;
  }
  for (size_t i = 0; i < ItemRows::kNumSlotBuckets; ++i) {
    const char* name =
      ItemRows::SlotBucketName(static_cast<ItemRows::SlotBucket>(i));
    auto it = bipeds->find(name);
    if (it == bipeds->end()) {
      continue;
    }
    uint32_t mask = 0;
    bool valid = it->is_array();
    if (valid) {
      for (const json& slot : *it) {
        if (!slot.is_number_integer() || slot.get<int64_t>() < 30 ||
            slot.get<int64_t>() > 61) {
          valid = false;
          break;
        }
        mask |= 1u << static_cast<uint32_t>(slot.get<int64_t>() - 30);
      }
    }
    if (!valid) {
      r.Problem(std::string("slotBipeds.") + name +
                " should be a list of biped slots from 30 to 61, found " +
                Shown(*it));
      continue;
    }
    s.slotMasks[i] = mask;
  }
}

void ReadFallbackRows(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  const json* rows = r.Object(block, "", "fallbackRows", true);
  if (!rows) {
    return;
  }
  r.String(*rows, "fallbackRows.", "weapon", s.fallbackWeaponRow, true);
  r.String(*rows, "fallbackRows.", "bow", s.fallbackBowRow, true);
  r.String(*rows, "fallbackRows.", "crossbow", s.fallbackCrossbowRow, true);
  r.String(*rows, "fallbackRows.", "armorLight", s.fallbackArmorLightRow,
           true);
  r.String(*rows, "fallbackRows.", "armorHeavy", s.fallbackArmorHeavyRow,
           true);
  r.String(*rows, "fallbackRows.", "shield", s.fallbackShieldRow, true);
  const auto check = [&](const char* key, const std::string& row, bool known,
                         const char* table) {
    if (!row.empty() && !known) {
      r.Problem(std::string("fallbackRows.") + key + " \"" + row +
                "\" is not a row of " + table);
    }
  };
  check("weapon", s.fallbackWeaponRow, s.weapons.count(s.fallbackWeaponRow),
        "weapons");
  check("bow", s.fallbackBowRow, s.bows.count(s.fallbackBowRow), "bows");
  check("crossbow", s.fallbackCrossbowRow,
        s.crossbows.count(s.fallbackCrossbowRow), "crossbows");
  check("armorLight", s.fallbackArmorLightRow,
        s.armor.count(s.fallbackArmorLightRow), "armor");
  check("armorHeavy", s.fallbackArmorHeavyRow,
        s.armor.count(s.fallbackArmorHeavyRow), "armor");
  check("shield", s.fallbackShieldRow, s.armor.count(s.fallbackShieldRow),
        "armor");
}

void ReadDurability(Reader& r, const json& block, AlduinakCombatSettings& s)
{
  const json* d = r.Object(block, "", "durability", false);
  if (!d) {
    return;
  }
  auto& out = s.durability;
  const std::string path = "durability.";
  r.Bool(*d, path, "enabled", out.enabled);
  r.NumberTable(*d, path, "weaponHP", out.weaponHP, 1.f, false);
  r.NumberTable(*d, path, "bowHP", out.bowHP, 1.f, false);
  r.NumberTable(*d, path, "crossbowHP", out.crossbowHP, 1.f, false);
  r.NumberTable(*d, path, "armorSetHP", out.armorSetHP, 1.f, false);
  r.Number(*d, path, "shieldHPShare", out.shieldHPShare, 0.01f, 100.f);
  if (const json* fallback = r.Object(*d, path, "fallbackHP", false)) {
    r.Number(*fallback, "durability.fallbackHP.", "weapon",
             out.fallbackWeaponHP, 1.f);
    r.Number(*fallback, "durability.fallbackHP.", "armorSet",
             out.fallbackArmorSetHP, 1.f);
  }
  if (const json* wear = r.Object(*d, path, "wear", false)) {
    const std::string p = "durability.wear.";
    r.Number(*wear, p, "landedHit", out.wear.landedHit);
    r.Number(*wear, p, "powerExtra", out.wear.powerExtra);
    r.Number(*wear, p, "parriedHit", out.wear.parriedHit);
    r.Number(*wear, p, "bash", out.wear.bash);
    r.Number(*wear, p, "bowHit", out.wear.bowHit);
    r.Number(*wear, p, "shieldBlock", out.wear.shieldBlock);
    r.Number(*wear, p, "armorHit", out.wear.armorHit);
    r.Number(*wear, p, "armorMinPreDT", out.wear.armorMinPreDT);
  }
  if (const json* effect = r.Object(*d, path, "effect", false)) {
    const std::string p = "durability.effect.";
    r.Number(*effect, p, "kneeCondition", out.effect.kneeCondition, 0.f, 1.f);
    r.Number(*effect, p, "effectAtZero", out.effect.effectAtZero, 0.f, 1.f);
    r.Number(*effect, p, "brokenWeaponMult", out.effect.brokenWeaponMult, 0.f,
             1.f);
    r.Number(*effect, p, "brokenArmorDT", out.effect.brokenArmorDT, 0.f, 1.f);
    r.Number(*effect, p, "brokenBlockPass", out.effect.brokenBlockPass, 0.f,
             1.f);
  }
  if (const json* flush = r.Object(*d, path, "flush", false)) {
    r.Number(*flush, "durability.flush.", "minSeconds", out.flushMinSeconds);
    r.Number(*flush, "durability.flush.", "calmSeconds", out.flushCalmSeconds);
  }
  r.Bool(*d, path, "npcGearWears", out.npcGearWears);
  r.Number(*d, path, "deathWear", out.deathWear, 0.f, 1.f);
  if (auto it = d->find("exempt"); it != d->end()) {
    if (!it->is_array()) {
      r.Problem("durability.exempt should be a list of form keys, found " +
                Shown(*it));
    } else {
      for (const json& key : *it) {
        if (!key.is_string() || !IsFormKey(key.get<std::string>())) {
          r.Problem("durability.exempt entry " + Shown(key) +
                    " should be a form key like \"13986:Skyrim.esm\"");
          continue;
        }
        out.exempt.push_back(key.get<std::string>());
      }
    }
  }
  if (const json* tag = r.Object(*d, path, "nameTag", false)) {
    r.Bool(*tag, "durability.nameTag.", "showAtFull", out.nameTagShowAtFull);
    r.String(*tag, "durability.nameTag.", "brokenLabel",
             out.nameTagBrokenLabel);
  }
  const json* repair = r.Object(*d, path, "repair", false);
  if (!repair) {
    return;
  }
  const std::string p = "durability.repair.";
  if (const json* units = r.Object(*repair, p, "unitsPerMissing", false)) {
    const std::string u = "durability.repair.unitsPerMissing.";
    r.Number(*units, u, "weapon", out.repair.unitsPerMissingWeapon);
    r.Number(*units, u, "cuirass", out.repair.unitsPerMissingCuirass);
    r.Number(*units, u, "other", out.repair.unitsPerMissingOther);
  }
  r.Bool(*repair, p, "requireProfessionRank",
         out.repair.requireProfessionRank);
  r.Number(*repair, p, "fatigue", out.repair.fatigue);
  r.Bool(*repair, p, "anyBench", out.repair.anyBench);
  r.Bool(*repair, p, "menuOnActivate", out.repair.menuOnActivate);
  r.String(*repair, p, "chatCommand", out.repair.chatCommand, false, true);
  r.Number(*repair, p, "lowNoticeBelow", out.repair.lowNoticeBelow, 0.f, 1.f);
  const json* materials = r.Object(*repair, p, "fallbackMaterial", false);
  if (!materials) {
    return;
  }
  for (auto& [kind, rows] : materials->items()) {
    const std::string m = "durability.repair.fallbackMaterial." + kind;
    if (kind != "weapon" && kind != "bow" && kind != "crossbow" &&
        kind != "armor") {
      r.Warning(m +
                " is not a kind the server knows (weapon, bow, crossbow, "
                "armor), it is not read");
      continue;
    }
    if (!rows.is_object()) {
      r.Problem(m + " should be an object of row to form key, found " +
                Shown(rows));
      continue;
    }
    for (auto& [row, key] : rows.items()) {
      if (!key.is_string() || !IsFormKey(key.get<std::string>())) {
        r.Problem(m + "." + row +
                  " should be a form key like \"5ace4:Skyrim.esm\", found " +
                  Shown(key));
        continue;
      }
      out.repair.fallbackMaterial[kind][row] = key.get<std::string>();
    }
  }
}

template <class Table>
std::string MissingRows(const Table& rows,
                        const std::map<std::string, float>& hp)
{
  std::string missing;
  for (auto& [name, row] : rows) {
    if (!hp.count(name)) {
      missing += (missing.empty() ? "" : ", ") + name;
    }
  }
  return missing;
}

void CheckReferences(Reader& r, const AlduinakCombatSettings& s)
{
  const auto weaponRow = [&](const std::string& row) {
    return s.weapons.count(row) || s.bows.count(row) || row == s.dummyRow;
  };
  for (auto& [keyword, row] : s.weaponKeywords) {
    if (!weaponRow(row)) {
      r.Problem("weaponKeywords: " + keyword + " names the row \"" + row +
                "\", which is in neither weapons nor bows");
    }
  }
  for (auto& [keyword, row] : s.armorKeywords) {
    if (!s.armor.count(row)) {
      r.Problem("armorKeywords: " + keyword + " names the row \"" + row +
                "\", which is not in armor");
    }
  }
  for (auto& [keyword, row] : s.aldCatMat) {
    if (!weaponRow(row) && !s.armor.count(row)) {
      r.Problem("aldCatMat: " + keyword + " names the row \"" + row +
                "\", which is in none of weapons, bows and armor");
    }
  }
  for (auto& [material, row] : s.bowRowForMaterial) {
    if (!s.bows.count(row)) {
      r.Problem("bowRowForMaterial." + material + " names the row \"" + row +
                "\", which is not in bows");
    }
  }
  size_t unknownOverrideRows = 0;
  for (auto& [key, row] : s.overrides) {
    if (weaponRow(row) || s.crossbows.count(row) || s.armor.count(row)) {
      continue;
    }
    if (++unknownOverrideRows <= 5) {
      r.Problem("overrides." + key + " names the row \"" + row +
                "\", which is in none of weapons, bows, crossbows and armor");
    }
  }
  if (unknownOverrideRows > 5) {
    r.Problem("overrides: " + std::to_string(unknownOverrideRows - 5) +
              " more entries name a row that does not exist");
  }
  if (s.speedNormMin > s.speedNormMax) {
    r.Problem("speedNorm.min is above speedNorm.max");
  }
  if (!s.durability.enabled) {
    return;
  }
  const auto warn = [&](const char* table, const std::string& missing,
                        float fallback) {
    if (!missing.empty()) {
      r.Warning(std::string("durability.") + table + " lacks the rows " +
                missing + ": they take the fallback HP " +
                std::to_string(static_cast<int>(fallback)));
    }
  };
  const auto& d = s.durability;
  warn("weaponHP", MissingRows(s.weapons, d.weaponHP), d.fallbackWeaponHP);
  warn("bowHP", MissingRows(s.bows, d.bowHP), d.fallbackWeaponHP);
  warn("crossbowHP", MissingRows(s.crossbows, d.crossbowHP),
       d.fallbackWeaponHP);
  std::map<std::string, AlduinakCombatSettings::ArmorRow> wearing;
  for (auto& [name, row] : s.armor) {
    if (row.cls != ItemRows::ArmorClass::Clothing) {
      wearing.emplace(name, row);
    }
  }
  warn("armorSetHP", MissingRows(wearing, d.armorSetHP), d.fallbackArmorSetHP);
}

std::shared_ptr<AlduinakCombatSettings> Parse(
  const json& block, std::vector<std::string>& problems,
  std::vector<std::string>& warnings)
{
  const size_t problemsBefore = problems.size();
  Reader r(problems, warnings);
  if (!block.is_object()) {
    r.Problem("the block should be an object, found " + Shown(block));
    return nullptr;
  }
  auto settings = std::make_shared<AlduinakCombatSettings>();
  auto& s = *settings;

  for (auto& [key, value] : block.items()) {
    if (!kKnownKeys.count(key)) {
      r.Warning("the key \"" + key + "\" is not one the server reads");
    }
  }

  if (auto it = block.find("source"); it != block.end() && it->is_string()) {
    s.source = it->get<std::string>();
  }
  r.Bool(block, "", "enabled", s.enabled);
  r.Number(block, "", "floor", s.floor, 0.f, 1.f);
  r.Number(block, "", "minDamage", s.minDamage);
  r.Number(block, "", "critDTMult", s.critDTMult, 0.f, 1.f);
  r.Number(block, "", "powerMult", s.powerMult, 0.f, 100.f);
  r.Number(block, "", "npcNaturalPowerMult", s.npcNaturalPowerMult, 0.f,
           100.f);
  r.Number(block, "", "bashMult", s.bashMult, 0.f, 100.f);
  r.Number(block, "", "playerHitCap", s.playerHitCap);
  r.Number(block, "", "shieldShare", s.shieldShare, 0.f, 1.f);
  r.Number(block, "", "lightItemHeavyRowFactor", s.lightItemHeavyRowFactor,
           0.f, 1.f);
  if (const json* norm = r.Object(block, "", "speedNorm", false)) {
    r.Number(*norm, "speedNorm.", "min", s.speedNormMin, 0.f, 100.f);
    r.Number(*norm, "speedNorm.", "max", s.speedNormMax, 0.f, 100.f);
  }
  r.Number(block, "", "rateLimitFactor", s.rateLimitFactor, 0.f, 100.f);
  r.Number(block, "", "quickShotDrawMult", s.quickShotDrawMult, 0.f, 100.f);
  r.Number(block, "", "crossbowReload", s.crossbowReload, 0.f, 100.f);
  r.Number(block, "", "poisonFloor", s.poisonFloor, 0.f, 1.f);
  r.Number(block, "", "healthSnap", s.healthSnap, 0.f, 1.f);
  if (const json* sneak = r.Object(block, "", "sneak", false)) {
    r.Number(*sneak, "sneak.", "minSneakSeconds", s.sneakMinSneakSeconds);
    r.Number(*sneak, "sneak.", "targetCalmSeconds", s.sneakTargetCalmSeconds);
    r.String(*sneak, "sneak.", "calmRuleTargets", s.sneakCalmRuleTargets,
             false, true);
  }
  if (const json* power = r.Object(block, "", "power", false)) {
    r.Number(*power, "power.", "eventWindowSeconds",
             s.powerEventWindowSeconds);
    r.Number(*power, "power.", "minIntervalSeconds",
             s.powerMinIntervalSeconds);
    r.Number(*power, "power.", "splashWindowSeconds",
             s.powerSplashWindowSeconds);
    r.Bool(*power, "power.", "logOnly", s.powerLogOnly);
  }
  if (auto it = block.find("effectModifiers"); it != block.end()) {
    s.effectModifiers = it->is_boolean() && it->get<bool>();
  }
  if (const json* magic = r.Object(block, "", "magic", false)) {
    r.Number(*magic, "magic.", "dtShare", s.magic.dtShare, 0.f, 1.f);
    r.Number(*magic, "magic.", "floor", s.magic.floor, 0.f, 1.f);
    if (magic->contains("resistance")) {
      bool resistance = false;
      r.Bool(*magic, "magic.", "resistance", resistance);
      s.magic.resistance = resistance;
    }
  }
  if (const json* tempering = r.Object(block, "", "tempering", false)) {
    r.Number(*tempering, "tempering.", "weaponPerStep",
             s.temperingWeaponPerStep, 0.f, 1.f);
    r.Number(*tempering, "tempering.", "armorPerStep", s.temperingArmorPerStep,
             0.f, 1.f);
  }

  ReadWeaponTypes(r, block, s);
  r.String(block, "", "dummyRow", s.dummyRow);
  ReadRows(r, block, s);
  if (const json* arrow = r.Object(block, "", "arrow", false)) {
    r.Number(*arrow, "arrow.", "scale", s.arrowScale);
    r.Number(*arrow, "arrow.", "zero", s.arrowZero);
    r.Number(*arrow, "arrow.", "max", s.arrowMax);
  }
  ReadUnarmed(r, block, s);
  ReadSlots(r, block, s);

  r.KeywordList(block, "weaponKeywords", s.weaponKeywords, true);
  r.KeywordList(block, "armorKeywords", s.armorKeywords, true);
  r.KeywordList(block, "aldCatMat", s.aldCatMat, false);
  r.Integer(block, "", "multiIAKFallback", s.multiIAKFallback, 1, 1000);
  ReadFallbackRows(r, block, s);

  if (const json* overrides = r.Object(block, "", "overrides", false)) {
    size_t bad = 0;
    for (auto& [key, row] : overrides->items()) {
      if (IsFormKey(key) && row.is_string()) {
        s.overrides[key] = row.get<std::string>();
      } else if (++bad <= 5) {
        r.Problem("overrides entry \"" + key + "\": " + Shown(row) +
                  " should be a form key like \"13986:Skyrim.esm\" with a "
                  "row name");
      }
    }
    if (bad > 5) {
      r.Problem("overrides: " + std::to_string(bad - 5) +
                " more entries are not a form key with a row name");
    }
  }

  if (const json* npc = r.Object(block, "", "npc", false)) {
    r.Number(*npc, "npc.", "playerToNpcMult", s.npcPlayerToNpcMult, 0.f,
             100.f);
    r.Bool(*npc, "npc.", "naturalCapBeforeDT", s.npcNaturalCapBeforeDT);
    r.Number(*npc, "npc.", "naturalFloor", s.npcNaturalFloor, 0.f, 1.f);
    r.Bool(*npc, "npc.", "naturalCanCrit", s.npcNaturalCanCrit);
    r.Bool(*npc, "npc.", "humanoidNpcCanCrit", s.npcHumanoidCanCrit);
    if (const json* pen =
          r.Object(*npc, "npc.", "naturalPenetration", false)) {
      const std::string p = "npc.naturalPenetration.";
      r.Number(*pen, p, "critterMaxDamage", s.npcCritterMaxDamage);
      r.Number(*pen, p, "critter", s.npcCritterPenetration, 0.f, 1.f);
      r.Number(*pen, p, "other", s.npcOtherPenetration, 0.f, 1.f);
    }
    r.NumberTable(*npc, "npc.", "naturalDT", s.naturalDT, 0.f, true);
  }
  if (const json* stamina = r.Object(block, "", "blockStamina", false)) {
    r.Number(*stamina, "blockStamina.", "perArmorWeight",
             s.blockStaminaPerArmorWeight);
    r.Number(*stamina, "blockStamina.", "weightCap", s.blockStaminaWeightCap);
  }
  ReadDurability(r, block, s);

  if (problems.size() == problemsBefore) {
    CheckReferences(r, s);
  }
  if (problems.size() != problemsBefore) {
    return nullptr;
  }
  return settings;
}

}

std::shared_ptr<const AlduinakCombatSettings> AlduinakCombatSettings::FromJson(
  const nlohmann::json& block, std::vector<std::string>& problems,
  std::vector<std::string>& warnings)
{
  try {
    return Parse(block, problems, warnings);
  } catch (const std::exception& e) {
    problems.push_back(std::string("the block could not be read: ") +
                       e.what());
    return nullptr;
  }
}

std::string AlduinakCombatSettings::Summary() const
{
  size_t materials = 0;
  for (auto& [kind, rows] : durability.repair.fallbackMaterial) {
    materials += rows.size();
  }
  const auto n = [](size_t value) { return std::to_string(value); };
  return "rows: " + n(weapons.size()) + " weapons, " + n(bows.size()) +
    " bows, " + n(crossbows.size()) + " crossbows, " + n(armor.size()) +
    " armor; keywords: " + n(weaponKeywords.size()) + " weapon, " +
    n(armorKeywords.size()) + " armor, " + n(aldCatMat.size()) +
    " AldCatMat; " + n(overrides.size()) + " overrides; " +
    n(raceOverride.size()) + " claw races; " + n(naturalDT.size()) +
    " creature races with natural DT; durability HP rows: " +
    n(durability.weaponHP.size()) + " weapon, " + n(durability.bowHP.size()) +
    " bow, " + n(durability.crossbowHP.size()) + " crossbow, " +
    n(durability.armorSetHP.size()) + " armor set; " + n(materials) +
    " repair fallback materials";
}
