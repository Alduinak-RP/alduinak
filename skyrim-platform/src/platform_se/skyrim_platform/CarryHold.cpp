#include "CarryHold.h"

#include "Hooks.h"

#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

// The client refreshes a hold every frame; one it stopped refreshing lets go after this
constexpr auto kLease = 500ms;
constexpr auto kWindow = 1s;
// A body this far from its carrier is left alone, as the client's own hold does
constexpr float kMaxDistance = 2048.f;
constexpr float kPi = 3.14159265f;

// 1.6 ids, checked by disassembly of 1.6.1179 and again at install
// Actor::SetPosition(pos, updateCharController): location, controller warp with zero velocity, 3D translate; vtable slot 0xA9
constexpr REL::ID kActorSetPosition{ 37309 };
constexpr std::size_t kSetPositionSlot = 0xA9;
// Main::Update hands the player to this call before the frame's actor updates
constexpr REL::ID kMainUpdate{ 36564 };
constexpr REL::ID kFrameStartCallee{ 40438 };
constexpr std::ptrdiff_t kFrameStartCall = 0x6E;

struct Hold
{
  RE::FormID carrier = 0;
  float forward = 0;
  float up = 0;
  float yaw = 0;
  Clock::time_point refreshed;
  // The next held frame puts the body in place and is not a drift sample
  bool snapping = true;
  Clock::time_point windowStart;
  double windowSum = 0;
  uint32_t windowFrames = 0;
  CarryHold::Stats stats;
};

enum class StepResult
{
  kHeld,
  kSkipped,
  kFaulted
};

struct Step
{
  RE::FormID held = 0;
  RE::FormID carrier = 0;
  float forward = 0;
  float up = 0;
  float yaw = 0;
  StepResult result = StepResult::kSkipped;
  float drift = 0;
  float yawDrift = 0;
};

std::mutex g_mutex;
std::unordered_map<RE::FormID, Hold> g_holds;
std::atomic<bool> g_installed{ false };
std::atomic<bool> g_faulted{ false };

float WrapRadians(float a)
{
  a = std::fmod(a, 2 * kPi);
  if (a > kPi) {
    a -= 2 * kPi;
  } else if (a < -kPi) {
    a += 2 * kPi;
  }
  return a;
}

// One worldspace outdoors, one cell indoors
bool SameSpace(RE::Actor* a, RE::Actor* b)
{
  const auto cellA = a->GetParentCell();
  const auto cellB = b->GetParentCell();
  if (!cellA || !cellB) {
    return false;
  }
  if (cellA == cellB) {
    return true;
  }
  return cellA->IsExteriorCell() && cellB->IsExteriorCell() &&
    a->GetWorldspace() == b->GetWorldspace();
}

StepResult Place(Step& s)
{
  const auto held = RE::TESForm::LookupByID<RE::Actor>(s.held);
  const auto carrier = RE::TESForm::LookupByID<RE::Actor>(s.carrier);
  if (!held || !carrier || held == carrier || !held->Is3DLoaded() ||
      !carrier->Is3DLoaded() || held->IsDisabled() || held->IsDeleted() ||
      held->IsDead() || held->IsInRagdollState() || held->IsOnMount() ||
      !SameSpace(held, carrier)) {
    return StepResult::kSkipped;
  }
  const auto from = carrier->GetPosition();
  const auto current = held->GetPosition();
  if (current.GetDistance(from) > kMaxDistance) {
    return StepResult::kSkipped;
  }
  const float yaw = carrier->GetAngleZ();
  const RE::NiPoint3 target{ from.x + std::sin(yaw) * s.forward,
                             from.y + std::cos(yaw) * s.forward,
                             from.z + s.up };
  const float heading = yaw + s.yaw;
  s.drift = current.GetDistance(target);
  s.yawDrift =
    std::abs(WrapRadians(heading - held->GetAngleZ())) * 180.f / kPi;
  static REL::Relocation<void (*)(RE::Actor*, const RE::NiPoint3&, bool)>
    setPosition{ kActorSetPosition };
  setPosition(held, target, true);
  held->SetRotationZ(heading);
  return StepResult::kHeld;
}

StepResult PlaceGuarded(Step& s) noexcept
{
  __try {
    return Place(s);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return StepResult::kFaulted;
  }
}

std::string Describe(RE::FormID held, const Hold& h)
{
  const auto& s = h.stats;
  const auto sampled = s.frames > s.snaps ? s.frames - s.snaps : 0;
  return fmt::format(
    "{:x} on {:x}: {} frames held ({} skipped, {} snaps), drift mean {:.1f} "
    "max {:.1f} worst second {:.1f} units, heading drift max {:.1f} degrees",
    held, h.carrier, s.frames, s.skipped, s.snaps,
    sampled ? s.driftSum / sampled : 0.0, s.maxDrift, s.worstSecond,
    s.maxYawDrift);
}

void Record(Hold& h, const Step& s, Clock::time_point now)
{
  auto& stats = h.stats;
  if (s.result != StepResult::kHeld) {
    ++stats.skipped;
    h.snapping = true;
    return;
  }
  ++stats.frames;
  if (h.snapping) {
    h.snapping = false;
    ++stats.snaps;
    return;
  }
  stats.driftSum += s.drift;
  stats.maxDrift = (std::max)(stats.maxDrift, s.drift);
  stats.maxYawDrift = (std::max)(stats.maxYawDrift, s.yawDrift);
  if (!h.windowFrames) {
    h.windowStart = now;
  }
  h.windowSum += s.drift;
  ++h.windowFrames;
  if (now - h.windowStart >= kWindow) {
    stats.worstSecond = (std::max)(
      stats.worstSecond, static_cast<float>(h.windowSum / h.windowFrames));
    h.windowSum = 0;
    h.windowFrames = 0;
  }
}

void CloseWindow(Hold& h)
{
  if (h.windowFrames) {
    h.stats.worstSecond = (std::max)(
      h.stats.worstSecond, static_cast<float>(h.windowSum / h.windowFrames));
    h.windowFrames = 0;
  }
}

// Engine calls run outside the lock, so a sink the warp fires can never wait on a client call
void Update()
{
  if (g_faulted) {
    return;
  }
  const auto now = Clock::now();
  const auto ui = RE::UI::GetSingleton();
  // The client's update stops with the game, so a pause keeps every lease
  if (ui && ui->GameIsPaused()) {
    std::lock_guard l(g_mutex);
    for (auto& [id, h] : g_holds) {
      h.refreshed = now;
    }
    return;
  }
  std::vector<Step> steps;
  {
    std::lock_guard l(g_mutex);
    if (g_holds.empty()) {
      return;
    }
    for (auto it = g_holds.begin(); it != g_holds.end();) {
      if (now - it->second.refreshed > kLease) {
        CloseWindow(it->second);
        spdlog::info("CarryHold: lapsed, {}", Describe(it->first, it->second));
        it = g_holds.erase(it);
        continue;
      }
      const auto& h = it->second;
      steps.push_back({ it->first, h.carrier, h.forward, h.up, h.yaw });
      ++it;
    }
  }
  for (auto& s : steps) {
    s.result = PlaceGuarded(s);
    if (s.result == StepResult::kFaulted) {
      g_faulted = true;
      spdlog::error("CarryHold: placing {:x} on {:x} faulted, the native "
                    "hold is off until restart",
                    s.held, s.carrier);
      break;
    }
  }
  std::lock_guard l(g_mutex);
  for (const auto& s : steps) {
    const auto it = g_holds.find(s.held);
    if (it != g_holds.end() && it->second.carrier == s.carrier) {
      Record(it->second, s, now);
    }
  }
}

struct FrameStart
{
  static void thunk(void* a_player)
  {
    Update();
    func(a_player);
  }
  static inline REL::Relocation<decltype(&thunk)> func;
};

bool SetPositionIsSlot(const REL::VariantID& vtable)
{
  REL::Relocation<std::uintptr_t> vtbl{ vtable };
  return reinterpret_cast<const std::uintptr_t*>(
           vtbl.address())[kSetPositionSlot] == kActorSetPosition.address();
}
}

void CarryHold::Install()
{
  if (!REL::Module::IsAE()) {
    spdlog::info("CarryHold: not 1.6, carried bodies are held by the client "
                 "script");
    return;
  }
  const auto call = kMainUpdate.address() + kFrameStartCall;
  if (*reinterpret_cast<const std::uint8_t*>(call) != 0xE8 ||
      call + 5 + *reinterpret_cast<const std::int32_t*>(call + 1) !=
        kFrameStartCallee.address()) {
    spdlog::warn("CarryHold: frame start call not found or already hooked, "
                 "carried bodies are held by the client script");
    return;
  }
  if (!SetPositionIsSlot(RE::VTABLE_Character[0]) ||
      !SetPositionIsSlot(RE::VTABLE_PlayerCharacter[0])) {
    spdlog::warn("CarryHold: Actor::SetPosition is not vtable slot 0xA9, "
                 "carried bodies are held by the client script");
    return;
  }
  Hooks::write_thunk_call<FrameStart>(call);
  g_installed = true;
  spdlog::info("CarryHold: carried bodies are placed at every frame start");
}

bool CarryHold::Set(RE::FormID held, RE::FormID carrier, float forward,
                    float up, float yawDegrees)
{
  if (!g_installed || g_faulted || !held || !carrier || held == carrier ||
      !std::isfinite(forward) || !std::isfinite(up) ||
      !std::isfinite(yawDegrees)) {
    return false;
  }
  std::lock_guard l(g_mutex);
  auto& h = g_holds[held];
  if (h.carrier != carrier) {
    h.snapping = true;
  }
  h.carrier = carrier;
  h.forward = forward;
  h.up = up;
  h.yaw = yawDegrees * kPi / 180.f;
  h.refreshed = Clock::now();
  return true;
}

std::optional<CarryHold::Stats> CarryHold::Clear(RE::FormID held)
{
  std::lock_guard l(g_mutex);
  const auto it = g_holds.find(held);
  if (it == g_holds.end()) {
    return std::nullopt;
  }
  CloseWindow(it->second);
  const auto stats = it->second.stats;
  g_holds.erase(it);
  return stats;
}
