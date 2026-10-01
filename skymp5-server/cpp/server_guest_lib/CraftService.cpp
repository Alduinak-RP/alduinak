#include "CraftService.h"
#include "libespm/IdMapping.h"
#include <fmt/format.h>

#include "ConditionsEvaluator.h"
#include "MpActor.h"
#include "PartOne.h"
#include "RawMessageData.h"
#include "TemperCap.h"
#include "WorldState.h"
#include "gamemode_events/CraftEvent.h"
#include <algorithm>
#include <fmt/ranges.h>
#include <spdlog/spdlog.h>
#include <vector>

CraftService::CraftService(PartOne& partOne_)
  : partOne(partOne_)
{
}

void CraftService::OnCraftItem(const RawMessageData& rawMsgData,
                               const Inventory& inputObjects,
                               uint32_t workbenchId, uint32_t resultObjectId,
                               std::optional<float> temperHealth)
{
  auto& workbench =
    partOne.worldState.GetFormAt<MpObjectReference>(workbenchId);

  auto& br = partOne.worldState.GetEspm().GetBrowser();
  auto& cache = partOne.worldState.GetEspmCache();
  auto base = br.LookupById(workbench.GetBaseId());

  spdlog::info("User {} tries to craft {:#x} on workbench {:#x}",
               rawMsgData.userId, resultObjectId, workbenchId);

  bool isFurnitureOrActivator =
    base.rec->GetType() == "FURN" || base.rec->GetType() == "ACTI";
  if (!isFurnitureOrActivator) {
    return spdlog::error("Unable to use {} as workbench",
                         base.rec->GetType().ToString());
  }

  MpActor* me = partOne.serverState.ActorByUser(rawMsgData.userId);
  if (!me) {
    return spdlog::error("Unable to craft without Actor attached");
  }

  auto workbenchBase = br.LookupById(workbench.GetBaseId());

  if (!workbenchBase.rec) {
    return spdlog::error("Workbench ref without base object {:x}",
                         workbench.GetFormId());
  }

  std::vector<uint32_t> workbenchKeywordIds =
    GetWorkbenchKeywordIds(workbenchBase, cache);

  const bool temper = temperHealth.has_value();

  // The engine takes the improved item out and puts it back, it is not a material
  Inventory materials;
  for (auto& entry : inputObjects.entries) {
    if (!temper || entry.baseId != resultObjectId) {
      materials.entries.push_back(entry);
    }
  }

  if (temper && !me->GetInventory().HasItem(resultObjectId)) {
    return spdlog::error("Unable to temper {:#x}, the actor doesn't hold it",
                         resultObjectId);
  }

  auto recipesList = FindRecipe(me, workbenchKeywordIds, br, materials,
                                resultObjectId, temper);

  if (recipesList.empty()) {
    return spdlog::error(
      "Recipe not found: inputObjects={}, workbenchId={:#x}, "
      "resultObjectId={:#x}",
      inputObjects.ToJson().dump(), workbenchId, resultObjectId);
  }

  if (recipesList.size() > 1) {
    spdlog::warn("Found more than 1 recipe ({}), using the 1st one",
                 recipesList.size());
  }

  auto recipe = reinterpret_cast<const espm::COBJ*>(recipesList[0].rec);
  if (temper) {
    return UseTemperRecipe(me, recipesList[0], br, resultObjectId,
                           *temperHealth);
  }
  UseCraftRecipe(me, recipe, cache, br, recipesList[0].fileIdx);
}

bool CraftService::RecipeItemsMatch(const espm::LookupResult& lookupRes,
                                    const Inventory& inputObjects,
                                    uint32_t resultObjectId, bool temper)
{
  auto recipe = reinterpret_cast<const espm::COBJ*>(lookupRes.rec);

  espm::CompressedFieldsCache dummyCache;
  auto recipeData = recipe->GetData(dummyCache);

  enum
  {
    ArmorTable = 0xadb78,
    SharpeningWheel = 0x88108
  };
  const bool isTemper = recipeData.benchKeywordId == ArmorTable ||
    recipeData.benchKeywordId == SharpeningWheel;
  if (isTemper != temper) {
    return false;
  }

  auto thisInputObjects = recipeData.inputObjects;
  for (auto& entry : thisInputObjects) {
    auto formId = lookupRes.ToGlobalId(entry.formId);
    if (inputObjects.GetItemCount(formId) != entry.count) {
      return false;
    }
  }
  auto formId = lookupRes.ToGlobalId(recipeData.outputObjectFormId);
  if (formId != resultObjectId) {
    return false;
  }
  return true;
}

std::vector<espm::LookupResult> CraftService::FindRecipe(
  std::optional<MpActor*> me,
  std::optional<std::vector<uint32_t>> workbenchKeywordIds,
  const espm::CombineBrowser& br, const Inventory& inputObjects,
  uint32_t resultObjectId, bool temper)
{
  if (allRecipes.empty()) {
    allRecipes = br.GetDistinctRecordsByType("COBJ");
  }

  std::vector<espm::LookupResult> candidatesConsideredUsable;

  for (auto& recipe : allRecipes) {
    if (!RecipeItemsMatch(recipe, inputObjects, resultObjectId, temper)) {
      continue;
    }

    spdlog::info("CraftService::FindRecipe - Recipe candidate found: {:x}",
                 recipe.ToGlobalId(recipe.rec->GetId()));

    const bool canBeUsed =
      ConsiderRecipeCandidate(me, workbenchKeywordIds, recipe);
    if (canBeUsed) {
      candidatesConsideredUsable.push_back(recipe);
      spdlog::info("CraftService::FindRecipe - Recipe candidate usable");
    } else {
      spdlog::info("CraftService::FindRecipe - Recipe candidate not usable");
    }
  }

  return candidatesConsideredUsable;
}

bool CraftService::ConsiderRecipeCandidate(
  std::optional<MpActor*> me,
  std::optional<std::vector<uint32_t>> workbenchKeywordIds,
  const espm::LookupResult& lookupRes)
{
  auto cobj = reinterpret_cast<const espm::COBJ*>(lookupRes.rec);
  auto cobjData = cobj->GetData(cache);

  bool finalConsiderationResult = true;

  if (me.has_value()) {
    bool evalRes = EvaluateCraftRecipeConditions(*me, cobjData, lookupRes);
    if (!evalRes) {
      spdlog::info("CraftService::ConsiderRecipeCandidate - Craft recipe "
                   "conditions are not met");
      finalConsiderationResult = false;
    }
  } else {
    spdlog::info("CraftService::ConsiderRecipeCandidate - Actor not "
                 "specified, skipping conditions check");
  }

  if (workbenchKeywordIds.has_value()) {
    auto recipeBenchKeywordId = lookupRes.ToGlobalId(cobjData.benchKeywordId);

    // Note: In the original game, setting the benchmark keyword to NONE
    // removes the recipe from all crafting stations.

    bool includes =
      std::any_of(workbenchKeywordIds->begin(), workbenchKeywordIds->end(),
                  [&](uint32_t id) { return id == recipeBenchKeywordId; });

    if (!includes) {
      std::vector<std::string> hexIds;
      hexIds.reserve(workbenchKeywordIds->size());
      for (auto id : *workbenchKeywordIds) {
        hexIds.push_back(fmt::format("{:x}", id));
      }

      spdlog::info("CraftService::ConsiderRecipeCandidate - Craft recipe "
                   "workbench keywords don't match: recipe one {:x} is not in "
                   "workbench ids {}",
                   recipeBenchKeywordId, fmt::join(hexIds, ", "));
      finalConsiderationResult = false;
    }

  } else {
    spdlog::info("CraftService::ConsiderRecipeCandidate - Workbench keyword "
                 "id not specified, skipping bench keyword id check");
  }

  return finalConsiderationResult;
}

void CraftService::UseCraftRecipe(MpActor* me, const espm::COBJ* recipeUsed,
                                  espm::CompressedFieldsCache& cache,
                                  const espm::CombineBrowser& br, int espmIdx)
{
  auto recipeData = recipeUsed->GetData(cache);
  auto mapping = br.GetCombMapping(espmIdx);

  spdlog::info("Using craft recipe with EDID {} from espm file with index {}",
               recipeUsed->GetEditorId(cache), espmIdx);

  std::vector<Inventory::Entry> entries;
  for (auto& entry : recipeData.inputObjects) {
    auto formId = espm::utils::GetMappedId(entry.formId, *mapping);
    entries.push_back({ formId, entry.count });
  }

  auto outputFormId =
    espm::utils::GetMappedId(recipeData.outputObjectFormId, *mapping);

  if (spdlog::should_log(spdlog::level::info)) {
    std::string s = fmt::format("User formId={:#x} crafted", me->GetFormId());
    for (const auto& entry : entries) {
      s += fmt::format(" -{:#x} x{}", entry.baseId, entry.count);
    }
    s += fmt::format(" +{:#x} x{}", outputFormId, recipeData.outputCount);
    spdlog::info("{}", s);
  }

  auto recipeId = espm::utils::GetMappedId(recipeUsed->GetId(), *mapping);

  CraftEvent craftEvent(me, outputFormId, recipeData.outputCount, recipeId,
                        entries);

  craftEvent.Fire(me->GetParent());
}

namespace {
constexpr uint16_t kHasSpell = 264;

// Rank markers a recipe asks for with HasSpell == 1, condition ids are relative to the recipe's plugin
template <class Callback>
void ForEachMarkerGate(
  const espm::LookupResult& recipe, const espm::COBJ::Data& recipeData,
  const std::unordered_map<uint32_t, TemperCap::Marker>& markers,
  const Callback& callback)
{
  for (const auto& ctda : recipeData.conditions) {
    if (ctda.functionIndex != kHasSpell || ctda.comparisonValue != 1.f ||
        ctda.GetOperator() != espm::CTDA::Operator::EqualTo) {
      continue;
    }
    const uint32_t spellId =
      recipe.ToGlobalId(ctda.GetDefaultData().firstParameter);
    auto it = markers.find(spellId);
    if (it != markers.end()) {
      callback(spellId, it->second);
    }
  }
}
}

void CraftService::LoadRankMarkers(const espm::CombineBrowser& br)
{
  rankMarkers.emplace();
  for (auto& spell : br.GetDistinctRecordsByType("SPEL")) {
    if (auto marker =
          TemperCap::ParseMarkerEditorId(spell.rec->GetEditorId(cache))) {
      rankMarkers->emplace(spell.ToGlobalId(spell.rec->GetId()), *marker);
    }
  }
  spdlog::info("CraftService found {} profession rank markers",
               rankMarkers->size());

  if (allRecipes.empty()) {
    allRecipes = br.GetDistinctRecordsByType("COBJ");
  }
  for (auto& recipe : allRecipes) {
    const auto recipeData =
      reinterpret_cast<const espm::COBJ*>(recipe.rec)->GetData(cache);
    auto& professions =
      benchProfessions[recipe.ToGlobalId(recipeData.benchKeywordId)];
    ForEachMarkerGate(recipe, recipeData, *rankMarkers,
                      [&](uint32_t, const TemperCap::Marker& marker) {
                        if (std::find(professions.begin(), professions.end(),
                                      marker.profession) ==
                            professions.end()) {
                          professions.push_back(marker.profession);
                        }
                      });
  }
}

float CraftService::GetMaxTemperHealth(MpActor* me,
                                       const espm::CombineBrowser& br,
                                       const espm::LookupResult& recipe)
{
  if (!rankMarkers) {
    LoadRankMarkers(br);
  }

  const auto recipeData =
    reinterpret_cast<const espm::COBJ*>(recipe.rec)->GetData(cache);
  std::vector<TemperCap::Gate> gates;
  ForEachMarkerGate(recipe, recipeData, *rankMarkers,
                    [&](uint32_t spellId, const TemperCap::Marker& marker) {
                      gates.push_back(
                        { marker.profession, me->IsSpellLearned(spellId) });
                    });

  const auto rankOf = [&](const std::string& profession) {
    int rank = 0;
    for (auto& [spellId, marker] : *rankMarkers) {
      if (marker.rank > rank && marker.profession == profession &&
          me->IsSpellLearned(spellId)) {
        rank = marker.rank;
      }
    }
    return rank;
  };

  static const std::vector<std::string> kNoProfessions;
  auto bench =
    benchProfessions.find(recipe.ToGlobalId(recipeData.benchKeywordId));
  const TemperCap::Cap cap = TemperCap::Resolve(
    gates, bench == benchProfessions.end() ? kNoProfessions : bench->second,
    rankOf);

  spdlog::info("CraftService - temper cap {} from {} for {} ({:#x})",
               TemperCap::RankName(cap.rank),
               cap.profession.empty() ? "no profession" : cap.profession,
               recipe.rec->GetEditorId(cache),
               recipe.ToGlobalId(recipe.rec->GetId()));

  return TemperCap::HealthOfRank(cap.rank);
}

void CraftService::UseTemperRecipe(MpActor* me,
                                   const espm::LookupResult& recipe,
                                   const espm::CombineBrowser& br,
                                   uint32_t itemId, float temperHealth)
{
  auto recipeUsed = reinterpret_cast<const espm::COBJ*>(recipe.rec);
  const int espmIdx = recipe.fileIdx;
  const float maxHealth = GetMaxTemperHealth(me, br, recipe);
  const float health = std::min(temperHealth, maxHealth);

  // The worn copy first, then the least improved one
  const Inventory::Entry* target = nullptr;
  for (auto& entry : me->GetInventory().entries) {
    if (entry.baseId != itemId || !entry.count) {
      continue;
    }
    if (!target) {
      target = &entry;
      continue;
    }
    const bool worn = entry.GetWorn() != Inventory::Worn::None;
    const bool targetWorn = target->GetWorn() != Inventory::Worn::None;
    if (worn != targetWorn) {
      if (worn) {
        target = &entry;
      }
    } else if (entry.health.value_or(1.f) < target->health.value_or(1.f)) {
      target = &entry;
    }
  }

  if (!target || health <= target->health.value_or(1.f) + 0.001f) {
    return spdlog::error("Temper of {:#x} to {} (max {}) is no improvement",
                         itemId, temperHealth, maxHealth);
  }

  Inventory::Entry from = *target;
  from.count = 1;
  Inventory::Entry to = from;
  to.health = health;

  auto recipeData = recipeUsed->GetData(cache);
  auto mapping = br.GetCombMapping(espmIdx);

  std::vector<Inventory::Entry> entries;
  for (auto& entry : recipeData.inputObjects) {
    entries.push_back(
      { espm::utils::GetMappedId(entry.formId, *mapping), entry.count });
  }

  auto recipeId = espm::utils::GetMappedId(recipeUsed->GetId(), *mapping);

  spdlog::info("User formId={:#x} tempered {:#x} to {} (asked {}, max {})",
               me->GetFormId(), itemId, health, temperHealth, maxHealth);

  CraftEvent craftEvent(me, itemId, 1, recipeId, entries, &from, &to);
  craftEvent.Fire(me->GetParent());
}

// KWDA holds ids relative to the bench plugin's master list, the recipe's bench keyword is compared as a combined id
std::vector<uint32_t> CraftService::GetWorkbenchKeywordIds(
  const espm::LookupResult& workbenchBase, espm::CompressedFieldsCache& cache)
{
  std::vector<uint32_t> ids = workbenchBase.rec->GetKeywordIds(cache);
  for (auto& id : ids) {
    id = workbenchBase.ToGlobalId(id);
  }
  return ids;
}

namespace {
// A raw id whose master index the recipe plugin does not declare stays as it is, so plain numbers pass through
std::string GlobalParameter(const espm::LookupResult& recipe, uint32_t rawId)
{
  const uint32_t mapped = recipe.ToGlobalId(rawId);
  return fmt::format("0x{:X}",
                     mapped == espm::IdMapping::kInvalid ? rawId : mapped);
}
}

bool CraftService::EvaluateCraftRecipeConditions(
  MpActor* me, const espm::COBJ::Data& recipeData,
  const espm::LookupResult& recipe)
{
  std::vector<Condition> conditions;
  std::transform(recipeData.conditions.begin(), recipeData.conditions.end(),
                 std::back_inserter(conditions), [&](const auto& ctda) {
                   auto condition = Condition::FromCtda(ctda);
                   // CTDA parameters are ids in the recipe plugin's own master list, actors hold combined ids
                   const auto data = ctda.GetDefaultData();
                   condition.parameter1 =
                     GlobalParameter(recipe, data.firstParameter);
                   condition.parameter2 =
                     GlobalParameter(recipe, data.secondParameter);
                   return condition;
                 });

  // TODO: aggressor and target terms are not relevant for crafting
  const MpActor& aggressor = *me;
  const MpActor& target = *me;

  bool evalRes_ = false;

  auto callback = [&](bool evalRes, std::vector<std::string>& strings) {
    evalRes_ = evalRes;

    if (!strings.empty()) {
      if (evalRes) {
        strings.insert(strings.begin(),
                       fmt::format("EvaluateConditions result is true"));
      } else {
        strings.insert(strings.begin(),
                       fmt::format("EvaluateConditions result is false"));
      }
    }
  };

  static const ConditionsEvaluatorSettings kDefaultSettings;

  static const ConditionFunctionMap kEmptyMap;

  auto worldState = me->GetParent();

  const ConditionsEvaluatorSettings& settings =
    worldState ? worldState->conditionsEvaluatorSettings : kDefaultSettings;

  const ConditionFunctionMap& conditionFunctionMap =
    worldState ? worldState->conditionFunctionMap : kEmptyMap;

  ConditionsEvaluator::EvaluateConditions(
    conditionFunctionMap, settings, ConditionsEvaluatorCaller::kCraft,
    conditions, aggressor, target, callback);

  return evalRes_;
}
