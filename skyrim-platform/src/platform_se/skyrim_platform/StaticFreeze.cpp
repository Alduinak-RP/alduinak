#include "StaticFreeze.h"

#include <array>
#include <chrono>
#include <mutex>
#include <optional>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;

// Refs looked at per update, so a city grid load spreads over a few frames
constexpr size_t kBudget = 1024;
// An event whose ref has no 3D yet is looked at again this often, this many times
constexpr auto kNo3DRetry = 200ms;
constexpr uint16_t kNo3DTries = 50;
// A frozen ref is looked at again after these gaps in case its havok was rebuilt
constexpr std::array kFollowUpGaps{ 1000ms, 2000ms };
// A cell's line is written once its refs have been quiet this long
constexpr auto kLogQuiet = 5s;

enum class Result
{
  kFrozen,
  kNoHavok,
  kNo3D,
  kActor,
  kProjectile,
  kAmmo,
  kRuntimeItem,
  kOther,
  kCount
};

// What queued a ref first
enum class Source : uint8_t
{
  kEvent,
  kCellSweep,
  kLoadSweep
};

struct Pending
{
  Clock::time_point due;
  Source source = Source::kEvent;
  uint16_t tries = 0;
  uint8_t pass = 0;
};

struct CellStats
{
  std::unordered_map<RE::FormID, Result> results;
  uint32_t byCellSweep = 0;
  uint32_t byLoadSweep = 0;
  uint32_t refrozen = 0;
  Clock::time_point last;
};

struct Requests
{
  std::vector<std::pair<RE::FormID, bool>> refs;
  std::vector<std::pair<RE::FormID, bool>> serverCopies;
  std::vector<RE::FormID> cells;
  bool sweepAll = false;
  bool reset = false;
};

std::mutex g_requestsMutex;
Requests g_requests;

std::unordered_map<RE::FormID, Pending> g_pending;
// Refs keyframed since their 3D last loaded, so a later event re-arms their follow-ups
std::unordered_set<RE::FormID> g_frozen;
// The client's copies of server items, which SpawnProcess keyframes as it enables them
std::unordered_set<RE::FormID> g_serverCopies;
std::unordered_map<RE::FormID, CellStats> g_cellStats;
std::unordered_set<RE::FormID> g_loggedCells;

// Event sinks run on other engine threads than Update, so they only queue ids
template <class F>
void Request(F&& change)
{
  std::lock_guard l(g_requestsMutex);
  change(g_requests);
}

class Sinks final
  : public RE::BSTEventSink<RE::TESObjectLoadedEvent>
  , public RE::BSTEventSink<RE::TESCellAttachDetachEvent>
  , public RE::BSTEventSink<RE::TESCellFullyLoadedEvent>
{
public:
  RE::BSEventNotifyControl ProcessEvent(
    const RE::TESObjectLoadedEvent* event,
    RE::BSTEventSource<RE::TESObjectLoadedEvent>*) override
  {
    if (event) {
      Request([&](Requests& r) {
        r.refs.emplace_back(event->formID, event->loaded);
      });
    }
    return RE::BSEventNotifyControl::kContinue;
  }

  RE::BSEventNotifyControl ProcessEvent(
    const RE::TESCellAttachDetachEvent* event,
    RE::BSTEventSource<RE::TESCellAttachDetachEvent>*) override
  {
    if (event && event->reference) {
      const auto id = event->reference->GetFormID();
      Request([&](Requests& r) { r.refs.emplace_back(id, event->attached); });
    }
    return RE::BSEventNotifyControl::kContinue;
  }

  RE::BSEventNotifyControl ProcessEvent(
    const RE::TESCellFullyLoadedEvent* event,
    RE::BSTEventSource<RE::TESCellFullyLoadedEvent>*) override
  {
    if (event && event->cell) {
      const auto id = event->cell->GetFormID();
      Request([&](Requests& r) { r.cells.push_back(id); });
    }
    return RE::BSEventNotifyControl::kContinue;
  }
};

void Install()
{
  static Sinks sinks;
  const auto holder = RE::ScriptEventSourceHolder::GetSingleton();
  if (!holder) {
    spdlog::error("StaticFreeze: no script event source, nothing is frozen");
    return;
  }
  holder->AddEventSink<RE::TESObjectLoadedEvent>(&sinks);
  holder->AddEventSink<RE::TESCellAttachDetachEvent>(&sinks);
  holder->AddEventSink<RE::TESCellFullyLoadedEvent>(&sinks);
  spdlog::info("StaticFreeze: placed havok objects are keyframed as their "
               "3D loads; actors, ammo and projectiles keep physics");
}

// The client's item form types (FormTypeEx.itemTypes) less ammo
bool IsItem(RE::FormType type)
{
  switch (type) {
    case RE::FormType::Armor:
    case RE::FormType::Book:
    case RE::FormType::Ingredient:
    case RE::FormType::KeyMaster:
    case RE::FormType::Light:
    case RE::FormType::Misc:
    case RE::FormType::AlchemyItem:
    case RE::FormType::Scroll:
    case RE::FormType::SoulGem:
    case RE::FormType::Weapon:
      return true;
    default:
      return false;
  }
}

std::optional<Result> KeptReason(RE::TESObjectREFR* ref)
{
  switch (ref->GetFormType()) {
    case RE::FormType::Reference:
      break;
    case RE::FormType::ActorCharacter:
      return Result::kActor;
    case RE::FormType::ProjectileMissile:
    case RE::FormType::ProjectileArrow:
    case RE::FormType::ProjectileGrenade:
    case RE::FormType::ProjectileBeam:
    case RE::FormType::ProjectileFlame:
    case RE::FormType::ProjectileCone:
    case RE::FormType::ProjectileBarrier:
      return Result::kProjectile;
    default:
      return Result::kOther;
  }
  const auto base = ref->GetBaseObject();
  if (!base) {
    return Result::kOther;
  }
  if (base->Is(RE::FormType::Ammo)) {
    return Result::kAmmo;
  }
  // Engine drops like a disarmed weapon stay pickable
  if (ref->IsDynamicForm() && IsItem(base->GetFormType()) &&
      !g_serverCopies.contains(ref->GetFormID())) {
    return Result::kRuntimeItem;
  }
  return std::nullopt;
}

bool IsDynamic(RE::hkpMotion::MotionType type)
{
  using Type = RE::hkpMotion::MotionType;
  return type == Type::kDynamic || type == Type::kSphereInertia ||
    type == Type::kBoxInertia || type == Type::kThinBoxInertia;
}

// A body gravity or a bump can move
bool HasDynamicBody(RE::NiAVObject* root)
{
  bool found = false;
  RE::BSVisit::TraverseScenegraphCollision(
    root, [&](RE::bhkNiCollisionObject* collision) {
      const auto body =
        collision->body ? collision->body->AsBhkRigidBody() : nullptr;
      const auto hkBody = body
        ? static_cast<RE::hkpRigidBody*>(body->referencedObject.get())
        : nullptr;
      found = hkBody && IsDynamic(hkBody->motion.type.get());
      return found ? RE::BSVisit::BSVisitControl::kStop
                   : RE::BSVisit::BSVisitControl::kContinue;
    });
  return found;
}

// The call Papyrus SetMotionType makes, with the arguments the client used
bool FreezeDynamic(RE::TESObjectREFR* ref, RE::NiAVObject* root)
{
  if (!HasDynamicBody(root)) {
    return false;
  }
  ref->SetMotionType(RE::TESObjectREFR::MotionType::kKeyframed, false);
  return true;
}

CellStats* StatsFor(RE::TESObjectREFR* ref, Clock::time_point now)
{
  const auto cell = ref->GetParentCell();
  if (!cell || !cell->IsAttached() ||
      g_loggedCells.contains(cell->GetFormID())) {
    return nullptr;
  }
  auto& stats = g_cellStats[cell->GetFormID()];
  stats.last = now;
  return &stats;
}

// A ref counts once per cell line, and frozen outranks a later look that finds it keyframed
void Record(RE::TESObjectREFR* ref, Result result, Source source,
            Clock::time_point now)
{
  const auto stats = StatsFor(ref, now);
  if (!stats) {
    return;
  }
  const auto [it, inserted] =
    stats->results.try_emplace(ref->GetFormID(), result);
  if (result == Result::kFrozen &&
      (inserted || it->second != Result::kFrozen)) {
    if (source == Source::kCellSweep) {
      ++stats->byCellSweep;
    } else if (source == Source::kLoadSweep) {
      ++stats->byLoadSweep;
    }
  }
  if (it->second != Result::kFrozen) {
    it->second = result;
  }
}

// Returns whether the ref stays pending
bool Look(RE::FormID id, Pending& pending, Clock::time_point now)
{
  const auto ref = RE::TESForm::LookupByID<RE::TESObjectREFR>(id);
  if (!ref) {
    g_frozen.erase(id);
    return false;
  }
  // Checked on follow-ups too, since ff ids are reused
  if (const auto reason = KeptReason(ref)) {
    g_frozen.erase(id);
    if (pending.pass == 0) {
      Record(ref, *reason, pending.source, now);
    }
    return false;
  }
  const auto cell = ref->GetParentCell();
  const bool attached = cell && cell->IsAttached();
  const RE::NiPointer<RE::NiAVObject> root(attached ? ref->Get3D() : nullptr);
  if (pending.pass > 0) {
    // 3D that comes back queues the ref again through objectLoaded
    if (!root) {
      return false;
    }
    if (FreezeDynamic(ref, root.get())) {
      if (const auto stats = StatsFor(ref, now)) {
        ++stats->refrozen;
      }
    }
    if (pending.pass >= kFollowUpGaps.size()) {
      return false;
    }
    pending.due = now + kFollowUpGaps[pending.pass++];
    return true;
  }
  if (!root) {
    if (pending.source == Source::kEvent && !ref->IsDisabled() &&
        ++pending.tries < kNo3DTries) {
      pending.due = now + kNo3DRetry;
      return true;
    }
    Record(ref, Result::kNo3D, pending.source, now);
    return false;
  }
  const bool frozen = FreezeDynamic(ref, root.get());
  Record(ref, frozen ? Result::kFrozen : Result::kNoHavok, pending.source,
         now);
  // An event may rebuild the havok of a ref frozen earlier
  const bool frozenEarlier =
    g_frozen.contains(id) || g_serverCopies.contains(id);
  if (!frozen && (pending.source != Source::kEvent || !frozenEarlier)) {
    return false;
  }
  g_frozen.insert(id);
  pending.due = now + kFollowUpGaps[0];
  pending.pass = 1;
  return true;
}

// RE::TES::ForEachReference and TES members past 0x128 have SE offsets in this CommonLib build, wrong on 1.6
template <class F>
void ForEachLoadedCell(F&& f)
{
  const auto tes = RE::TES::GetSingleton();
  if (!tes) {
    return;
  }
  if (tes->interiorCell) {
    f(tes->interiorCell);
    return;
  }
  const auto grid = tes->gridCells;
  const uint32_t length = grid ? grid->length : 0;
  for (uint32_t x = 0; x < length; ++x) {
    for (uint32_t y = 0; y < length; ++y) {
      f(grid->GetCell(x, y));
    }
  }
}

void TakeRequests(Clock::time_point now)
{
  Requests requests;
  {
    std::lock_guard l(g_requestsMutex);
    std::swap(requests, g_requests);
  }
  if (requests.reset) {
    g_pending.clear();
    g_frozen.clear();
    g_serverCopies.clear();
    g_cellStats.clear();
    g_loggedCells.clear();
  }
  for (const auto& [id, serverCopy] : requests.serverCopies) {
    if (serverCopy) {
      g_serverCopies.insert(id);
    } else {
      g_serverCopies.erase(id);
    }
  }
  for (const auto& [id, loaded] : requests.refs) {
    // New 3D brings new havok bodies, so the ref starts over
    if (loaded) {
      g_pending[id] = Pending{ now };
    } else {
      g_pending.erase(id);
      g_frozen.erase(id);
    }
  }
  const auto sweep = [&](RE::TESObjectCELL* cell, Source source) {
    if (!cell || !cell->IsAttached()) {
      return;
    }
    cell->ForEachReference([&](RE::TESObjectREFR* ref) {
      if (ref) {
        g_pending.try_emplace(ref->GetFormID(), Pending{ now, source });
      }
      return RE::BSContainer::ForEachResult::kContinue;
    });
  };
  for (const auto cellId : requests.cells) {
    sweep(RE::TESForm::LookupByID<RE::TESObjectCELL>(cellId),
          Source::kCellSweep);
  }
  // Last, so its count holds only refs no event or cell sweep queued
  if (requests.sweepAll) {
    ForEachLoadedCell(
      [&](RE::TESObjectCELL* cell) { sweep(cell, Source::kLoadSweep); });
  }
}

void FlushLogs(Clock::time_point now)
{
  for (auto it = g_cellStats.begin(); it != g_cellStats.end();) {
    const auto& stats = it->second;
    if (now - stats.last < kLogQuiet) {
      ++it;
      continue;
    }
    std::array<uint32_t, static_cast<size_t>(Result::kCount)> n{};
    for (const auto& [id, result] : stats.results) {
      ++n[static_cast<size_t>(result)];
    }
    const auto count = [&](Result result) {
      return n[static_cast<size_t>(result)];
    };
    spdlog::info(
      "StaticFreeze: cell {:08X} froze {} refs ({} only by a cell sweep, {} "
      "only by the post-load sweep, {} frozen again on a follow-up); kept {} "
      "without dynamic havok, {} actors, {} projectiles, {} ammo, {} runtime "
      "items, {} without 3D, {} other",
      it->first, count(Result::kFrozen), stats.byCellSweep,
      stats.byLoadSweep, stats.refrozen,
      count(Result::kNoHavok), count(Result::kActor),
      count(Result::kProjectile), count(Result::kAmmo),
      count(Result::kRuntimeItem), count(Result::kNo3D),
      count(Result::kOther));
    g_loggedCells.insert(it->first);
    it = g_cellStats.erase(it);
  }
}
}

void StaticFreeze::HandleSkseMessage(SKSE::MessagingInterface::Message* msg)
{
  switch (msg->type) {
    case SKSE::MessagingInterface::kDataLoaded:
      Install();
      break;
    case SKSE::MessagingInterface::kPreLoadGame:
      Request([](Requests& r) {
        r = Requests{};
        r.reset = true;
      });
      break;
    case SKSE::MessagingInterface::kPostLoadGame:
      Request([](Requests& r) { r.sweepAll = true; });
      break;
  }
}

void StaticFreeze::MarkServerCopy(RE::FormID id, bool serverCopy)
{
  Request([&](Requests& r) { r.serverCopies.emplace_back(id, serverCopy); });
}

void StaticFreeze::Update()
{
  try {
    const auto now = Clock::now();
    TakeRequests(now);
    size_t budget = kBudget;
    for (auto it = g_pending.begin(); it != g_pending.end() && budget > 0;) {
      if (it->second.due > now) {
        ++it;
        continue;
      }
      --budget;
      it =
        Look(it->first, it->second, now) ? std::next(it) : g_pending.erase(it);
    }
    FlushLogs(now);
  } catch (const std::exception& e) {
    static std::once_flag once;
    std::call_once(once, [&] { spdlog::error("StaticFreeze: {}", e.what()); });
  }
}
