#include "EquipmentBinding.h"
#include "NapiHelper.h"
#include "UpdateEquipmentMessage.h"

Napi::Value EquipmentBinding::Get(Napi::Env env, ScampServer& scampServer,
                                  uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);
  auto& equipment = actor.GetEquipment();
  auto equipmentDump = equipment.ToJson().dump();
  return NapiHelper::ParseJson(env, equipmentDump);
}

void EquipmentBinding::Set(Napi::Env env, ScampServer& scampServer,
                           uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();

  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);
  Equipment equipment;
  if (newValue.IsObject()) {
    auto equipmentDump = NapiHelper::Stringify(env, newValue);
    nlohmann::json j = nlohmann::json::parse(equipmentDump);
    equipment = Equipment::FromJson(j);
  }

  // Clients never apply numChanges 0, so the send always counts as a change
  equipment.numChanges = actor.GetEquipment().numChanges + 1;
  actor.SetEquipment(equipment);

  UpdateEquipmentMessage message;
  message.data = equipment;
  message.idx = actor.GetIdx();
  for (auto listener : actor.GetActorListeners()) {
    listener->GetActorToSendTo().SendToUser(message, true);
  }
}
