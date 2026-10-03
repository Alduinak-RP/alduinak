#include "ObjectReferenceApi.h"

#include "CallNativeApi.h"
#include "CarryHold.h"
#include "NullPointerException.h"
#include "SkyrimPlatform.h"

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

namespace {
RE::TESObjectREFR* GetArgObjectReference(const Napi::Value& arg)
{
  auto formId = NapiHelper::ExtractUInt32(arg, "refrFormId");
  auto refr = RE::TESForm::LookupByID<RE::TESObjectREFR>(formId);

  if (!refr) {
    throw NullPointerException("refr");
  }

  return refr;
}

// Accepts a form id or any Papyrus object wrapper exposing getFormID
uint32_t GetArgFormId(const Napi::Value& arg)
{
  if (arg.IsNumber()) {
    return arg.As<Napi::Number>().Uint32Value();
  }

  if (!arg.IsObject()) {
    return 0;
  }

  auto getFormId = arg.As<Napi::Object>().Get("getFormID");

  if (!getFormId.IsFunction()) {
    return 0;
  }

  auto formId = getFormId.As<Napi::Function>().Call(arg, {});

  return formId.IsNumber() ? formId.As<Napi::Number>().Uint32Value() : 0;
}

enum class MountResult
{
  kAllowed,
  kSeated,
  kSeatedPending,
  kAlreadySeated,
  kRidingOther,
  kNoActor,
  kOutsideUpdate,
  kSameActor,
  kDeleted,
  kNot3DLoaded,
  kDisabled,
  kOtherCell,
  kRiderIsMount,
  kNotAMount,
  kRiderOnMount,
  kMountTaken,
  kDead,
  kRagdoll,
  kNoActorState,
  kSitSleep,
  kKnocked,
  kInFurniture,
  kActivateRefused,
  kNoMountState,
  kNoLink,
  kFaulted
};

const char* DescribeMountResult(MountResult result)
{
  switch (result) {
    case MountResult::kAllowed:
      return "allowed";
    case MountResult::kSeated:
      return "seated";
    case MountResult::kSeatedPending:
      return "seated, mount link pending";
    case MountResult::kAlreadySeated:
      return "already seated";
    case MountResult::kRidingOther:
      return "riding another mount";
    case MountResult::kNoActor:
      return "not an actor";
    case MountResult::kOutsideUpdate:
      return "outside the update loop";
    case MountResult::kSameActor:
      return "rider is the mount";
    case MountResult::kDeleted:
      return "deleted form";
    case MountResult::kNot3DLoaded:
      return "no 3D loaded";
    case MountResult::kDisabled:
      return "disabled";
    case MountResult::kOtherCell:
      return "another cell";
    case MountResult::kRiderIsMount:
      return "rider is a mount";
    case MountResult::kNotAMount:
      return "target is not a mount";
    case MountResult::kRiderOnMount:
      return "rider already on a mount";
    case MountResult::kMountTaken:
      return "mount is ridden";
    case MountResult::kDead:
      return "dead";
    case MountResult::kRagdoll:
      return "ragdoll";
    case MountResult::kNoActorState:
      return "no actor state";
    case MountResult::kSitSleep:
      return "sitting or sleeping";
    case MountResult::kKnocked:
      return "knocked out";
    case MountResult::kInFurniture:
      return "occupies furniture";
    case MountResult::kActivateRefused:
      return "activate returned false";
    case MountResult::kNoMountState:
      return "activated but not mounted";
    case MountResult::kNoLink:
      return "mounted another actor";
    case MountResult::kFaulted:
      return "faulted";
  }

  return "unknown";
}

bool IsSeated(MountResult result)
{
  return result == MountResult::kSeated ||
    result == MountResult::kSeatedPending ||
    result == MountResult::kAlreadySeated;
}

// The two seat transitions happen once per ride, so they are never deduped
bool IsSeatTransition(MountResult result)
{
  return result == MountResult::kSeated ||
    result == MountResult::kSeatedPending;
}

bool IsRidingThisMount(RE::Actor* rider, RE::Actor* mount)
{
  RE::NiPointer<RE::Actor> currentMount;
  return rider->GetMount(currentMount) && currentMount.get() == mount;
}

MountResult CanSeatOnMount(RE::Actor* rider, RE::Actor* mount)
{
  if (rider == mount) {
    return MountResult::kSameActor;
  }

  if (rider->IsDeleted() || mount->IsDeleted()) {
    return MountResult::kDeleted;
  }

  if (!rider->Is3DLoaded() || !mount->Is3DLoaded()) {
    return MountResult::kNot3DLoaded;
  }

  if (rider->IsDisabled() || mount->IsDisabled()) {
    return MountResult::kDisabled;
  }

  if (!rider->GetParentCell() ||
      rider->GetParentCell() != mount->GetParentCell()) {
    return MountResult::kOtherCell;
  }

  if (rider->IsAMount()) {
    return MountResult::kRiderIsMount;
  }

  if (!mount->IsAMount() && !mount->IsHorse()) {
    return MountResult::kNotAMount;
  }

  if (rider->IsOnMount()) {
    return MountResult::kRiderOnMount;
  }

  if (mount->IsBeingRidden()) {
    return MountResult::kMountTaken;
  }

  if (rider->IsDead() || mount->IsDead()) {
    return MountResult::kDead;
  }

  if (rider->IsInRagdollState()) {
    return MountResult::kRagdoll;
  }

  auto* riderState = rider->AsActorState();

  if (!riderState) {
    return MountResult::kNoActorState;
  }

  if (riderState->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal) {
    return MountResult::kSitSleep;
  }

  if (riderState->GetKnockState() != RE::KNOCK_STATE_ENUM::kNormal) {
    return MountResult::kKnocked;
  }

  if (rider->GetOccupiedFurniture()) {
    return MountResult::kInFurniture;
  }

  return MountResult::kAllowed;
}

// Drives the engine mount interaction, then snaps the rider into the saddle
MountResult SeatRiderOnMount(RE::Actor* rider, RE::Actor* mount)
{
  if (rider->IsOnMount()) {
    return IsRidingThisMount(rider, mount) ? MountResult::kAlreadySeated
                                           : MountResult::kRidingOther;
  }

  const MountResult blocker = CanSeatOnMount(rider, mount);

  if (blocker != MountResult::kAllowed) {
    return blocker;
  }

  const bool activated = mount->ActivateRef(rider, 0, nullptr, 1, true);

  if (!rider->IsOnMount()) {
    return activated ? MountResult::kNoMountState
                     : MountResult::kActivateRefused;
  }

  rider->PutActorOnMountQuick();

  if (!IsRidingThisMount(rider, mount)) {
    return MountResult::kNoLink;
  }

  // The mount side of the link arrives over the transition, a tick later
  return mount->IsBeingRidden() ? MountResult::kSeated
                                : MountResult::kSeatedPending;
}

// A wrong engine address or a broken form gives a reason, not a crash
MountResult SeatRiderOnMountGuarded(RE::Actor* rider,
                                    RE::Actor* mount) noexcept
{
  __try {
    return SeatRiderOnMount(rider, mount);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return MountResult::kFaulted;
  }
}

// Activation spawns AI packages and anim events, so it needs the game thread
MountResult SeatOnGameThread(uint32_t riderId, uint32_t mountId)
{
  // The game thread only pumps the io context while the update loop is running
  if (!g_nativeCallRequirements.vm) {
    return MountResult::kOutsideUpdate;
  }

  MountResult result = MountResult::kNoActor;

  SkyrimPlatform::GetSingleton()->PushToGameThreadAndWait([&] {
    auto* rider = RE::TESForm::LookupByID<RE::Actor>(riderId);
    auto* mount = RE::TESForm::LookupByID<RE::Actor>(mountId);

    if (rider && mount) {
      result = SeatRiderOnMountGuarded(rider, mount);
    }
  });

  return result;
}

struct LastOutcome
{
  uint32_t mountId = 0;
  MountResult result = MountResult::kAllowed;
};

// Keeps a retrying client from repeating one outcome, per rider
bool IsNewMountResult(uint32_t riderId, uint32_t mountId, MountResult result)
{
  static robin_hood::unordered_map<uint32_t, LastOutcome> lastByRider;

  auto& last = lastByRider[riderId];

  if (last.mountId == mountId && last.result == result &&
      !IsSeatTransition(result)) {
    return false;
  }

  last.mountId = mountId;
  last.result = result;
  return true;
}
}

Napi::Value ObjectReferenceApi::SetCollision(const Napi::CallbackInfo& info)
{
  auto refr = GetArgObjectReference(info[0]);
  refr->SetCollision(NapiHelper::ExtractBoolean(info[1], "collision"));
  return info.Env().Undefined();
}

namespace {
// Closest ray hit that is neither the ignored ref nor an actor; terrain has no ref and counts
struct SkipRefCollector : RE::hkpRayHitCollector
{
  RE::hkpWorldRayCastOutput rayHit;
  RE::TESObjectREFR* ignore = nullptr;

  void AddRayHit(const RE::hkpCdBody& a_body,
                 const RE::hkpShapeRayCastCollectorOutput& a_hit) override
  {
    const RE::hkpCdBody* root = &a_body;
    while (root->parent) {
      root = root->parent;
    }
    auto collidable = static_cast<const RE::hkpCollidable*>(root);
    auto ref = RE::TESHavokUtilities::FindCollidableRef(*collidable);
    if (ref && (ref == ignore || ref->Is(RE::FormType::ActorCharacter))) {
      return;
    }
    if (a_hit.hitFraction >= rayHit.hitFraction) {
      return;
    }
    rayHit.normal.quad = a_hit.normal.quad;
    rayHit.hitFraction = a_hit.hitFraction;
    rayHit.rootCollidable = collidable;
    earlyOutHitFraction = a_hit.hitFraction;
  }
};

enum class LookHow : uint8_t
{
  kNone,
  kHit,
  kDown,
  kMiss,
  kBudget,
  kFaulted,
  kOutsideUpdate
};

const char* LookHowName(LookHow how)
{
  switch (how) {
    case LookHow::kHit:
      return "hit";
    case LookHow::kDown:
      return "down";
    case LookHow::kMiss:
      return "miss";
    case LookHow::kBudget:
      return "budget";
    case LookHow::kFaulted:
      return "faulted";
    case LookHow::kOutsideUpdate:
      return "outside update";
    default:
      return "none";
  }
}

struct LookOut
{
  LookHow how = LookHow::kNone;
  float pos[3] = { 0, 0, 0 };
  uint32_t refId = 0;
  int32_t layer = -1;
};

struct RayOut
{
  bool hit = false;
  bool budget = false;
  RE::NiPoint3 pos;
  float normalZ = 0;
  uint32_t refId = 0;
  int32_t layer = -1;
};

RayOut CastRay(RE::bhkWorld* world, const RE::NiPoint3& from,
               const RE::NiPoint3& to, uint32_t filterInfo,
               RE::TESObjectREFR* ignore)
{
  RayOut out;
  const float scale = RE::bhkWorld::GetWorldScale();
  RE::bhkPickData pick;
  pick.rayInput.from.quad =
    _mm_setr_ps(from.x * scale, from.y * scale, from.z * scale, 0.0f);
  pick.rayInput.to.quad =
    _mm_setr_ps(to.x * scale, to.y * scale, to.z * scale, 0.0f);
  pick.rayInput.filterInfo = filterInfo;
  SkipRefCollector collector;
  collector.ignore = ignore;
  pick.rayHitCollectorA8 =
    reinterpret_cast<RE::hkpClosestRayHitCollector*>(&collector);
  world->PickObject(pick);
  auto root = collector.rayHit.rootCollidable;
  if (!root) {
    out.budget = pick.unkC0;
    return out;
  }
  float normal[4];
  _mm_storeu_ps(normal, collector.rayHit.normal.quad);
  out.hit = true;
  out.pos = from + (to - from) * collector.rayHit.hitFraction;
  out.normalZ = normal[2];
  auto ref = RE::TESHavokUtilities::FindCollidableRef(*root);
  out.refId = ref ? ref->GetFormID() : 0;
  out.layer = static_cast<int32_t>(root->GetCollisionLayer());
  return out;
}

void SetLook(LookOut& out, LookHow how, const RayOut& ray)
{
  out.how = how;
  out.pos[0] = ray.pos.x;
  out.pos[1] = ray.pos.y;
  out.pos[2] = ray.pos.z;
  out.refId = ray.refId;
  out.layer = ray.layer;
}

// Along the camera's view from the player's eye: a floor-like hit, else straight down from the wall or the end of reach
void Look(uint32_t ignoreId, float reach, LookOut& out)
{
  auto player = RE::PlayerCharacter::GetSingleton();
  auto cell = player ? player->GetParentCell() : nullptr;
  auto world = cell ? cell->GetbhkWorld() : nullptr;
  auto camera = RE::Main::WorldRootCamera();
  if (!world || !camera) {
    return;
  }
  const auto& rotate = camera->world.rotate;
  const RE::NiPoint3 dir{ rotate.entry[0][0], rotate.entry[1][0],
                          rotate.entry[2][0] };
  const RE::NiPoint3 camPos = camera->world.translate;
  const RE::NiPoint3 feet = player->GetPosition();
  const RE::NiPoint3 eye{ feet.x, feet.y, feet.z + 100.0f };
  const RE::NiPoint3 from =
    camPos + dir * (std::max)(0.0f, (eye - camPos).Dot(dir));
  const RE::NiPoint3 to = from + dir * (reach + 50.0f);
  uint32_t info = 0;
  player->GetCollisionFilterInfo(info);
  const uint32_t filter =
    (info & 0xFFFF0000) | static_cast<uint32_t>(RE::COL_LAYER::kLOS);
  auto ignore =
    ignoreId ? RE::TESForm::LookupByID<RE::TESObjectREFR>(ignoreId) : nullptr;

  const RayOut ahead = CastRay(world, from, to, filter, ignore);
  if (ahead.budget) {
    out.how = LookHow::kBudget;
    return;
  }
  if (ahead.hit && ahead.normalZ >= 0.5f &&
      ahead.pos.GetDistance(feet) <= reach) {
    return SetLook(out, LookHow::kHit, ahead);
  }
  // Short of the wall, and never further than reach from the feet across the ground
  float along = ahead.hit ? ahead.pos.GetDistance(from) - 20.0f : reach;
  const float flat = std::hypot(dir.x, dir.y);
  if (flat > 0.01f) {
    const float aside = std::hypot(from.x - feet.x, from.y - feet.y);
    along = (std::min)(along, (reach - aside) / flat);
  }
  const RE::NiPoint3 top = from + dir * (std::max)(0.0f, along);
  const RE::NiPoint3 bottom{ top.x, top.y, top.z - reach };
  const RayOut down = CastRay(world, top, bottom, filter, ignore);
  if (down.budget) {
    out.how = LookHow::kBudget;
  } else if (down.hit && down.pos.GetDistance(feet) <= reach) {
    SetLook(out, LookHow::kDown, down);
  } else {
    out.how = LookHow::kMiss;
  }
}

// A wrong engine layout gives a reason, not a crash
bool LookGuarded(uint32_t ignoreId, float reach, LookOut& out) noexcept
{
  __try {
    Look(ignoreId, reach, out);
    return true;
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
}
}

// Havok keeps per-thread state only on its own threads and the game thread, so the ray runs there
Napi::Value ObjectReferenceApi::GetLookSurface(const Napi::CallbackInfo& info)
{
  const uint32_t ignoreId = NapiHelper::ExtractUInt32(info[0], "ignoreRefrFormId");
  const float reach = NapiHelper::ExtractFloat(info[1], "reach");
  LookOut out;
  // The game thread only pumps the io context while the update loop is running
  if (!g_nativeCallRequirements.vm) {
    out.how = LookHow::kOutsideUpdate;
  } else {
    bool guarded = false;
    SkyrimPlatform::GetSingleton()->PushToGameThreadAndWait(
      [&] { guarded = LookGuarded(ignoreId, reach, out); });
    if (!guarded) {
      out = LookOut();
      out.how = LookHow::kFaulted;
    }
  }
  auto env = info.Env();
  auto result = Napi::Object::New(env);
  result.Set("how", Napi::String::New(env, LookHowName(out.how)));
  if (out.how == LookHow::kHit || out.how == LookHow::kDown) {
    auto pos = Napi::Array::New(env, 3);
    for (uint32_t i = 0; i < 3; ++i) {
      pos.Set(i, Napi::Number::New(env, out.pos[i]));
    }
    result.Set("pos", pos);
  } else {
    result.Set("pos", env.Null());
  }
  result.Set("refId", Napi::Number::New(env, out.refId));
  result.Set("layer", Napi::Number::New(env, out.layer));
  return result;
}

Napi::Value ObjectReferenceApi::SetCarryHold(const Napi::CallbackInfo& info)
{
  return Napi::Boolean::New(
    info.Env(),
    CarryHold::Set(NapiHelper::ExtractUInt32(info[0], "heldFormId"),
                   NapiHelper::ExtractUInt32(info[1], "carrierFormId"),
                   NapiHelper::ExtractFloat(info[2], "forward"),
                   NapiHelper::ExtractFloat(info[3], "up"),
                   NapiHelper::ExtractFloat(info[4], "yaw")));
}

Napi::Value ObjectReferenceApi::ClearCarryHold(const Napi::CallbackInfo& info)
{
  auto env = info.Env();
  const auto stats =
    CarryHold::Clear(NapiHelper::ExtractUInt32(info[0], "heldFormId"));
  if (!stats) {
    return env.Null();
  }
  const auto sampled =
    stats->frames > stats->snaps ? stats->frames - stats->snaps : 0;
  auto result = Napi::Object::New(env);
  result.Set("frames", Napi::Number::New(env, stats->frames));
  result.Set("skipped", Napi::Number::New(env, stats->skipped));
  result.Set("snaps", Napi::Number::New(env, stats->snaps));
  result.Set("sampled", Napi::Number::New(env, sampled));
  result.Set("meanDrift",
             Napi::Number::New(env, sampled ? stats->driftSum / sampled : 0));
  result.Set("maxDrift", Napi::Number::New(env, stats->maxDrift));
  result.Set("worstSecond", Napi::Number::New(env, stats->worstSecond));
  result.Set("maxYawDrift", Napi::Number::New(env, stats->maxYawDrift));
  return result;
}

Napi::Value ObjectReferenceApi::MountActor(const Napi::CallbackInfo& info)
{
  uint32_t riderId = 0;
  uint32_t mountId = 0;

  // An unusable argument answers false, it never throws into the update loop
  try {
    riderId = GetArgFormId(info[0]);
    mountId = GetArgFormId(info[1]);
  } catch (const std::exception&) {
    return Napi::Boolean::New(info.Env(), false);
  }

  if (!riderId || !mountId) {
    return Napi::Boolean::New(info.Env(), false);
  }

  const MountResult result = SeatOnGameThread(riderId, mountId);

  if (IsNewMountResult(riderId, mountId, result)) {
    spdlog::info("mountActor: {:x} on {:x}: {}", riderId, mountId,
                 DescribeMountResult(result));
  }

  return Napi::Boolean::New(info.Env(), IsSeated(result));
}
