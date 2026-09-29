#include <NirnLabUIPlatformAPI/API.h>

#include "BrowserApiTilted.h"
#include "NullPointerException.h"
#include "TPOverlayService.h"

namespace {

thread_local bool g_cursorIsOpenByFocus = false;

// The name of an open vanilla menu that draws the cursor, empty when none is
std::string MenuUsingCursor(RE::UI* ui)
{
  for (auto& menu : ui->menuStack) {
    if (!menu || !menu->menuFlags.all(RE::IMenu::Flag::kUsesCursor)) {
      continue;
    }
    for (auto& entry : ui->menuMap) {
      if (entry.second.menu.get() == menu.get()) {
        return entry.first.c_str();
      }
    }
    return "?";
  }
  return "";
}

inline CEFUtils::MyChromiumApp& GetApp()
{
  auto overlayService = OverlayService::GetInstance();
  if (!overlayService) {
    throw NullPointerException("overlayService");
  }

  auto app = overlayService->GetMyChromiumApp();
  if (!app) {
    throw NullPointerException("app");
  }

  return *app;
}
}

Napi::Value BrowserApiTilted::SetVisible(const Napi::CallbackInfo& info)
{
  bool& v = CEFUtils::DX11RenderHandler::Visible();
  v = NapiHelper::ExtractBoolean(info[0], "visible");
  return info.Env().Undefined();
}

Napi::Value BrowserApiTilted::IsVisibleJS(const Napi::CallbackInfo& info)
{
  return Napi::Boolean::New(info.Env(), IsVisible());
}

bool BrowserApiTilted::IsVisible()
{
  return CEFUtils::DX11RenderHandler::Visible();
}

Napi::Value BrowserApiTilted::SetFocused(const Napi::CallbackInfo& info)
{
  bool& v = CEFUtils::DInputHook::ChromeFocus();
  bool newFocus = NapiHelper::ExtractBoolean(info[0], "focused");
  if (v != newFocus) {
    v = newFocus;
    spdlog::info("Browser focus {} -> {}, {}", !newFocus, newFocus,
                 CEFUtils::DInputHook::DescribeInputState());

    auto ui = RE::UI::GetSingleton();
    auto msgQ = RE::UIMessageQueue::GetSingleton();

    if (!ui || !msgQ) {
      return info.Env().Undefined();
    }

    const bool alreadyOpen = ui->IsMenuOpen(RE::CursorMenu::MENU_NAME);

    if (newFocus) {
      if (!alreadyOpen) {
        msgQ->AddMessage(RE::CursorMenu::MENU_NAME, RE::UI_MESSAGE_TYPE::kShow,
                         NULL);
        g_cursorIsOpenByFocus = true;
      }
    } else {
      if (g_cursorIsOpenByFocus) {
        // A vanilla menu opened while the page had focus still needs the cursor; it hides it itself when it closes
        const auto keptFor = MenuUsingCursor(ui);
        if (keptFor.empty()) {
          msgQ->AddMessage(RE::CursorMenu::MENU_NAME,
                           RE::UI_MESSAGE_TYPE::kHide, NULL);
        } else {
          spdlog::info("Browser unfocused under {}, cursor kept", keptFor);
        }
        g_cursorIsOpenByFocus = false;
      }
    }
  }
  return info.Env().Undefined();
}

Napi::Value BrowserApiTilted::IsFocused(const Napi::CallbackInfo& info)
{
  return Napi::Boolean::New(info.Env(), CEFUtils::DInputHook::ChromeFocus());
}

Napi::Value BrowserApiTilted::LoadUrl(const Napi::CallbackInfo& info)
{
  auto str = NapiHelper::ExtractString(info[0], "url");
  return Napi::Boolean::New(info.Env(), GetApp().LoadUrl(str.data()));
}

Napi::Value BrowserApiTilted::ExecuteJavaScript(const Napi::CallbackInfo& info)
{
  auto str = NapiHelper::ExtractString(info[0], "src");
  GetApp().ExecuteJavaScript(str);
  return info.Env().Undefined();
}
