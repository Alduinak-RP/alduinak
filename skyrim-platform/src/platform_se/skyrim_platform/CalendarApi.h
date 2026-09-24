#pragma once

#include "NapiHelper.h"

namespace CalendarApi {
Napi::Value SetRawDaysPassed(const Napi::CallbackInfo& info);

inline void Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("setRawDaysPassed",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(SetRawDaysPassed)));
}
}
