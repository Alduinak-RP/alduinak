#include "ObjectReferenceApi.h"

#include "CallNativeApi.h"
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
