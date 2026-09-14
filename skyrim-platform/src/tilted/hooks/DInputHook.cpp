#include "IInputListener.h"
#include <DInputHook.hpp>

#define CINTERFACE

#include <dinput.h>

#include <FunctionHook.hpp>
#include <array>
#include <atomic>
#include <iostream>
#include <spdlog/spdlog.h>

namespace {
std::shared_ptr<IInputListener> g_listener;
std::array<uint8_t, 256> g_pressedWas = ([] {
  std::array<uint8_t, 256> r;
  r.fill(0);
  return r;
})();
std::array<bool, 4> g_mousePressedWas = { 0, 0, 0, 0 };

// Keyboard counters since the last reset, written on the input thread and read from any
struct KeyboardCounters
{
  std::atomic<uint32_t> polls, eventsRead, eventsDelivered, stateDowns,
    deliveredDowns, kicks, lastFailedHr;
};
KeyboardCounters g_keyboard;
std::atomic<int> g_enteredGameKeyLogs = 0;

// Keyboard watchdog state, touched only on the engine's input thread
std::array<bool, 256> g_deliveredDown = {};
std::array<uint8_t, 0x3A> g_starvedChecks = {};
std::array<bool, 0x3A> g_seenUp = {};
ULONGLONG g_lastWatch = 0;
ULONGLONG g_lastKick = 0;
uint32_t g_kickTotal = 0;
bool g_awaitingDelivery = false;

bool ThisProcessInFront()
{
  DWORD pid = 0;
  GetWindowThreadProcessId(GetForegroundWindow(), &pid);
  return pid == GetCurrentProcessId();
}

const char* DeviceName(IDirectInputDevice8A* device)
{
  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  const bool keyboard =
    IDirectInputDevice8_GetDeviceInfo(device, &instanceInfo) == DI_OK &&
    instanceInfo.guidInstance == GUID_SysKeyboard;
  return keyboard ? "keyboard" : "mouse";
}

std::string DescribeWindow(HWND window)
{
  DWORD pid = 0;
  GetWindowThreadProcessId(window, &pid);
  char className[128] = { 0 };
  GetClassNameA(window, className, sizeof(className) - 1);
  return fmt::format("window {} class '{}' pid {}{}",
                     static_cast<void*>(window), className, pid,
                     pid == GetCurrentProcessId() ? " (this process)" : "");
}

void ProcessKeyboardData(uint8_t* apData)
{
  if (!g_listener)
    return;

  for (uint32_t idx = 0; idx < 256; idx++) {
    if (g_pressedWas[idx] != apData[idx]) {
      g_pressedWas[idx] = apData[idx];
      if (apData[idx]) {
        ++g_keyboard.stateDowns;
      }
      g_listener->OnKeyStateChange(idx, apData[idx] != 0);
      // Alt+Tab reached the game; no "deactivated" line after it means Windows never switched
      if (idx == DIK_TAB && apData[idx] &&
          (apData[DIK_LMENU] || apData[DIK_RMENU])) {
        spdlog::info("DInputHook: Alt+Tab pressed in the game, {}",
                     CEFUtils::DInputHook::DescribeInputState());
      }
    }
  }
}

// Tallies what DirectInput returned and what the engine receives from this layer
void CountKeyboardRead(HRESULT result, DWORD dataSize,
                       const DIDEVICEOBJECTDATA* data, const DWORD* count,
                       bool delivered)
{
  ++g_keyboard.polls;
  if (FAILED(result)) {
    g_keyboard.lastFailedHr = static_cast<uint32_t>(result);
    return;
  }
  if (!data || !count || dataSize < 2 * sizeof(DWORD)) {
    return;
  }
  g_keyboard.eventsRead += *count;
  if (!delivered) {
    return;
  }
  g_keyboard.eventsDelivered += *count;
  const auto* bytes = reinterpret_cast<const uint8_t*>(data);
  for (DWORD i = 0; i < *count; ++i) {
    const auto* event =
      reinterpret_cast<const DIDEVICEOBJECTDATA*>(bytes + i * dataSize);
    const bool down = (event->dwData & 0x80) != 0;
    g_deliveredDown[event->dwOfs & 0xFF] = down;
    if (!down) {
      continue;
    }
    ++g_keyboard.deliveredDowns;
    if (g_awaitingDelivery) {
      g_awaitingDelivery = false;
      spdlog::info("DInputHook: keyboard delivering again after kick {}",
                   g_kickTotal);
    }
  }
}

void ProcessMouseData(DIMOUSESTATE2* apMouseState)
{
  if (!g_listener)
    return;

  /*if (!g_listener->OnMouseMove()) {
    apMouseState->lX = apMouseState->lY = apMouseState->lZ = 0;
  }*/
  if (abs(apMouseState->lX) >= std::numeric_limits<float>::epsilon() ||
      abs(apMouseState->lY) >= std::numeric_limits<float>::epsilon())
    g_listener->OnMouseMove(apMouseState->lX, apMouseState->lY);

  if (apMouseState->lZ != 0) {
    g_listener->OnMouseWheel(apMouseState->lZ);
    if (CEFUtils::DInputHook::ChromeFocus()) {
      apMouseState->lZ = 0;
    }
  }

  static const IInputListener::MouseButton mouseBtns[] = {
    IInputListener::MouseButton::Left, IInputListener::MouseButton::Right,
    IInputListener::MouseButton::Middle
  };
  for (int i = 0; i < std::size(mouseBtns); ++i) {
    uint8_t& state = apMouseState->rgbButtons[i];
    const bool pressed = state & 0x80;
    if (pressed != g_mousePressedWas[i]) {
      g_mousePressedWas[i] = pressed;
      g_listener->OnMouseStateChange(mouseBtns[i], pressed);
    }
  }
}

}

namespace CEFUtils {
struct FakeIDirectInputDevice8A
{
  FakeIDirectInputDevice8A(IDirectInputDevice8A* apDevice)
    : m_pDevice(apDevice)
  {
  }

  virtual HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid,
                                                   LPVOID* ppvObj) PURE
  {
    return IDirectInputDevice8_QueryInterface(m_pDevice, riid, ppvObj);
  }
  virtual ULONG STDMETHODCALLTYPE AddRef() PURE
  {
    return IDirectInputDevice8_AddRef(m_pDevice);
  }
  virtual ULONG STDMETHODCALLTYPE Release() PURE;

  /*** IDirectInputDevice8A methods ***/
  virtual HRESULT STDMETHODCALLTYPE GetCapabilities(LPDIDEVCAPS a) PURE
  {
    return IDirectInputDevice8_GetCapabilities(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE
  EnumObjects(LPDIENUMDEVICEOBJECTSCALLBACKA a, LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumObjects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetProperty(REFGUID a,
                                                LPDIPROPHEADER b) PURE
  {
    return IDirectInputDevice8_GetProperty(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE SetProperty(REFGUID a,
                                                LPCDIPROPHEADER b) PURE
  {
    return IDirectInputDevice8_SetProperty(m_pDevice, a, b);
  }
  // The engine acquires before every read, so a failure streak is exactly when this device was dead
  virtual HRESULT STDMETHODCALLTYPE Acquire() PURE
  {
    const HRESULT hr = IDirectInputDevice8_Acquire(m_pDevice);
    if (FAILED(hr)) {
      if (m_failedAcquires++ == 0) {
        spdlog::info("DInputHook: {} acquire failed {:#x}, {}",
                     DeviceName(m_pDevice), static_cast<uint32_t>(hr),
                     DInputHook::DescribeInputState());
      }
    } else if (m_failedAcquires) {
      spdlog::info("DInputHook: {} acquired again after {} failed acquires, {}",
                   DeviceName(m_pDevice), m_failedAcquires,
                   DInputHook::DescribeInputState());
      m_failedAcquires = 0;
    }
    return hr;
  }
  virtual HRESULT STDMETHODCALLTYPE Unacquire() PURE
  {
    return IDirectInputDevice8_Unacquire(m_pDevice);
  }
  virtual HRESULT STDMETHODCALLTYPE GetDeviceState(DWORD a, LPVOID b) PURE;
  virtual HRESULT STDMETHODCALLTYPE GetDeviceData(DWORD a,
                                                  LPDIDEVICEOBJECTDATA b,
                                                  LPDWORD c, DWORD d) PURE;
  virtual HRESULT STDMETHODCALLTYPE SetDataFormat(LPCDIDATAFORMAT a) PURE
  {
    return IDirectInputDevice8_SetDataFormat(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SetEventNotification(HANDLE a) PURE
  {
    return IDirectInputDevice8_SetEventNotification(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SetCooperativeLevel(HWND a, DWORD b) PURE
  {
    const HRESULT hr = IDirectInputDevice8_SetCooperativeLevel(m_pDevice, a, b);
    spdlog::info("DInputHook: {} cooperative level {:#x} on {} returned {:#x}",
                 DeviceName(m_pDevice), b, DescribeWindow(a),
                 static_cast<uint32_t>(hr));
    return hr;
  }
  virtual HRESULT STDMETHODCALLTYPE GetObjectInfo(LPDIDEVICEOBJECTINSTANCEA a,
                                                  DWORD b, DWORD c) PURE
  {
    return IDirectInputDevice8_GetObjectInfo(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetDeviceInfo(LPDIDEVICEINSTANCEA a) PURE
  {
    return IDirectInputDevice8_GetDeviceInfo(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE RunControlPanel(HWND a, DWORD b) PURE
  {
    return IDirectInputDevice8_RunControlPanel(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE Initialize(HINSTANCE a, DWORD b,
                                               REFGUID c) PURE
  {
    return IDirectInputDevice8_Initialize(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE CreateEffect(REFGUID a, LPCDIEFFECT b,
                                                 LPDIRECTINPUTEFFECT* c,
                                                 LPUNKNOWN d) PURE
  {
    return IDirectInputDevice8_CreateEffect(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumEffects(LPDIENUMEFFECTSCALLBACKA a,
                                                LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumEffects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE GetEffectInfo(LPDIEFFECTINFOA a,
                                                  REFGUID b) PURE
  {
    return IDirectInputDevice8_GetEffectInfo(m_pDevice, a, b);
  }
  virtual HRESULT STDMETHODCALLTYPE GetForceFeedbackState(LPDWORD a) PURE
  {
    return IDirectInputDevice8_GetForceFeedbackState(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE SendForceFeedbackCommand(DWORD a) PURE
  {
    return IDirectInputDevice8_SendForceFeedbackCommand(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumCreatedEffectObjects(
    LPDIENUMCREATEDEFFECTOBJECTSCALLBACK a, LPVOID b, DWORD c) PURE
  {
    return IDirectInputDevice8_EnumCreatedEffectObjects(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE Escape(LPDIEFFESCAPE a) PURE
  {
    return IDirectInputDevice8_Escape(m_pDevice, a);
  }
  virtual HRESULT STDMETHODCALLTYPE Poll() PURE
  {
    return IDirectInputDevice8_Poll(m_pDevice);
  }
  virtual HRESULT STDMETHODCALLTYPE SendDeviceData(DWORD a,
                                                   LPCDIDEVICEOBJECTDATA b,
                                                   LPDWORD c, DWORD d) PURE
  {
    return IDirectInputDevice8_SendDeviceData(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE EnumEffectsInFile(
    LPCSTR a, LPDIENUMEFFECTSINFILECALLBACK b, LPVOID c, DWORD d) PURE
  {
    return IDirectInputDevice8_EnumEffectsInFile(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE WriteEffectToFile(LPCSTR a, DWORD b,
                                                      LPDIFILEEFFECT c,
                                                      DWORD d) PURE
  {
    return IDirectInputDevice8_WriteEffectToFile(m_pDevice, a, b, c, d);
  }
  virtual HRESULT STDMETHODCALLTYPE BuildActionMap(LPDIACTIONFORMATA a,
                                                   LPCSTR b, DWORD c) PURE
  {
    return IDirectInputDevice8_BuildActionMap(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE SetActionMap(LPDIACTIONFORMATA a, LPCSTR b,
                                                 DWORD c) PURE
  {
    return IDirectInputDevice8_SetActionMap(m_pDevice, a, b, c);
  }
  virtual HRESULT STDMETHODCALLTYPE
  GetImageInfo(LPDIDEVICEIMAGEINFOHEADERA a) PURE
  {
    return IDirectInputDevice8_GetImageInfo(m_pDevice, a);
  }

private:
  void WatchKeyboard(const uint8_t* state);
  void Kick();

  IDirectInputDevice8A* m_pDevice;
  uint32_t m_failedAcquires = 0;
  bool m_kicked = false;
};

using TIDirectInputA_CreateDevice =
  HRESULT(_stdcall*)(IDirectInput8A* pDirectInput, REFGUID typeGuid,
                     LPDIRECTINPUTDEVICE8A* apDevice, LPUNKNOWN unused);
using TDirectInput8Create = HRESULT(_stdcall*)(HINSTANCE, DWORD, REFIID,
                                               LPVOID*, LPUNKNOWN);

static TIDirectInputA_CreateDevice RealIDirectInputA_CreateDevice = nullptr;
static TDirectInput8Create RealDirectInput8Create = nullptr;

static Set<FakeIDirectInputDevice8A*> s_devices;

HRESULT _stdcall FakeIDirectInputDevice8A::GetDeviceState(DWORD outDataLen,
                                                          LPVOID outData)
{
  if (!g_listener)
    return DI_OK;
  g_listener->OnUpdate();

  // return IDirectInputDevice8_GetDeviceState(m_pDevice, outDataLen, outData);

  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  if (IDirectInputDevice8_GetDeviceInfo(m_pDevice, &instanceInfo) != DI_OK) {
    // TODO: destroy everything
    return DI_OK;
  }

  HRESULT ret =
    IDirectInputDevice8_GetDeviceState(m_pDevice, outDataLen, outData);

  bool isMouseButtonsEnabled = true;
  if (isMouseButtonsEnabled == false) {
    DIMOUSESTATE2 fakeMouseState;
    memcpy(&fakeMouseState, outData, outDataLen);
    for (int i = 0; i < std::size(fakeMouseState.rgbButtons); ++i) {
      fakeMouseState.rgbButtons[i] = 0;
    }
    memcpy(outData, &fakeMouseState, outDataLen);
  }

  if (ret != DI_OK)
    return ret;

  DIMOUSESTATE2* mouseState = (DIMOUSESTATE2*)outData;

  ProcessMouseData(mouseState);

  if (DInputHook::ChromeFocus()) {
    // std::memset(outData, 0, outDataLen);
    DIMOUSESTATE2* mouseState = (DIMOUSESTATE2*)outData;
    for (int i = 0; i < 8; ++i) {
      uint8_t& state = mouseState->rgbButtons[i];
      constexpr int pressed = 0x80;
      state &= ~pressed;
    }
    return 0;
  }
  return DI_OK;
}

HRESULT _stdcall FakeIDirectInputDevice8A::GetDeviceData(
  DWORD dataSize, LPDIDEVICEOBJECTDATA outData, LPDWORD outDataLen,
  DWORD flags)
{
  DInputHook::Get().RunTasks();

  auto& input = DInputHook::Get();

  // The re-acquire after a kick does not depend on the engine acquiring before this read
  if (m_kicked) {
    m_kicked = false;
    Acquire();
  }

  const auto result = IDirectInputDevice8_GetDeviceData(
    m_pDevice, dataSize, outData, outDataLen, flags);

  DIDEVICEINSTANCEA instanceInfo;
  instanceInfo.dwSize = sizeof(instanceInfo);
  if (IDirectInputDevice8_GetDeviceInfo(m_pDevice, &instanceInfo) != DI_OK) {
    return result;
  }

  if (instanceInfo.guidInstance == GUID_SysKeyboard) {
    const bool browserFocus = DInputHook::ChromeFocus();
    CountKeyboardRead(result, dataSize, outData, outDataLen, !browserFocus);
    uint8_t rawData[256];
    HRESULT hr = IDirectInputDevice8_GetDeviceState(m_pDevice, 256, rawData);
    WatchKeyboard(hr == DI_OK ? rawData : nullptr);
    if (hr == DI_OK) {
      ProcessKeyboardData(rawData);
      memset(rawData, 0, 256);
    } else {
      g_keyboard.lastFailedHr = static_cast<uint32_t>(hr);
    }
    if (browserFocus) {
      *outDataLen = 0;

      return result;
    }
  }

  return result;
}

// Windows has a key down that DirectInput or the engine never got; re-acquiring is what Alt+Tab does
void FakeIDirectInputDevice8A::WatchKeyboard(const uint8_t* state)
{
  const ULONGLONG now = GetTickCount64();
  if (now - g_lastWatch < 100) {
    return;
  }
  const bool gap = now - g_lastWatch > 1000;
  g_lastWatch = now;
  // After a gap, in chat or behind another program, a held key must be released before it counts
  if (!state || gap || DInputHook::ChromeFocus() || !ThisProcessInFront()) {
    g_seenUp.fill(false);
    g_starvedChecks.fill(0);
    return;
  }
  int starved = -1;
  for (UINT sc = 1; sc < g_seenUp.size(); ++sc) {
    // AltGr fakes a left Ctrl, so modifiers are left out
    if (sc == DIK_LCONTROL || sc == DIK_LSHIFT || sc == DIK_RSHIFT ||
        sc == DIK_LMENU) {
      continue;
    }
    const UINT vk = MapVirtualKeyA(sc, MAPVK_VSC_TO_VK);
    if (!vk || !(GetAsyncKeyState(static_cast<int>(vk)) & 0x8000)) {
      g_seenUp[sc] = true;
      g_starvedChecks[sc] = 0;
      continue;
    }
    if (!g_seenUp[sc] || (state[sc] && g_deliveredDown[sc])) {
      g_starvedChecks[sc] = 0;
      continue;
    }
    if (g_starvedChecks[sc] < 3) {
      ++g_starvedChecks[sc];
    }
    if (g_starvedChecks[sc] == 3 && starved < 0) {
      starved = static_cast<int>(sc);
    }
  }
  if (starved < 0 || now - g_lastKick < 5000) {
    return;
  }
  if (!g_awaitingDelivery) {
    spdlog::info("DInputHook: keyboard starved, Windows has key {:#x} down, "
                 "DirectInput state {}, delivered {}, re-acquiring (kick {}), "
                 "{}",
                 starved, state[starved] ? 1 : 0,
                 g_deliveredDown[starved] ? 1 : 0, g_kickTotal + 1,
                 DInputHook::DescribeInputState());
    g_awaitingDelivery = true;
  }
  Kick();
}

// Keyboard only; the next Acquire re-registers DirectInput's raw input
void FakeIDirectInputDevice8A::Kick()
{
  IDirectInputDevice8_Unacquire(m_pDevice);
  m_kicked = true;
  g_lastKick = GetTickCount64();
  ++g_kickTotal;
  ++g_keyboard.kicks;
  g_seenUp.fill(false);
  g_starvedChecks.fill(0);
}

ULONG _stdcall FakeIDirectInputDevice8A::Release()
{
  const auto result = IDirectInputDevice8_Release(m_pDevice);
  if (result == 0) {
    s_devices.erase(this);

    delete this;
  }

  return result;
}

HRESULT _stdcall HookIDirectInputA_CreateDevice(
  IDirectInput8A* pDirectInput, REFGUID typeGuid,
  LPDIRECTINPUTDEVICE8A* apDevice, LPUNKNOWN unused)
{
  const auto result =
    RealIDirectInputA_CreateDevice(pDirectInput, typeGuid, apDevice, unused);

  if (result == DI_OK) {
    auto pStub = new FakeIDirectInputDevice8A(*apDevice);

    s_devices.insert(pStub);

    *apDevice = reinterpret_cast<LPDIRECTINPUTDEVICE8A>(pStub);
  }

  return result;
}

static HRESULT _stdcall HookDirectInput8Create(HINSTANCE instance,
                                               DWORD version, REFIID iid,
                                               LPVOID* out, LPUNKNOWN outer)
{
  IDirectInput8A* pDirectInput = nullptr;

  const auto result = RealDirectInput8Create(
    instance, version, iid, reinterpret_cast<LPVOID*>(&pDirectInput), outer);

  *out = static_cast<LPVOID>(pDirectInput);

  if (result == DI_OK && RealIDirectInputA_CreateDevice == nullptr) {
    RealIDirectInputA_CreateDevice = pDirectInput->lpVtbl->CreateDevice;
    TP_HOOK_IMMEDIATE(&RealIDirectInputA_CreateDevice,
                      HookIDirectInputA_CreateDevice);
  }

  return result;
}

void DInputHook::Install(std::shared_ptr<IInputListener> listener) noexcept
{
  g_listener = listener;
  TP_HOOK_IAT(DirectInput8Create, "dinput8.dll");
}

DInputHook::DInputHook() noexcept
{
  SetToggleKeys({ DIK_RCONTROL });
}

void DInputHook::SetToggleKeys(
  std::initializer_list<unsigned long> aKeys) noexcept
{
  m_toggleKeys.clear();

  for (auto key : aKeys) {
    m_toggleKeys.insert(key);
  }
}

bool DInputHook::IsToggleKey(unsigned int aKey) const noexcept
{
  return m_toggleKeys.count(aKey) > 0;
}

void DInputHook::Acquire() const noexcept
{
  for (auto& device : s_devices) {
    device->Acquire();
  }
}

void DInputHook::Unacquire() const noexcept
{
  for (auto& device : s_devices) {
    device->Unacquire();
  }
}

DInputHook& DInputHook::Get() noexcept
{
  static DInputHook s_instance;
  return s_instance;
}

std::string DInputHook::DescribeInputState()
{
  // The foreground thread's focus, so this works from any thread
  GUITHREADINFO gui = { sizeof(GUITHREADINFO) };
  const HWND focus = GetGUIThreadInfo(0, &gui) ? gui.hwndFocus : nullptr;
  return fmt::format(
    "in front: {}, browser focus {}{}, focus {}, keyboard since reset: polls "
    "{}, events from DirectInput {}, events delivered {}, key downs in DI "
    "state {}, key downs delivered {}, kicks {}, last failed hr {:#x}",
    DescribeWindow(GetForegroundWindow()), ChromeFocus(), DescribeRawInput(),
    DescribeWindow(focus), g_keyboard.polls.load(),
    g_keyboard.eventsRead.load(), g_keyboard.eventsDelivered.load(),
    g_keyboard.stateDowns.load(), g_keyboard.deliveredDowns.load(),
    g_keyboard.kicks.load(), g_keyboard.lastFailedHr.load());
}

void DInputHook::ResetKeyboardCounters()
{
  for (std::atomic<uint32_t>* counter :
       { &g_keyboard.polls, &g_keyboard.eventsRead,
         &g_keyboard.eventsDelivered, &g_keyboard.stateDowns,
         &g_keyboard.deliveredDowns, &g_keyboard.kicks,
         &g_keyboard.lastFailedHr }) {
    *counter = 0;
  }
}

void DInputHook::OnEnteredGame()
{
  ResetKeyboardCounters();
  g_enteredGameKeyLogs = 3;
}

bool DInputHook::TakeEnteredGameKeyLog()
{
  if (g_enteredGameKeyLogs <= 0) {
    return false;
  }
  --g_enteredGameKeyLogs;
  return true;
}

std::string DInputHook::DescribeRawInput()
{
  // DirectInput reads through raw input, so another registration for these usages silences it
  RAWINPUTDEVICE devices[16];
  UINT count = static_cast<UINT>(std::size(devices));
  const UINT n =
    GetRegisteredRawInputDevices(devices, &count, sizeof(RAWINPUTDEVICE));
  if (n == static_cast<UINT>(-1)) {
    return ", raw input unknown";
  }
  std::string result;
  for (UINT i = 0; i < n; ++i) {
    const USHORT usage = devices[i].usUsage;
    if (devices[i].usUsagePage == 0x01 && (usage == 0x02 || usage == 0x06)) {
      result += fmt::format(", raw {} to {} flags {:#x}",
                            usage == 0x06 ? "keyboard" : "mouse",
                            DescribeWindow(devices[i].hwndTarget),
                            devices[i].dwFlags);
    }
  }
  return result;
}

void DInputHook::Update() const noexcept
{
  RAWINPUTDEVICE device[2];

  device[0].usUsagePage = 0x01;
  device[0].usUsage = 0x06;
  device[0].dwFlags = RIDEV_REMOVE;
  device[0].hwndTarget = nullptr;

  device[1].usUsagePage = 0x01;
  device[1].usUsage = 0x02;
  device[1].dwFlags = RIDEV_REMOVE;
  device[1].hwndTarget = nullptr;

  RegisterRawInputDevices(device, sizeof(device) / sizeof(RAWINPUTDEVICE),
                          sizeof(RAWINPUTDEVICE));

  if (m_enabled) {
    Acquire();

    device[0].dwFlags = 0;
    device[1].dwFlags = 0;

    RegisterRawInputDevices(device, sizeof(device) / sizeof(RAWINPUTDEVICE),
                            sizeof(RAWINPUTDEVICE));
  } else {
    Unacquire();
  }
}
}
