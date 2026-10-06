#pragma once

#include "NapiHelper.h"

namespace ModuleListApi {

Napi::Value GetLoadedModules(const Napi::CallbackInfo& info);

Napi::Value GetModuleSha256(const Napi::CallbackInfo& info);

void Register(Napi::Env env, Napi::Object& exports);

}
