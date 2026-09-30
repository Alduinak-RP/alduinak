#include "MenuListApi.h"
#include "CallNativeApi.h"

#include <set>

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

// filterFlag 0 hides the listed entries from a ListFilterer; returns all texts
Napi::Value MenuListApi::HideMenuListEntries(const Napi::CallbackInfo& info)
{
  const auto menuName = NapiHelper::ExtractString(info[0], "menuName");
  const auto entriesPath = NapiHelper::ExtractString(info[1], "entriesPath");
  const auto textsArg = NapiHelper::ExtractArray(info[2], "texts");

  std::set<std::string> hidden;
  for (uint32_t i = 0; i < textsArg.Length(); ++i) {
    hidden.insert(NapiHelper::ExtractString(textsArg.Get(i), "texts[i]"));
  }

  // The movie is only touched while the game thread waits on an update
  if (!g_nativeCallRequirements.vm) {
    throw std::runtime_error(
      "hideMenuListEntries can't be called in this context");
  }

  auto env = info.Env();
  const auto ui = RE::UI::GetSingleton();
  const auto view =
    ui ? ui->GetMovieView(menuName) : RE::GPtr<RE::GFxMovieView>();
  RE::GFxValue entries;
  if (!view || !view->GetVariable(&entries, entriesPath.c_str()) ||
      !entries.IsArray()) {
    return env.Null();
  }

  const auto size = entries.GetArraySize();
  auto texts = Napi::Array::New(env, size);
  for (uint32_t i = 0; i < size; ++i) {
    std::string text;
    RE::GFxValue entry;
    if (entries.GetElement(i, &entry) && entry.IsObject()) {
      RE::GFxValue value;
      if (entry.GetMember("text", &value) && value.IsString()) {
        text = value.GetString();
      }
      if (hidden.count(text)) {
        entry.SetMember("filterFlag", RE::GFxValue(0.0));
      }
    }
    texts.Set(i, Napi::String::New(env, text));
  }
  return texts;
}

void MenuListApi::Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("hideMenuListEntries",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(HideMenuListEntries)));
}
