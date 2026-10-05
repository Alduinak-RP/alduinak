#include "AppearanceBinding.h"
#include "NapiHelper.h"
#include "UpdateAppearanceMessage.h"

Napi::Value AppearanceBinding::Get(Napi::Env env, ScampServer& scampServer,
                                   uint32_t formId)
{
  auto& partOne = scampServer.GetPartOne();

  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);
  auto& appearanceDump = actor.GetAppearanceAsJson();
  if (!appearanceDump.empty()) {
    return NapiHelper::ParseJson(env, appearanceDump);
  } else {
    return env.Null();
  }
}

void AppearanceBinding::Set(Napi::Env env, ScampServer& scampServer,
                            uint32_t formId, Napi::Value newValue)
{
  auto& partOne = scampServer.GetPartOne();
  auto& actor = partOne->worldState.GetFormAt<MpActor>(formId);
  std::optional<Appearance> appearance;
  if (newValue.IsObject()) {
    appearance = Appearance::FromJson(
      nlohmann::json::parse(NapiHelper::Stringify(env, newValue)));
  }
  // Deferred so a custom packet sent in the same tick arrives first
  actor.SetAppearanceAndBroadcast(appearance ? &*appearance : nullptr, true);
}
