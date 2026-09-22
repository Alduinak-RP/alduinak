#include "LastAnimEventBinding.h"
#include "NapiHelper.h"

Napi::Value LastAnimEventBinding::Get(Napi::Env env, ScampServer& scampServer,
                                      uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& refr = partOne->worldState.GetFormAt<MpObjectReference>(formId);

  if (auto actor = refr.AsActor()) {
    auto animData = actor->GetLastAnimEvent();
    if (animData.has_value()) {
      return Napi::String::New(env, animData->animEventName);
    }
    return env.Null();
  }

  return env.Undefined();
}

void LastAnimEventBinding::Set(Napi::Env env, ScampServer& scampServer,
                               uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();

  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);

  std::string animEventName;
  if (!newValue.IsNull() && !newValue.IsUndefined()) {
    animEventName = NapiHelper::ExtractString(newValue, "lastAnimEvent");
  }

  if (animEventName.empty()) {
    actor.SetLastAnimEvent(std::nullopt);
    return;
  }

  actor.SetLastAnimEventAndBroadcast(animEventName);
}
