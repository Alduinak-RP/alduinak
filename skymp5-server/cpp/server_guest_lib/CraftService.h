#pragma once
#include "TemperCap.h"
#include "libespm/Loader.h"
#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

class PartOne;
class Inventory;
struct RawMessageData;
class MpActor;

class CraftService
{
public:
  explicit CraftService(PartOne& partOne_);

  void OnCraftItem(const RawMessageData& rawMsgData,
                   const Inventory& inputObjects, uint32_t workbenchId,
                   uint32_t resultObjectId,
                   std::optional<float> temperHealth = std::nullopt);

  // public for CraftTest.cpp
  bool RecipeItemsMatch(const espm::LookupResult& lookupRes,
                        const Inventory& inputObjects,
                        uint32_t resultObjectId, bool temper = false);

  // public for CraftTest.cpp
  std::vector<espm::LookupResult> FindRecipe(
    std::optional<MpActor*> me,
    std::optional<std::vector<uint32_t>> workbenchKeywordIds,
    const espm::CombineBrowser& br, const Inventory& inputObjects,
    uint32_t resultObjectId, bool temper = false);

  // public for CraftTest.cpp
  float GetMaxTemperHealth(MpActor* me, const espm::CombineBrowser& br,
                           const espm::LookupResult& recipe);

  // public for CraftTest.cpp
  bool EvaluateCraftRecipeConditions(MpActor* me,
                                     const espm::COBJ::Data& recipeData,
                                     const espm::LookupResult& recipe);

  // public for CraftTest.cpp
  static std::vector<uint32_t> GetWorkbenchKeywordIds(
    const espm::LookupResult& workbenchBase,
    espm::CompressedFieldsCache& cache);

private:
  bool ConsiderRecipeCandidate(
    std::optional<MpActor*> me,
    std::optional<std::vector<uint32_t>> workbenchKeywordIds,
    const espm::LookupResult& lookupRes);

  void UseCraftRecipe(MpActor* me, const espm::COBJ* recipeUsed,
                      espm::CompressedFieldsCache& cache,
                      const espm::CombineBrowser& br, int espmIdx);

  void UseTemperRecipe(MpActor* me, const espm::LookupResult& recipe,
                       const espm::CombineBrowser& br, uint32_t itemId,
                       float temperHealth);

  void LoadRankMarkers(const espm::CombineBrowser& br);

  PartOne& partOne;
  // AldProf_<Label>_<Rank> marker spell ids with their profession and rank
  std::optional<std::unordered_map<uint32_t, TemperCap::Marker>> rankMarkers;
  // Professions whose markers gate a recipe of the bench keyword
  std::unordered_map<uint32_t, std::vector<std::string>> benchProfessions;
  std::vector<espm::LookupResult> allRecipes;
  espm::CompressedFieldsCache cache;
};
