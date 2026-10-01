#include "ItemRowResolver.h"

#include "FormDesc.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <map>
#include <optional>
#include <set>
#include <spdlog/spdlog.h>
#include <stdexcept>
#include <vector>

namespace {

using ItemRows::ItemRow;
using ItemRows::Kind;

constexpr const char* kFixedKeywords[] = { "WeapTypeWarhammer",
                                           "WeapMaterialDwarven",
                                           "ArmorClothing", "ArmorJewelry",
                                           "ArmorShield" };
constexpr const char* kMultiPrefix = "IAKMaterial";

// Form id of a "<hex id>:<plugin>" key, nullopt when the plugin or the record is not loaded
std::optional<uint32_t> ToLoadedId(const std::string& key,
                                   WorldState& worldState)
{
  try {
    const uint32_t id =
      FormDesc::FromString(key).ToFormId(worldState.espmFiles);
    if (worldState.GetEspm().GetBrowser().LookupById(id).rec) {
      return id;
    }
  } catch (const std::exception&) {
  }
  return std::nullopt;
}

// At most five names, then the count of the rest
std::string Listed(const std::vector<std::string>& names)
{
  std::string text;
  for (size_t i = 0; i < names.size() && i < 5; ++i) {
    text += (i ? ", " : "") + names[i];
  }
  if (names.size() > 5) {
    text += " and " + std::to_string(names.size() - 5) + " more";
  }
  return text;
}

const char* RepairKind(Kind kind)
{
  switch (kind) {
    case Kind::Weapon:
      return "weapon";
    case Kind::Bow:
      return "bow";
    case Kind::Crossbow:
      return "crossbow";
    case Kind::Armor:
    case Kind::Shield:
      return "armor";
    default:
      return nullptr;
  }
}

}

ItemRowResolver::ItemRowResolver(
  std::shared_ptr<const AlduinakCombatSettings> settings_)
  : settings(std::move(settings_))
{
  if (!settings) {
    throw std::runtime_error("ItemRowResolver needs settings");
  }
}

void ItemRowResolver::Bind(WorldState& worldState)
{
  if (bound || !worldState.HasEspm()) {
    return;
  }
  bound = true;
  const auto step = [&](const char* name, auto&& bind) {
    try {
      bind();
    } catch (const std::exception& e) {
      spdlog::error("ItemRowResolver: {} failed, what is not bound resolves "
                    "by the other rules: {}",
                    name, e.what());
    }
  };
  step("binding the keywords", [&] { BindKeywords(worldState); });
  step("binding the form keys", [&] { BindFormKeys(worldState); });
  step("binding the races", [&] { BindRaces(worldState); });
  step("the coverage count", [&] { LogCoverage(worldState); });
}

void ItemRowResolver::BindKeywords(WorldState& worldState)
{
  std::set<std::string> named(std::begin(kFixedKeywords),
                              std::end(kFixedKeywords));
  for (auto* list : { &settings->weaponKeywords, &settings->armorKeywords,
                      &settings->aldCatMat }) {
    for (auto& [keyword, row] : *list) {
      named.insert(keyword);
    }
  }
  auto& cache = worldState.GetEspmCache();
  std::set<std::string> found;
  for (auto& keyword :
       worldState.GetEspm().GetBrowser().GetDistinctRecordsByType("KYWD")) {
    const std::string editorId = keyword.rec->GetEditorId(cache);
    if (named.count(editorId) || editorId.rfind(kMultiPrefix, 0) == 0) {
      keywordNames[keyword.ToGlobalId(keyword.rec->GetId())] = editorId;
      found.insert(editorId);
    }
  }
  std::vector<std::string> missing;
  for (auto& keyword : named) {
    if (!found.count(keyword)) {
      missing.push_back(keyword);
    }
  }
  spdlog::info("ItemRowResolver: {} of {} named keywords are in the load "
               "order, {} keyword records bound",
               named.size() - missing.size(), named.size(),
               keywordNames.size());
  if (!missing.empty()) {
    spdlog::info("ItemRowResolver: keywords not in the load order, no item "
                 "can carry them: {}",
                 Listed(missing));
  }
}

void ItemRowResolver::BindFormKeys(WorldState& worldState)
{
  std::vector<std::string> missing;
  for (auto& [key, row] : settings->overrides) {
    if (auto id = ToLoadedId(key, worldState)) {
      overrideRows[*id] = row;
    } else {
      missing.push_back(key);
    }
  }
  spdlog::info("ItemRowResolver: {} of {} overrides bound",
               overrideRows.size(), settings->overrides.size());
  if (!missing.empty()) {
    spdlog::warn("ItemRowResolver: {} overrides name a record that is not in "
                 "the load order, those items resolve by keyword: {}",
                 missing.size(), Listed(missing));
  }

  missing.clear();
  for (auto& [key, dt] : settings->naturalDT) {
    if (auto id = ToLoadedId(key, worldState)) {
      naturalDT[*id] = dt;
    } else {
      missing.push_back(key);
    }
  }
  if (!missing.empty()) {
    spdlog::warn("ItemRowResolver: {} npc.naturalDT races are not in the load "
                 "order: {}",
                 missing.size(), Listed(missing));
  }

  missing.clear();
  for (auto& key : settings->durability.exempt) {
    if (auto id = ToLoadedId(key, worldState)) {
      exempt.insert(*id);
    } else {
      missing.push_back(key);
    }
  }
  size_t materials = 0;
  for (auto& [kind, rows] : settings->durability.repair.fallbackMaterial) {
    for (auto& [row, key] : rows) {
      ++materials;
      if (auto id = ToLoadedId(key, worldState)) {
        repairMaterials[kind + "/" + row] = *id;
      } else {
        missing.push_back(key + " (" + kind + " " + row + ")");
      }
    }
  }
  if (!missing.empty()) {
    spdlog::warn("ItemRowResolver: {} durability form keys are not in the "
                 "load order: {}",
                 missing.size(), Listed(missing));
  }
  spdlog::info("ItemRowResolver: {} of {} creature races with natural DT, {} "
               "of {} repair fallback materials and {} of {} exempt bases "
               "bound",
               naturalDT.size(), settings->naturalDT.size(),
               repairMaterials.size(), materials, exempt.size(),
               settings->durability.exempt.size());
}

void ItemRowResolver::BindRaces(WorldState& worldState)
{
  if (settings->raceOverride.empty()) {
    return;
  }
  auto& cache = worldState.GetEspmCache();
  std::set<std::string> found;
  for (auto& race :
       worldState.GetEspm().GetBrowser().GetDistinctRecordsByType("RACE")) {
    const std::string editorId = race.rec->GetEditorId(cache);
    auto it = settings->raceOverride.find(editorId);
    if (it != settings->raceOverride.end()) {
      clawRows[race.ToGlobalId(race.rec->GetId())] =
        ItemRows::ClawRow(*settings, it->second);
      found.insert(editorId);
    }
  }
  std::string report;
  std::vector<std::string> missing;
  for (auto& [race, entry] : settings->raceOverride) {
    if (!found.count(race)) {
      missing.push_back(race);
      continue;
    }
    const auto claws = ItemRows::ClawRow(*settings, entry);
    report += fmt::format("{}{} = {} {} ({})", report.empty() ? "" : ", ",
                          race, claws.row,
                          ItemRows::WeaponTypeName(claws.type), claws.damage);
  }
  spdlog::info("ItemRowResolver: unarmed.raceOverride {}",
               report.empty() ? "has no race of the load order" : report);
  if (!missing.empty()) {
    spdlog::warn("ItemRowResolver: unarmed.raceOverride races not in the load "
                 "order: {}",
                 Listed(missing));
  }
}

void ItemRowResolver::LogCoverage(WorldState& worldState) const
{
  const auto joined = [](const std::map<std::string, size_t>& counts) {
    std::string text;
    for (auto& [name, count] : counts) {
      text += fmt::format("{}{} {}", text.empty() ? "" : ", ", name, count);
    }
    return text;
  };
  auto& br = worldState.GetEspm().GetBrowser();
  for (const char* type : { "WEAP", "ARMO" }) {
    std::map<std::string, size_t> kinds, rules;
    size_t total = 0, failed = 0, noShare = 0;
    for (auto& record : br.GetDistinctRecordsByType(type)) {
      ++total;
      try {
        const auto item = Classify(record.ToGlobalId(record.rec->GetId()),
                                   worldState, nullptr);
        ++kinds[ItemRows::KindName(item.kind)];
        if (!item.row.empty()) {
          ++rules[item.rule];
        }
        if (item.kind == Kind::Armor && item.slotShare == 0.f) {
          ++noShare;
        }
      } catch (const std::exception&) {
        ++failed;
      }
    }
    spdlog::info("ItemRowResolver: {} {} records: {}; rows by rule: {}{}{}",
                 total, type, joined(kinds), joined(rules),
                 noShare
                   ? fmt::format("; {} armor pieces cover no DT slot", noShare)
                   : "",
                 failed ? fmt::format("; {} could not be read", failed) : "");
  }
}

ItemRow ItemRowResolver::Classify(uint32_t baseId, WorldState& worldState,
                                  std::string* editorId) const
{
  auto& br = worldState.GetEspm().GetBrowser();
  auto& espmCache = worldState.GetEspmCache();
  const auto res = br.LookupById(baseId);
  if (!res.rec) {
    return {};
  }
  const bool weapon = res.rec->GetType() == espm::WEAP::kType;
  if (!weapon && !(res.rec->GetType() == espm::ARMO::kType)) {
    return {};
  }
  if (editorId) {
    *editorId = res.rec->GetEditorId(espmCache);
  }

  std::vector<std::string> keywords;
  for (uint32_t rawId : res.rec->GetKeywordIds(espmCache)) {
    auto it = keywordNames.find(res.ToGlobalId(rawId));
    if (it != keywordNames.end()) {
      keywords.push_back(it->second);
    }
  }
  std::optional<std::string> overrideRow;
  if (auto it = overrideRows.find(baseId); it != overrideRows.end()) {
    overrideRow = it->second;
  }

  if (weapon) {
    const auto data = espm::Convert<espm::WEAP>(res.rec)->GetData(espmCache);
    ItemRows::WeaponFacts facts;
    facts.animType =
      data.weapDNAM ? static_cast<uint8_t>(data.weapDNAM->animType) : 0;
    facts.keywords = std::move(keywords);
    facts.overrideRow = std::move(overrideRow);
    return ItemRows::ClassifyWeapon(*settings, facts);
  }

  const auto data = espm::Convert<espm::ARMO>(res.rec)->GetData(espmCache);
  ItemRows::ArmorFacts facts;
  if (data.bod2.present) {
    facts.bipedFlags = data.bod2.bodyPartFlags;
    facts.armorType = data.bod2.skill;
  } else if (data.bodt.present) {
    facts.bipedFlags = data.bodt.bodyPartFlags;
    facts.armorType = data.bodt.skill;
  }
  facts.keywords = std::move(keywords);
  facts.overrideRow = std::move(overrideRow);
  return ItemRows::ClassifyArmor(*settings, facts);
}

const ItemRow& ItemRowResolver::Resolve(uint32_t baseId,
                                        WorldState& worldState)
{
  static const ItemRow kNone;
  if (!worldState.HasEspm()) {
    return kNone;
  }
  Bind(worldState);
  auto it = cache.find(baseId);
  if (it != cache.end()) {
    return it->second;
  }
  ItemRow item;
  std::string editorId;
  try {
    item = Classify(baseId, worldState, &editorId);
  } catch (const std::exception& e) {
    spdlog::warn("ItemRowResolver - {:#x} could not be read, it counts as no "
                 "weapon or armor: {}",
                 baseId, e.what());
  }
  if (item.fallback) {
    spdlog::info("ItemRowResolver - {:#x} ({}) has no material row, it takes "
                 "the fallback row {} of its {} ({})",
                 baseId, editorId, item.row, ItemRows::KindName(item.kind),
                 item.rule);
  }
  return cache.emplace(baseId, std::move(item)).first->second;
}

const ItemRow* ItemRowResolver::GetClawRow(uint32_t raceId,
                                           WorldState& worldState)
{
  Bind(worldState);
  auto it = clawRows.find(raceId);
  return it == clawRows.end() ? nullptr : &it->second;
}

float ItemRowResolver::GetNaturalDT(uint32_t raceId, WorldState& worldState)
{
  Bind(worldState);
  auto it = naturalDT.find(raceId);
  return it == naturalDT.end() ? 0.f : it->second;
}

bool ItemRowResolver::IsExempt(uint32_t baseId, WorldState& worldState)
{
  Bind(worldState);
  return exempt.count(baseId) != 0;
}

uint32_t ItemRowResolver::GetRepairFallbackMaterial(const ItemRow& item,
                                                    WorldState& worldState)
{
  Bind(worldState);
  const char* kind = RepairKind(item.kind);
  if (!kind) {
    return 0;
  }
  auto it = repairMaterials.find(std::string(kind) + "/" + item.row);
  return it == repairMaterials.end() ? 0 : it->second;
}
