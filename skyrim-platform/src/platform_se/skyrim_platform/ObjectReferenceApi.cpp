#include "ObjectReferenceApi.h"

#include "NullPointerException.h"

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

RE::Actor* GetArgActor(const Napi::Value& arg)
{
  auto formId = GetArgFormId(arg);
  return formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
}

bool IsRidingThisMount(RE::Actor* rider, RE::Actor* mount)
{
  RE::NiPointer<RE::Actor> currentMount;
  return rider->GetMount(currentMount) && currentMount.get() == mount;
}

bool CanSeatOnMount(RE::Actor* rider, RE::Actor* mount)
{
  if (rider == mount || rider->IsDeleted() || mount->IsDeleted()) {
    return false;
  }

  if (!rider->Is3DLoaded() || !mount->Is3DLoaded()) {
    return false;
  }

  if (rider->IsDisabled() || mount->IsDisabled()) {
    return false;
  }

  if (!rider->GetParentCell() ||
      rider->GetParentCell() != mount->GetParentCell()) {
    return false;
  }

  if (rider->IsAMount() || !(mount->IsAMount() || mount->IsHorse())) {
    return false;
  }

  if (rider->IsOnMount() || mount->IsBeingRidden()) {
    return false;
  }

  if (rider->IsDead() || mount->IsDead() || rider->IsInRagdollState()) {
    return false;
  }

  auto* riderState = rider->AsActorState();

  if (!riderState ||
      riderState->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal ||
      riderState->GetKnockState() != RE::KNOCK_STATE_ENUM::kNormal) {
    return false;
  }

  return !rider->GetOccupiedFurniture();
}

// Drives the engine mount interaction, then snaps the rider into the saddle
bool SeatRiderOnMount(RE::Actor* rider, RE::Actor* mount)
{
  if (rider->IsOnMount()) {
    return IsRidingThisMount(rider, mount);
  }

  if (!CanSeatOnMount(rider, mount)) {
    return false;
  }

  mount->ActivateRef(rider, 0, nullptr, 1, true);

  if (!rider->IsOnMount()) {
    return false;
  }

  rider->PutActorOnMountQuick();

  return IsRidingThisMount(rider, mount) && mount->IsBeingRidden();
}

// A wrong engine address or a broken form degrades to false instead of a crash
bool SeatRiderOnMountGuarded(RE::Actor* rider, RE::Actor* mount) noexcept
{
  __try {
    return SeatRiderOnMount(rider, mount);
  } __except (EXCEPTION_EXECUTE_HANDLER) {
    return false;
  }
}

// Keeps a retrying client from filling the log with the same outcome
bool IsNewMountResult(uint32_t riderId, uint32_t mountId, bool seated)
{
  static uint32_t lastRiderId = 0;
  static uint32_t lastMountId = 0;
  static bool lastSeated = false;

  if (riderId == lastRiderId && mountId == lastMountId &&
      seated == lastSeated) {
    return false;
  }

  lastRiderId = riderId;
  lastMountId = mountId;
  lastSeated = seated;
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
  RE::Actor* rider = nullptr;
  RE::Actor* mount = nullptr;

  // An unusable argument answers false, it never throws into the update loop
  try {
    rider = GetArgActor(info[0]);
    mount = GetArgActor(info[1]);
  } catch (const std::exception&) {
    return Napi::Boolean::New(info.Env(), false);
  }

  if (!rider || !mount) {
    return Napi::Boolean::New(info.Env(), false);
  }

  const bool seated = SeatRiderOnMountGuarded(rider, mount);

  if (IsNewMountResult(rider->formID, mount->formID, seated)) {
    spdlog::info("mountActor: {:x} {} {:x}", rider->formID,
                 seated ? "seated on" : "was refused by", mount->formID);
  }

  return Napi::Boolean::New(info.Env(), seated);
}
