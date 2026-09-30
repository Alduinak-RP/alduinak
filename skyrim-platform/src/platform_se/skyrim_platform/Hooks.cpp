#include "Hooks.h"
#include "CarryHold.h"
#include "EventHandler.h"
#include <algorithm>
#include <atomic>
#include <cstddef>
#include <cstring>
#include <mmsystem.h>
#include <mutex>
#include <vector>

namespace hook::internal {

uintptr_t GetAllocationBase(void* ptr)
{
  MEMORY_BASIC_INFORMATION mbi{};
  if (VirtualQuery(ptr, &mbi, sizeof(mbi))) {
    return reinterpret_cast<uintptr_t>(mbi.AllocationBase);
  }
  return 0;
}

std::mutex g_mutex;
std::vector<std::tuple<std::string, std::string, RE::BSScript::IFunction*,
                       uintptr_t, uintptr_t, uintptr_t>>
  g_boundNatives;
}

/**
 * @brief This hooks into the game main cycle
 * which behaves much like "our" tick cycle
 * but with a slight artificial delay between ticks.
 * Is mostly used for testing atm.
 */
struct OnFrameUpdate
{
  static void thunk(std::int64_t unk) { func(unk); };
  static inline REL::Relocation<decltype(&thunk)> func;
};

void InstallOnFrameUpdateHook()
{
  Hooks::write_thunk_call<OnFrameUpdate>(
    Offsets::Hooks::FrameUpdate.address());
}

struct OnConsoleVPrint
{
  static void thunk(void* unk1, const char* msg)
  {
    if (msg) {
      EventHandler::SendEventConsoleMsg(msg);
    }

    func(unk1, msg);
  };
  static inline REL::Relocation<decltype(&thunk)> func;
};

void InstallOnConsoleVPrintHook()
{
  Hooks::write_thunk_call<OnConsoleVPrint>(Offsets::Hooks::VPrint.address());
}

// XAudio2 2.7 indexes its resampler table with channels - 1 unchecked
struct CreateSourceVoiceGuard
{
  static void* thunk(void* a_audio, const WAVEFORMATEX* a_format,
                     void* a_owner, void* a_callback, std::uint8_t a_flags)
  {
    if (a_format && a_format->nChannels == 0) {
      static std::atomic<bool> logged{ false };
      if (!logged.exchange(true)) {
        logger::warn(
          "Skipped a sound with a zero-channel format (tag {}, {} Hz)",
          a_format->wFormatTag, a_format->nSamplesPerSec);
      }
      return nullptr;
    }
    return func(a_audio, a_format, a_owner, a_callback, a_flags);
  }
  static inline REL::Relocation<decltype(&thunk)> func;
};

void InstallCreateSourceVoiceGuard()
{
  if (!REL::Module::IsAE()) {
    return;
  }
  const auto call = REL::ID(68003).address() + 0x12A;
  if (*reinterpret_cast<const std::uint8_t*>(call) != 0xE8 ||
      call + 5 + *reinterpret_cast<const std::int32_t*>(call + 1) !=
        REL::ID(67955).address()) {
    logger::warn(
      "CreateSourceVoice call not found, zero-channel sound guard skipped");
    return;
  }
  Hooks::write_thunk_call<CreateSourceVoiceGuard>(call);
}

// BSCompoundFrustum fields that SaveState and RestoreState touch
struct CompoundFrustum
{
  RE::NiFrustumPlanes* planeSets;   // 00
  std::uint32_t planeSetCapacity;   // 08
  std::uint32_t pad0C;              // 0C
  std::uint32_t planeSetSize;       // 10
  std::uint8_t pad14[0x7C];         // 14
  std::uint32_t cameraActivePlanes; // 90
  std::uint8_t pad94[0x24];         // 94
  std::uint32_t planeSetCount;      // B8
};
static_assert(offsetof(CompoundFrustum, planeSetSize) == 0x10);
static_assert(offsetof(CompoundFrustum, cameraActivePlanes) == 0x90);
static_assert(offsetof(CompoundFrustum, planeSetCount) == 0xB8);

// The engine saves a dword per plane set into a stack buffer with no bound
struct CompoundFrustumStateGuard
{
  using ActivePlane = RE::NiFrustumPlanes::ActivePlane;

  struct Spill
  {
    const std::uint32_t* buffer;
    std::uint32_t count;
    std::size_t offset;
  };

  struct SpillStack
  {
    std::vector<Spill> spills;
    std::vector<std::uint32_t> planes;
  };

  static inline thread_local SpillStack* t_stack = nullptr;
  static inline std::atomic<bool> spilled{ false };
  static inline std::atomic<bool> unmatched{ false };

  static std::uint32_t PlaneSets(const CompoundFrustum* a_frustum)
  {
    return (std::min)(a_frustum->planeSetCount, a_frustum->planeSetSize);
  }

  // buffer[0] holds the camera planes, the rest one entry per plane set
  static std::uint32_t Room(std::uint32_t a_capacity)
  {
    return a_capacity ? a_capacity - 1 : 0;
  }

  static void SaveState(const CompoundFrustum* a_frustum,
                        std::uint32_t* a_buffer, std::uint32_t a_capacity)
  {
    a_buffer[0] = a_frustum->cameraActivePlanes;
    const auto count = PlaneSets(a_frustum);
    const auto room = Room(a_capacity);
    const auto planeSets = a_frustum->planeSets;
    const auto kept = (std::min)(count, room);
    for (std::uint32_t i = 0; i < kept; ++i) {
      a_buffer[i + 1] = planeSets[i].activePlanes.underlying();
    }
    if (count > room) {
      KeepAside(a_buffer, planeSets, count, room);
    }
  }

  static void RestoreState(CompoundFrustum* a_frustum,
                           const std::uint32_t* a_buffer,
                           std::uint32_t a_capacity)
  {
    a_frustum->cameraActivePlanes = a_buffer[0];
    const auto count = PlaneSets(a_frustum);
    const auto room = Room(a_capacity);
    const auto kept = count > room || spilled.load(std::memory_order_relaxed)
      ? RestoreKeptAside(a_frustum, a_buffer, count, room)
      : count;
    const auto planeSets = a_frustum->planeSets;
    for (std::uint32_t i = 0; i < kept; ++i) {
      planeSets[i].activePlanes = static_cast<ActivePlane>(a_buffer[i + 1]);
    }
  }

  NOINLINE static void KeepAside(const std::uint32_t* a_buffer,
                                 const RE::NiFrustumPlanes* a_planeSets,
                                 std::uint32_t a_count, std::uint32_t a_room)
  {
    if (!spilled.load(std::memory_order_relaxed) && !spilled.exchange(true)) {
      logger::warn("Compound frustum holds {} plane sets, the engine's save "
                   "buffer fits {}; the rest are kept aside",
                   a_count, a_room);
    }
    if (!t_stack) {
      t_stack = new SpillStack();
    }
    auto& stack = *t_stack;
    stack.spills.push_back({ a_buffer, a_count, stack.planes.size() });
    for (auto i = a_room; i < a_count; ++i) {
      stack.planes.push_back(a_planeSets[i].activePlanes.underlying());
    }
  }

  // Puts back what a_buffer's save kept aside; returns the count left to it
  NOINLINE static std::uint32_t RestoreKeptAside(CompoundFrustum* a_frustum,
                                                 const std::uint32_t* a_buffer,
                                                 std::uint32_t a_count,
                                                 std::uint32_t a_room)
  {
    const auto stack = t_stack;
    if (!stack || stack->spills.empty() ||
        stack->spills.back().buffer != a_buffer) {
      if (a_count > a_room && !unmatched.exchange(true)) {
        logger::warn("Compound frustum restore of {} plane sets found none "
                     "kept aside, {} left as they are",
                     a_count, a_count - a_room);
      }
      return (std::min)(a_count, a_room);
    }
    const auto spill = stack->spills.back();
    stack->spills.pop_back();
    const auto restored = (std::min)(a_count, spill.count);
    const auto aside = stack->planes.data() + spill.offset;
    const auto asideCount = stack->planes.size() - spill.offset;
    const auto planeSets = a_frustum->planeSets;
    for (auto i = a_room; i < restored && i - a_room < asideCount; ++i) {
      planeSets[i].activePlanes = static_cast<ActivePlane>(aside[i - a_room]);
    }
    stack->planes.resize(spill.offset);
    return (std::min)(restored, a_room);
  }
};

void InstallCompoundFrustumStateGuard()
{
  if (!REL::Module::IsAE()) {
    logger::info("Compound frustum save guard skipped, the game is not 1.6");
    return;
  }
  const auto save = REL::ID(76843).address();
  const auto restore = REL::ID(76844).address();
  constexpr auto savePattern = REL::make_pattern<
    "8B 81 90 00 00 00 89 02 44 8B 81 B8 00 00 00 44 39 41 10 44 0F 42 41 10 "
    "48 8B 09 4E 8D 04 82 49 3B D0 74 1D 48 83 C1 60 ?? ?? ?? ?? ?? ?? ?? ?? "
    "8B 01 48 8D 49 70 48 83 C2 04 89 02 49 3B D0 75 EF C3">();
  constexpr auto restorePattern = REL::make_pattern<
    "44 8B 81 B8 00 00 00 44 39 41 10 8B 02 44 0F 42 41 10 89 81 90 00 00 00 "
    "48 8B 09 4E 8D 04 82 49 3B D0 74 1E 48 83 C1 60 ?? ?? ?? ?? ?? ?? ?? ?? "
    "8B 42 04 48 83 C2 04 89 01 48 8D 49 70 49 3B D0 75 EE C3">();
  if (!savePattern.match(save) || !restorePattern.match(restore)) {
    logger::warn("Compound frustum SaveState or RestoreState bytes differ, "
                 "save guard skipped");
    return;
  }
  auto& trampoline = SKSE::GetTrampoline();
  trampoline.write_branch<5>(save, CompoundFrustumStateGuard::SaveState);
  trampoline.write_branch<5>(restore, CompoundFrustumStateGuard::RestoreState);
  logger::info("Compound frustum save guard installed");
}

// The engine stacks items whose extras compare equal; copies with different custom names must stay apart, as on the server
struct TextDisplayDataIsNotEqual
{
  static bool thunk(const RE::ExtraTextDisplayData* a_this,
                    const RE::BSExtraData* a_rhs)
  {
    if (a_rhs &&
        a_rhs->GetType() == RE::ExtraDataType::kTextDisplayData) {
      const auto rhs = static_cast<const RE::ExtraTextDisplayData*>(a_rhs);
      if (!a_this->displayNameText && !rhs->displayNameText &&
          !a_this->ownerQuest && !rhs->ownerQuest) {
        return std::strcmp(a_this->displayName.c_str(),
                           rhs->displayName.c_str()) != 0;
      }
    }
    return func(a_this, a_rhs);
  }
  static inline REL::Relocation<decltype(&thunk)> func;
};

void InstallTextDisplayDataIsNotEqualHook()
{
  REL::Relocation<std::uintptr_t> vtbl{ RE::VTABLE_ExtraTextDisplayData[0] };
  TextDisplayDataIsNotEqual::func =
    vtbl.write_vfunc(0x2, TextDisplayDataIsNotEqual::thunk);
}

// The browser's Personal menu replaces the vanilla Skills menu, so its quick key opens nothing
struct MenuOpenHandlerCanProcess
{
  static bool thunk(RE::MenuOpenHandler* a_this, RE::InputEvent* a_event)
  {
    const auto userEvents = RE::UserEvents::GetSingleton();
    if (a_event && userEvents &&
        a_event->QUserEvent() == userEvents->quickStats) {
      static std::atomic<bool> logged{ false };
      if (!logged.exchange(true)) {
        logger::info("Quick Stats key ignored, the Skills menu stays shut");
      }
      return false;
    }
    return func(a_this, a_event);
  }
  static inline REL::Relocation<decltype(&thunk)> func;
};

void InstallQuickStatsBlock()
{
  REL::Relocation<std::uintptr_t> vtbl{ RE::VTABLE_MenuOpenHandler[0] };
  MenuOpenHandlerCanProcess::func =
    vtbl.write_vfunc(0x1, MenuOpenHandlerCanProcess::thunk);
}

void BindNativeMethod(RE::BSScript::Internal::VirtualMachine* thisArg,
                      RE::BSScript::IFunction* func);

decltype(&BindNativeMethod) _BindNativeMethod;

void HookVirtualMachineBind()
{
  spdlog::info("Hooking VirtualMachine::Bind");
  REL::Relocation<std::uintptr_t> Vtbl{
    RE::BSScript::Internal::VirtualMachine::VTABLE[0]
  };
  _BindNativeMethod = reinterpret_cast<decltype(_BindNativeMethod)>(
    Vtbl.write_vfunc(0x18, BindNativeMethod));
}

void BindNativeMethod(RE::BSScript::Internal::VirtualMachine* thisArg,
                      RE::BSScript::IFunction* func)
{
  std::stringstream memory;

  for (int i = 0; i < 100; i++) {
    uint8_t* funcPtr = reinterpret_cast<uint8_t*>(func);
    if (i % 8 == 0) {
      memory << std::hex << '[' << (int)i << ']' << ' ';
    }
    memory << std::hex << (int)funcPtr[i] << ' ';
  }

  uint8_t* raw = reinterpret_cast<uint8_t*>(func);
  uintptr_t realFunc = *reinterpret_cast<uintptr_t*>(raw + 0x50);

  uintptr_t moduleBase =
    hook::internal::GetAllocationBase(reinterpret_cast<void*>(realFunc));
  uintptr_t funcOffset = realFunc - moduleBase;

  auto skse = (uintptr_t)GetModuleHandleA("skse64_1_6_1170.dll");

  uintptr_t isLongSignature =
    moduleBase == skse ? *reinterpret_cast<uint8_t*>(raw + 0x58) : 0;

  const char* funcName = func ? func->GetName().data() : "<null func>";
  const char* className =
    func ? func->GetObjectTypeName().data() : "<null IFunction>";
  spdlog::trace("VirtualMachine::Bind called {} {} {} funcOffset={:x}, "
                "realFunc={:x}, moduleBase={:x}",
                className, funcName, memory.str(), funcOffset, realFunc,
                moduleBase);

  if (func) {
    std::lock_guard<std::mutex> lock(hook::internal::g_mutex);
    hook::internal::g_boundNatives.push_back(
      { className, funcName, func, moduleBase, funcOffset, isLongSignature });
  }

  _BindNativeMethod(thisArg, func);
}

std::vector<std::tuple<std::string, std::string, RE::BSScript::IFunction*,
                       uintptr_t, uintptr_t, uintptr_t>>
Hooks::GetBoundNatives()
{
  std::lock_guard<std::mutex> lock(hook::internal::g_mutex);
  return hook::internal::g_boundNatives;
}

void Hooks::Install()
{
  // InstallOnFrameUpdateHook();
  InstallOnConsoleVPrintHook();
  InstallCreateSourceVoiceGuard();
  InstallCompoundFrustumStateGuard();
  InstallTextDisplayDataIsNotEqualHook();
  InstallQuickStatsBlock();
  CarryHold::Install();
  HookVirtualMachineBind();

  logger::info("CommonLib hooks installed.");
}
