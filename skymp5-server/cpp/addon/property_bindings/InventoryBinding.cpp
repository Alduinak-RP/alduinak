#include "InventoryBinding.h"
#include "ConditionTag.h"
#include "Durability.h"
#include "NapiHelper.h"

Napi::Value InventoryBinding::Get(Napi::Env env, ScampServer& scampServer,
                                  uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);
  return NapiHelper::ParseJson(env, refr.GetInventory().ToJson());
}

void InventoryBinding::Set(Napi::Env env, ScampServer& scampServer,
                           uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();

  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);
  // Durability: the worn entries follow the conditions of the copies written here, a repair included
  MpActor* wearer =
    Durability::GetSettings(&partOne->worldState) ? refr.AsActor() : nullptr;
  const Inventory before = wearer ? refr.GetInventory() : Inventory();
  if (newValue.IsObject()) {
    auto inventoryDump = NapiHelper::Stringify(env, newValue);
    nlohmann::json j = nlohmann::json::parse(inventoryDump);
    auto inventory = Inventory::FromJson(j);
    // A written condition is stored as the server stores its own: steps of 1e-4, absent at 100%
    for (auto& entry : inventory.entries) {
      if (entry.condition) {
        entry.condition = ConditionTag::Stored(*entry.condition);
      }
    }
    refr.SetInventory(inventory);
  } else {
    refr.SetInventory(Inventory());
  }
  if (wearer) {
    Durability::SyncWorn(*wearer, &before);
  }
}
