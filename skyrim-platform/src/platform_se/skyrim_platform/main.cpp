#include <NirnLabUIPlatformAPI/API.h>

#include "BrowserApi.h"
#include "BrowserApiNirnLab.h"
#include "CallNativeApi.h"
#include "ConsoleApi.h"
#include "DumpFunctions.h"
#include "EventHandler.h"
#include "EventManager.h"
#include "EventsApi.h"
#include "FlowManager.h"
#include "FridaHooks.h"
#include "Hooks.h"
#include "IPC.h"
#include "InputConverter.h"
#include "PapyrusTESModPlatform.h"
#include "Settings.h"
#include "SkyrimPlatform.h"
#include "TPOverlayService.h"
#include "TPRenderSystemD3D11.h"
#include "TextApi.h"
#include "TextsCollection.h"

#include <atomic>
#include <cstring>
#include <cwchar>
#include <string>
#include <thread>

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

void GetTextsToDraw(TextToDrawCallback callback)
{
  switch (TextApi::GetTextsVisibility()) {
    case TextApi::TextsVisibility::kInheritBrowser:
      if (!BrowserApi::IsVisible()) {
        // skip
        return;
      }
      // pass
      break;
    case TextApi::TextsVisibility::kOff:
      // skip
      return;
    case TextApi::TextsVisibility::kOn:
      // pass
      break;
    default:
      // unhandled value
      return;
  }

  auto text = &TextsCollection::GetSingleton();

  for (const auto& a : TextsCollection::GetSingleton().GetCreatedTexts()) {
    if (a.second.refrDirty) {
      continue;
    }
    callback(a.second);
  }
}

void UpdateDumpFunctions()
{
  auto pressed = [](int key) {
    return (GetAsyncKeyState(key) & 0x80000000) > 0;
  };
  const bool comb = pressed('9') && pressed('O') && pressed('L');
  static bool g_combWas = false;

  if (comb != g_combWas) {
    g_combWas = comb;
    if (comb)
      DumpFunctions::Run();
  }
}

void OnUpdate(IVM* vm, StackID stackId)
{
  UpdateDumpFunctions();

  g_nativeCallRequirements.stackId = stackId;
  g_nativeCallRequirements.vm = vm;
  SkyrimPlatform::GetSingleton()->PrepareWorker();
  SkyrimPlatform::GetSingleton()->Push([=](Napi::Env env) {
    SkyrimPlatform::GetSingleton()->JsTick(env, true);
    SkyrimPlatform::GetSingleton()->StopWorker();
  });
  SkyrimPlatform::GetSingleton()->StartWorker();
  g_nativeCallRequirements.gameThrQ->Update(Viet::Void());
  g_nativeCallRequirements.stackId = std::numeric_limits<StackID>::max();
  g_nativeCallRequirements.vm = nullptr;
}

void InitLog()
{
  auto path = logger::log_directory();
  if (!path) {
    stl::report_and_fail("Failed to find standard logging directory"sv);
  }

  *path /= "skyrim-platform.log"sv;

  const auto pathStr = path->string();

  auto sink =
    std::make_shared<spdlog::sinks::basic_file_sink_mt>(pathStr, true);

  auto log = std::make_shared<spdlog::logger>("global log", std::move(sink));

  auto settings = Settings::GetPlatformSettings();
  auto logLevel =
    settings->GetInteger("Debug", "LogLevel", spdlog::level::level_enum::info);

  log->set_level(logLevel);
  log->flush_on(logLevel);

  spdlog::set_default_logger(std::move(log));
  spdlog::set_pattern("[%H:%M:%S:%e] %v"s);

  logger::info(FMT_STRING("{} v{}"), Version::PROJECT, Version::NAME);
}

void InitCmd()
{
  auto settings = Settings::GetPlatformSettings();
  bool isCmd = settings->GetBool("Debug", "CMD", false);

  if (!isCmd) {
    return;
  }

  int offsetLeft = settings->GetInteger("Debug", "CmdOffsetLeft", 0);
  int offsetTop = settings->GetInteger("Debug", "CmdOffsetTop", 720);
  int width = settings->GetInteger("Debug", "CmdWidth", 1900);
  int height = settings->GetInteger("Debug", "CmdHeight", 317);
  bool isAlwaysOnTop = settings->GetBool("Debug", "CmdIsAlwaysOnTop", false);

  ConsoleApi::InitCmd(offsetLeft, offsetTop, width, height, isAlwaysOnTop);
}

extern "C" {
DLLEXPORT uint32_t SkyrimPlatform_IpcSubscribe_Impl(
  const char* systemName, IPC::MessageCallback callback, void* state)
{
  return IPC::Subscribe(systemName, callback, state);
}

DLLEXPORT void SkyrimPlatform_IpcUnsubscribe_Impl(uint32_t subscriptionId)
{
  return IPC::Unsubscribe(subscriptionId);
}

DLLEXPORT void SkyrimPlatform_IpcSend_Impl(const char* systemName,
                                           const uint8_t* data,
                                           uint32_t length)
{
  return IPC::Send(systemName, data, length);
}

DLLEXPORT bool SKSEAPI SKSEPlugin_Load_Impl(const SKSE::LoadInterface* skse)
{
  InitLog();

  InitCmd();

  logger::info("Loading plugin.");

  SKSE::Init(skse);
  SKSE::AllocTrampoline(64);

  const auto papyrusInterface = SKSE::GetPapyrusInterface();
  if (!papyrusInterface) {
    logger::critical("QueryInterface failed for PapyrusInterface");
    return false;
  }

  papyrusInterface->Register(TESModPlatform::Register);

  const auto messagingInterface = SKSE::GetMessagingInterface();
  if (!messagingInterface) {
    logger::critical("QueryInterface failed for MessagingInterface");
    return false;
  }

  SKSE::GetMessagingInterface()->RegisterListener(
    [](SKSE::MessagingInterface::Message* a_msg) {
      EventHandler::HandleSKSEMessage(a_msg);
      BrowserApiNirnLab::GetInstance().HandleSkseMessage(a_msg);
    });

  Hooks::Install();
  Frida::InstallHooks();

  // init custom events first
  // and the rest at DataLoaded, to be safe
  EventManager::InitCustom();

  TESModPlatform::onPapyrusUpdate = OnUpdate;

  return true;
}
};

inline uint32_t GetCefModifiers_(uint16_t aVirtualKey)
{
  uint32_t modifiers = EVENTFLAG_NONE;

  if (GetAsyncKeyState(VK_MENU) & 0x8000) {
    modifiers |= EVENTFLAG_ALT_DOWN;
  }

  if (GetAsyncKeyState(VK_CONTROL) & 0x8000) {
    modifiers |= EVENTFLAG_CONTROL_DOWN;
  }

  if (GetAsyncKeyState(VK_SHIFT) & 0x8000) {
    modifiers |= EVENTFLAG_SHIFT_DOWN;
  }

  if (GetAsyncKeyState(VK_LBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_LEFT_MOUSE_BUTTON;
  }

  if (GetAsyncKeyState(VK_RBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_RIGHT_MOUSE_BUTTON;
  }

  if (GetAsyncKeyState(VK_MBUTTON) & 0x8000) {
    modifiers |= EVENTFLAG_MIDDLE_MOUSE_BUTTON;
  }

  if (GetKeyState(VK_CAPITAL) & 1) {
    modifiers |= EVENTFLAG_CAPS_LOCK_ON;
  }

  if (GetAsyncKeyState(VK_NUMLOCK) & 1) {
    modifiers |= EVENTFLAG_NUM_LOCK_ON;
  }

  if (aVirtualKey) {
    if (aVirtualKey == VK_RCONTROL || aVirtualKey == VK_RMENU ||
        aVirtualKey == VK_RSHIFT) {
      modifiers |= EVENTFLAG_IS_RIGHT;
    } else if (aVirtualKey == VK_LCONTROL || aVirtualKey == VK_LMENU ||
               aVirtualKey == VK_LSHIFT) {
      modifiers |= EVENTFLAG_IS_LEFT;
    } else if (aVirtualKey >= VK_NUMPAD0 && aVirtualKey <= VK_DIVIDE) {
      modifiers |= EVENTFLAG_IS_KEY_PAD;
    }
  }

  return modifiers;
}

class MyInputListener : public IInputListener
{
public:
  bool IsBrowserFocused() { return CEFUtils::DInputHook::ChromeFocus(); }

  MyInputListener()
  {
    pCursorX = &RE::MenuScreenData::GetSingleton()->mousePos.x;
    pCursorY = &RE::MenuScreenData::GetSingleton()->mousePos.y;
    vkCodeDownDur.fill(0);
    vkCodeLastRepeat.fill(0);
  }

  void Init(std::shared_ptr<OverlayService> service_,
            std::shared_ptr<InputConverter> conv_)
  {
    service = service_;
    conv = conv_;
  }

  void InjectChar(uint8_t code)
  {
    if (auto app = service->GetMyChromiumApp()) {
      int virtualKeyCode = VscToVk(code);
      int scan = code;
      auto modifiers = GetCefModifiers_(virtualKeyCode);
      bool shiftDown = (modifiers & EVENTFLAG_SHIFT_DOWN) != 0;
      bool capsLockOn = (modifiers & EVENTFLAG_CAPS_LOCK_ON) != 0;
      auto ch = conv->VkCodeToChar(virtualKeyCode, shiftDown, capsLockOn);
      if (ch)
        app->InjectKey(cef_key_event_type_t::KEYEVENT_CHAR, modifiers, ch,
                       scan);
    }
  }

  void InjectKey(uint8_t code, bool down)
  {
    if (auto app = service->GetMyChromiumApp()) {
      int virtualKeyCode = VscToVk(code);
      int scan = code;
      app->InjectKey(down ? cef_key_event_type_t::KEYEVENT_KEYDOWN
                          : cef_key_event_type_t::KEYEVENT_KEYUP,
                     GetCefModifiers_(virtualKeyCode), virtualKeyCode, scan);
    }
  }

  int VscToVk(int code)
  {
    if (code == 200)
      return VK_UP;
    if (code == 203)
      return VK_LEFT;
    if (code == 205)
      return VK_RIGHT;
    if (code == 208)
      return VK_DOWN;
    return MapVirtualKeyA(code, MAPVK_VSC_TO_VK);
  }

  void OnKeyStateChange(uint8_t code, bool down) noexcept override
  {
    int virtualKeyCode = VscToVk(code);

    if (!down && virtualKeyCode >= 0 &&
        virtualKeyCode < vkCodeDownDur.size()) {
      vkCodeDownDur[virtualKeyCode] = 0;
    }

    if (!IsBrowserFocused())
      return;

    // Switch layout if need
    bool switchLayoutDown = ((GetAsyncKeyState(VK_SHIFT) & 0x8000) &&
                             (GetAsyncKeyState(VK_MENU) & 0x8000)) ||
      (GetAsyncKeyState(VK_SHIFT) & 0x8000) &&
        (GetAsyncKeyState(VK_CONTROL) & 0x8000);
    if (switchLayoutDownWas != switchLayoutDown) {
      switchLayoutDownWas = switchLayoutDown;
      if (switchLayoutDown) {
        conv->SwitchLayout();
      }
    }

    // Start the repeat timer on key-down (key-up is cleared above).
    if (down && virtualKeyCode >= 0 &&
        virtualKeyCode < vkCodeDownDur.size()) {
      vkCodeDownDur[virtualKeyCode] = clock();
      vkCodeLastRepeat[virtualKeyCode] = clock();
    }

    if (auto app = service->GetMyChromiumApp()) {
      InjectKey(code, down);

      if (down) {
        InjectChar(code);
      }
    }
  }

  void OnMouseWheel(int32_t delta) noexcept override
  {
    if (!IsBrowserFocused())
      return;
    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseWheel(*pCursorX, *pCursorY, delta,
                              GetCefModifiers_(0));
      }
  }

  void OnMouseMove(float deltaX, float deltaY) noexcept override
  {
    auto ui = RE::UI::GetSingleton();
    if (!ui)
      return;

    if (!ui->IsMenuOpen(RE::CursorMenu::MENU_NAME))
      return;

    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseMove(*pCursorX, *pCursorY, GetCefModifiers_(0),
                             IsBrowserFocused());
      }
  }

  void OnMouseStateChange(MouseButton mouseButton, bool down) noexcept override
  {
    if (!IsBrowserFocused())
      return;
    if (pCursorX && pCursorY)
      if (auto app = service->GetMyChromiumApp()) {
        cef_mouse_button_type_t btn;
        switch (mouseButton) {
          case MouseButton::Left:
            btn = cef_mouse_button_type_t::MBT_LEFT;
            break;
          case MouseButton::Middle:
            btn = cef_mouse_button_type_t::MBT_MIDDLE;
            break;
          case MouseButton::Right:
            btn = cef_mouse_button_type_t::MBT_RIGHT;
            break;
        }
        app->InjectMouseButton(*pCursorX, *pCursorY, btn, !down,
                               GetCefModifiers_(0));
      }
  }

  void OnUpdate() noexcept override
  {
    auto ui = RE::UI::GetSingleton();
    if (!ui)
      return;

    if (!ui->IsMenuOpen(RE::CursorMenu::MENU_NAME)) {
      if (auto app = service->GetMyChromiumApp()) {
        app->InjectMouseMove(-1.f, -1.f, GetCefModifiers_(0), false);
      }
    }
    if (auto app = service->GetMyChromiumApp())
      app->RunTasks();

    if (IsBrowserFocused()) {
      const clock_t now = clock();
      for (int i = 0; i < 256; ++i) {
        const auto pressMoment = this->vkCodeDownDur[i];
        if (!pressMoment || now - pressMoment <= CLOCKS_PER_SEC / 2)
          continue; // not held, or still inside the initial delay
        if (now - this->vkCodeLastRepeat[i] < CLOCKS_PER_SEC / 30)
          continue; // throttle to ~30 repeats/sec instead of every frame
        this->vkCodeLastRepeat[i] = now;
        if (i == VK_BACK || i == VK_RIGHT || i == VK_LEFT) {
          InjectKey(MapVirtualKeyA(i, MAPVK_VK_TO_VSC), true);
          InjectKey(MapVirtualKeyA(i, MAPVK_VK_TO_VSC), false);
        } else {
          InjectChar(MapVirtualKeyA(i, MAPVK_VK_TO_VSC));
        }
      }
    }
  }

private:
  std::shared_ptr<OverlayService> service;
  std::shared_ptr<InputConverter> conv;
  std::array<clock_t, 256> vkCodeDownDur;
  std::array<clock_t, 256> vkCodeLastRepeat;
  float* pCursorX = nullptr;
  float* pCursorY = nullptr;
  bool switchLayoutDownWas = false;
};

// Keeps the game window in front. At startup the window may never receive
// activation (a launcher chain without foreground rights), and later an own
// window (Chromium helpers, the CEF subprocess) can take it; DirectInput then
// stays unacquired until an alt-tab. Once the game has been in front, a switch
// to another program is left alone. Runs on its own thread so a paused game
// loop cannot stall it.
class ForegroundGuard
{
public:
  ForegroundGuard()
    : thread([this] { Run(); })
  {
  }

  ~ForegroundGuard()
  {
    stop = true;
    if (thread.joinable()) {
      thread.join();
    }
  }

  // Deactivation diagnostics on the game window; every message is forwarded
  static LRESULT CALLBACK WndProc(HWND, UINT uMsg, WPARAM wParam,
                                  LPARAM lParam)
  {
    if (uMsg == WM_ACTIVATE && LOWORD(wParam) == WA_INACTIVE) {
      LogWindow("deactivated by", reinterpret_cast<HWND>(lParam));
    } else if (uMsg == WM_KILLFOCUS) {
      LogWindow("focus taken by", reinterpret_cast<HWND>(wParam));
    }
    return 0;
  }

private:
  static constexpr int kStartupAttempts = 100;
  static constexpr int kOwnWindowAttempts = 30;

  struct WindowInfo
  {
    char className[128] = { 0 };
    wchar_t image[MAX_PATH] = { 0 };
    DWORD pid = 0;
  };

  static WindowInfo Describe(HWND window)
  {
    WindowInfo info;
    if (!window) {
      return info;
    }
    GetWindowThreadProcessId(window, &info.pid);
    GetClassNameA(window, info.className, sizeof(info.className) - 1);
    if (HANDLE process =
          OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, info.pid)) {
      DWORD length = MAX_PATH;
      QueryFullProcessImageNameW(process, 0, info.image, &length);
      CloseHandle(process);
    }
    return info;
  }

  static std::string ImageName(const WindowInfo& info)
  {
    const wchar_t* slash = std::wcsrchr(info.image, L'\\');
    const wchar_t* name = slash ? slash + 1 : info.image;
    std::string result;
    for (const wchar_t* p = name; *p; ++p) {
      result += static_cast<char>(*p < 128 ? *p : '?');
    }
    return result;
  }

  static void LogWindow(const char* what, HWND window)
  {
    static ULONGLONG lastLog = 0;
    const ULONGLONG now = GetTickCount64();
    if (now - lastLog < 500) {
      return;
    }
    lastLog = now;
    const WindowInfo info = Describe(window);
    spdlog::info("ForegroundGuard: game window {} class '{}' pid {} ({})", what,
                 info.className, info.pid, ImageName(info));
  }

  static bool IsOwnWindow(const WindowInfo& info)
  {
    return info.pid == GetCurrentProcessId() ||
      std::strncmp(info.className, "Chrome_", 7) == 0 ||
      std::wcsstr(info.image, L"SkyrimPlatformCEF") != nullptr;
  }

  // The only visible top-level window of this process is the game's
  static BOOL CALLBACK FindGameWindow(HWND window, LPARAM out)
  {
    DWORD pid = 0;
    GetWindowThreadProcessId(window, &pid);
    if (pid != GetCurrentProcessId() || !IsWindowVisible(window) ||
        GetWindow(window, GW_OWNER) != nullptr) {
      return TRUE;
    }
    *reinterpret_cast<HWND*>(out) = window;
    return FALSE;
  }

  void Run()
  {
    while (!stop) {
      Sleep(100);
      try {
        Tick();
      } catch (...) {
      }
    }
  }

  void Tick()
  {
    if (!game) {
      EnumWindows(FindGameWindow, reinterpret_cast<LPARAM>(&game));
      if (!game) {
        return;
      }
    }
    const HWND foreground = GetForegroundWindow();
    if (foreground == game) {
      if (thief) {
        spdlog::info("ForegroundGuard: game window is in front again after "
                     "{} attempts",
                     attempts);
      }
      everForeground = true;
      thief = nullptr;
      return;
    }
    if (!foreground || !IsWindowVisible(game) || IsIconic(game)) {
      return;
    }
    const WindowInfo info = Describe(foreground);
    // Message boxes and windows the game owns stay clickable
    if (std::strcmp(info.className, "#32770") == 0 ||
        GetWindow(foreground, GW_OWNER) == game) {
      return;
    }
    const bool own = IsOwnWindow(info);
    if (!own && everForeground) {
      // A real switch to another program
      thief = nullptr;
      return;
    }
    if (foreground != thief) {
      thief = foreground;
      attempts = 0;
      spdlog::info("ForegroundGuard: {} class '{}' pid {} ({}) is in front of "
                   "the game, reclaiming",
                   own ? "own window" : "startup window", info.className,
                   info.pid, ImageName(info));
    }
    if (attempts >= (everForeground ? kOwnWindowAttempts : kStartupAttempts)) {
      return;
    }
    ++attempts;
    // Sharing the front window's input queue lets SetForegroundWindow succeed from the background
    const DWORD frontThread = GetWindowThreadProcessId(foreground, nullptr);
    const DWORD ownThread = GetCurrentThreadId();
    const bool attached =
      frontThread != ownThread && AttachThreadInput(frontThread, ownThread, TRUE);
    SetForegroundWindow(game);
    BringWindowToTop(game);
    if (attached) {
      AttachThreadInput(frontThread, ownThread, FALSE);
    }
  }

  std::atomic<bool> stop{ false };
  HWND game = nullptr;
  HWND thief = nullptr;
  int attempts = 0;
  bool everForeground = false;
  std::thread thread;
};

class SkyrimPlatformApp : public CEFUtils::SKSEPluginBase
{
public:
  static SkyrimPlatformApp& GetInstance()
  {
    static SkyrimPlatformApp g_inst;
    return g_inst;
  }

  void* GetMainAddress() const override
  {
    REL::Relocation<void*> winMain{ Offsets::WinMain };
    return winMain.get();
  }

  bool Attach() override { return true; }

  bool Detach() override
  {
    FlowManager::CloseProcess(L"SkyrimSE.exe");
    FlowManager::CloseProcess(L"SkyrimPlatformCEF.exe.hidden");
    return true;
  }

  bool BeginMain() override
  {
    inputConverter = std::make_shared<InputConverter>();
    myInputListener = std::make_shared<MyInputListener>();

    CEFUtils::D3D11Hook::Install();
    CEFUtils::DInputHook::Install(myInputListener);
    CEFUtils::WindowsHook::Install();
    CEFUtils::WindowsHook::Get().SetCallback(&ForegroundGuard::WndProc);
    foregroundGuard = std::make_unique<ForegroundGuard>();

    CEFUtils::DInputHook::Get().SetToggleKeys({ VK_F6 });
    CEFUtils::DInputHook::Get().SetEnabled(true);

    class ProcessMessageListenerImpl : public ProcessMessageListener
    {
    public:
      void OnProcessMessage(
        const std::string& name,
        const CefRefPtr<CefListValue>& arguments_) noexcept override
      {
        try {
          HandleMessage(name, arguments_);
        } catch (const std::exception&) {
          auto exception = std::current_exception();
          SkyrimPlatform::GetSingleton()->AddTickTask(
            [exception = std::move(exception)](Napi::Env) {
              std::rethrow_exception(exception);
            });
        }
      }

    private:
      void HandleMessage(const std::string& name,
                         const CefRefPtr<CefListValue>& arguments_)
      {
        auto arguments = arguments_->Copy();
        SkyrimPlatform::GetSingleton()->AddTickTask(
          [name, arguments](Napi::Env env) {
            auto length = static_cast<uint32_t>(arguments->GetSize());
            auto argumentsArray = Napi::Array::New(env, length);
            for (uint32_t i = 0; i < length; ++i) {
              argumentsArray.Set(
                i, CefValueToJsValue(env, arguments->GetValue(i)));
            }

            auto browserMessageEvent = Napi::Object::New(env);
            browserMessageEvent.Set("arguments", argumentsArray);
            EventsApi::SendEvent("browserMessage", { browserMessageEvent });
          });
      }

      static Napi::Value CefValueToJsValue(Napi::Env env,
                                           const CefRefPtr<CefValue>& cefValue)
      {
        switch (cefValue->GetType()) {
          case VTYPE_NULL:
            return env.Null();
          case VTYPE_BOOL:
            return Napi::Boolean::New(env, cefValue->GetBool());
          case VTYPE_INT:
            return Napi::Number::New(env, cefValue->GetInt());
          case VTYPE_DOUBLE:
            return Napi::Number::New(env, cefValue->GetDouble());
          case VTYPE_STRING:
            return Napi::String::New(env, cefValue->GetString().ToString());
          case VTYPE_DICTIONARY: {
            auto dict = cefValue->GetDictionary();
            auto result = Napi::Object::New(env);
            CefDictionaryValue::KeyList keyList;
            dict->GetKeys(keyList);
            for (const std::string& key : keyList) {
              auto cefValue = dict->GetValue(key);
              auto jsValue = CefValueToJsValue(env, cefValue);
              result.Set(key, jsValue);
            }
            return result;
          }
          case VTYPE_LIST: {
            auto list = cefValue->GetList();
            auto length = static_cast<int>(list->GetSize());
            auto result = Napi::Array::New(env, length);
            for (int i = 0; i < length; ++i) {
              auto cefValue = list->GetValue(i);
              auto jsValue = CefValueToJsValue(env, cefValue);
              result.Set(i, jsValue);
            }
            return result;
          }
          case VTYPE_BINARY:
          case VTYPE_INVALID:
            return env.Undefined();
        }
        return env.Undefined();
      }
    };

    auto onProcessMessage = std::make_shared<ProcessMessageListenerImpl>();

    ObtainTextsToDrawFunction obtainTextsToDraw = GetTextsToDraw;

    // NB: overlayService is related to the tilted browser backend.
    // Even so, it's currently used to render texts even if nirnlab is selected
    overlayService =
      std::make_shared<OverlayService>(onProcessMessage, obtainTextsToDraw);

    myInputListener->Init(overlayService, inputConverter);

    renderSystem = std::make_shared<RenderSystemD3D11>(*overlayService);

    auto manager = RE::BSRenderManager::GetSingleton();
    if (!manager) {
      logger::critical("Failed to retrieve BSRenderManager");
    }

    renderSystem->m_pSwapChain =
      reinterpret_cast<IDXGISwapChain*>(manager->swapChain);

    return true;
  }

  bool EndMain() override
  {
    foregroundGuard.reset();
    CEFUtils::WindowsHook::Get().SetCallback(nullptr);
    renderSystem.reset();
    overlayService.reset();
    return true;
  }

  void Update() override {}

  std::shared_ptr<OverlayService> overlayService;
  std::shared_ptr<RenderSystemD3D11> renderSystem;
  std::shared_ptr<MyInputListener> myInputListener;
  std::shared_ptr<InputConverter> inputConverter;
  std::unique_ptr<ForegroundGuard> foregroundGuard;
};

DEFINE_DLL_ENTRY_INITIALIZER(SkyrimPlatformApp);
