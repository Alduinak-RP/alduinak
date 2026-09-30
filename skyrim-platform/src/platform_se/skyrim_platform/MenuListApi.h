#pragma once

#include "NapiHelper.h"

namespace MenuListApi {

Napi::Value HideMenuListEntries(const Napi::CallbackInfo& info);

void Register(Napi::Env env, Napi::Object& exports);

}
