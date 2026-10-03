#pragma once

#include "NapiHelper.h"

namespace ObjectReferenceApi {

Napi::Value SetCollision(const Napi::CallbackInfo& info);
Napi::Value GetLookSurface(const Napi::CallbackInfo& info);
Napi::Value MountActor(const Napi::CallbackInfo& info);
Napi::Value SetCarryHold(const Napi::CallbackInfo& info);
Napi::Value ClearCarryHold(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set(
    "setCollision",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetCollision)));
  exports.Set(
    "getLookSurface",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(GetLookSurface)));
  exports.Set(
    "mountActor",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(MountActor)));
  exports.Set(
    "setCarryHold",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(SetCarryHold)));
  exports.Set(
    "clearCarryHold",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(ClearCarryHold)));
}
}
