#pragma once

#include "NapiHelper.h"

namespace InventoryApi {

Napi::Value GetExtraContainerChanges(const Napi::CallbackInfo& info);
Napi::Value GetContainer(const Napi::CallbackInfo& info);
Napi::Value SetInventory(const Napi::CallbackInfo& info);
Napi::Value CreateEnchantment(const Napi::CallbackInfo& info);

// The engine frees created enchantments nobody references; clients keep them for the session
void RetainCreatedEnchantment(RE::EnchantmentItem* enchantment);

void Register(Napi::Env env, Napi::Object& exports);
}
