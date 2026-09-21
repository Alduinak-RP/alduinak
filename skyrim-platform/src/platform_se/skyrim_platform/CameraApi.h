#pragma once

#include "NapiHelper.h"

namespace CameraApi {
Napi::Value WorldPointToScreenPoint(const Napi::CallbackInfo& info);
Napi::Value SetFreeCameraMode(const Napi::CallbackInfo& info);
Napi::Value SetFov(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("worldPointToScreenPoint",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(WorldPointToScreenPoint)));
  exports.Set("setFreeCameraMode",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(SetFreeCameraMode)));
  exports.Set("setFov",
              Napi::Function::New(env,
                                  NapiHelper::WrapCppExceptions(SetFov)));
}
}
