#pragma once
#include "ItemRowRules.h"
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <unordered_set>

class WorldState;

// Resolves WEAP and ARMO bases to the rows of alduinakDamageFormulaSettings, shared by the damage formula and durability
class ItemRowResolver
{
public:
  explicit ItemRowResolver(
    std::shared_ptr<const AlduinakCombatSettings> settings_);

  [[nodiscard]] const AlduinakCombatSettings& GetSettings() const noexcept
  {
    return *settings;
  }

  // Binds editor ids and form keys to the load order and logs the report, once
  void Bind(WorldState& worldState);

  // Row of a WEAP or ARMO base, kind None for anything else, cached per base id
  const ItemRows::ItemRow& Resolve(uint32_t baseId, WorldState& worldState);

  // Null unless the race has an unarmed.raceOverride entry
  const ItemRows::ItemRow* GetClawRow(uint32_t raceId, WorldState& worldState);

  // npc.naturalDT of a creature race, 0 without an entry
  float GetNaturalDT(uint32_t raceId, WorldState& worldState);

  // True for a base durability.exempt names
  bool IsExempt(uint32_t baseId, WorldState& worldState);

  // durability.repair.fallbackMaterial of the item's kind and row, 0 without one
  uint32_t GetRepairFallbackMaterial(const ItemRows::ItemRow& item,
                                     WorldState& worldState);

private:
  ItemRows::ItemRow Classify(uint32_t baseId, WorldState& worldState,
                             std::string* editorId) const;
  void BindKeywords(WorldState& worldState);
  void BindFormKeys(WorldState& worldState);
  void BindRaces(WorldState& worldState);
  void LogCoverage(WorldState& worldState) const;

  std::shared_ptr<const AlduinakCombatSettings> settings;
  bool bound = false;
  // Editor ids of the keywords the rules read, by form id
  std::unordered_map<uint32_t, std::string> keywordNames;
  std::unordered_map<uint32_t, std::string> overrideRows;
  std::unordered_map<uint32_t, ItemRows::ItemRow> clawRows;
  std::unordered_map<uint32_t, float> naturalDT;
  std::unordered_set<uint32_t> exempt;
  // "<kind>/<row>" to the material's form id
  std::unordered_map<std::string, uint32_t> repairMaterials;
  std::unordered_map<uint32_t, ItemRows::ItemRow> cache;
};
