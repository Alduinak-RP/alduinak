#pragma once
#include "libespm/Loader.h"
#include <cstdint>
#include <optional>
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
  float GetMaxTemperHealth(MpActor* me, const espm::CombineBrowser& br);

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

  void UseTemperRecipe(MpActor* me, const espm::COBJ* recipeUsed,
                       const espm::CombineBrowser& br, int espmIdx,
                       uint32_t itemId, float temperHealth);

  PartOne& partOne;
  // AldProf_<Label>_<Rank> marker spell ids and their rank index
  std::optional<std::vector<std::pair<uint32_t, int>>> rankMarkers;
  std::vector<espm::LookupResult> allRecipes;
  espm::CompressedFieldsCache cache;
};
