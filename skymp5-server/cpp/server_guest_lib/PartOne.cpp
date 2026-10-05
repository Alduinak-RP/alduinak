#include "PartOne.h"
#include <array>
#include <cassert>
#include <chrono>
#include <string>
#include <vector>

#include "ChangeValuesMessage.h"
#include "CreateActorMessage.h"
#include "CustomPacketMessage.h"
#include "DestroyActorMessage.h"
#include "HostStartMessage.h"
#include "HostStopMessage.h"
#include "SetInventoryMessage.h"
#include "SetRaceMenuOpenMessage.h"

#include "ActionListener.h"
#include "Durability.h"
#include "FormCallbacks.h"
#include "MessageSerializerFactory.h"
#include "PacketParser.h"

PartOneSendTargetWrapper::PartOneSendTargetWrapper(
  Networking::ISendTarget& underlyingSendTarget_)
  : underlyingSendTarget(underlyingSendTarget_)
{
}

void PartOneSendTargetWrapper::Send(Networking::UserId targetUserId,
                                    Networking::PacketData data, size_t length,
                                    bool reliable)
{
  return underlyingSendTarget.Send(targetUserId, data, length, reliable);
}

void PartOneSendTargetWrapper::Send(Networking::UserId targetUserId,
                                    const IMessageBase& message, bool reliable)
{
  SLNet::BitStream stream;

  PartOne::GetMessageSerializerInstance().Serialize(message, stream);

  Send(targetUserId,
       reinterpret_cast<Networking::PacketData>(stream.GetData()),
       stream.GetNumberOfBytesUsed(), reliable);
}

class FakeSendTarget : public Networking::ISendTarget
{
public:
  void Send(Networking::UserId targetUserId, Networking::PacketData data,
            size_t length, bool reliable) override
  {
    std::shared_ptr<IMessageBase> message;

    auto deserializeResult =
      PartOne::GetMessageSerializerInstance().Deserialize(data, length);
    nlohmann::json j;
    if (deserializeResult) {
      deserializeResult->message->WriteJson(j);
      message = std::move(deserializeResult->message);
    } else {
      std::string s(reinterpret_cast<const char*>(data + 1), length - 1);
      j = nlohmann::json::parse(s);
    }

    messages.push_back(PartOne::Message{ j, message, targetUserId, reliable });
  }

  std::vector<PartOne::Message> messages;
};

struct PartOne::Impl
{
  simdjson::dom::parser parser;
  espm::Loader* espm = nullptr;

  std::function<void(PartOneSendTargetWrapper* sendTarget,
                     MpObjectReference* emitter, MpObjectReference* listener)>
    onSubscribe, onUnsubscribe;

  espm::CompressedFieldsCache compressedFieldsCache;

  std::shared_ptr<PacketParser> packetParser;
  std::shared_ptr<ActionListener> actionListener;

  std::shared_ptr<spdlog::logger> logger;

  std::unique_ptr<PartOneSendTargetWrapper> sendTarget;
  std::unique_ptr<IDamageFormula> damageFormula{};
  FakeSendTarget fakeSendTarget;

  GamemodeApi::State gamemodeApiState;
};

PartOne::PartOne(Networking::ISendTarget* sendTarget)
{
  Init();
  SetSendTarget(sendTarget);
}

PartOne::PartOne(std::shared_ptr<Listener> listener,
                 Networking::ISendTarget* sendTarget)
{
  Init();
  AddListener(listener);
  SetSendTarget(sendTarget);
}

PartOne::~PartOne()
{
  // worldState may depend on serverState (actorsMap), we should reset it first
  worldState.Clear();
  serverState = {};
}

void PartOne::SetSendTarget(Networking::ISendTarget* sendTarget)
{
  Networking::ISendTarget* underlyingSendTargetToSet =
    sendTarget ? sendTarget : &pImpl->fakeSendTarget;

  pImpl->sendTarget.reset(
    new PartOneSendTargetWrapper(*underlyingSendTargetToSet));
}

void PartOne::SetDamageFormula(std::unique_ptr<IDamageFormula> dmgFormula)
{
  pImpl->damageFormula = std::move(dmgFormula);
}

void PartOne::AddListener(std::shared_ptr<Listener> listener)
{
  worldState.listeners.push_back(listener);
}

bool PartOne::IsConnected(Networking::UserId userId) const
{
  return serverState.IsConnected(userId);
}

void PartOne::Tick()
{
  TickDeferredMessages();
  worldState.Tick();
}

uint32_t PartOne::CreateActor(uint32_t formId, const NiPoint3& pos,
                              float angleZ, uint32_t cellOrWorld,
                              ProfileId profileId)
{
  if (!formId) {
    formId = worldState.GenerateFormId();
  }
  worldState.AddForm(
    std::unique_ptr<MpActor>(
      new MpActor({ pos,
                    { 0, 0, angleZ },
                    FormDesc::FromFormId(cellOrWorld, worldState.espmFiles) },
                  CreateFormCallbacks())),
    formId);
  if (profileId >= 0) {
    auto& ac = worldState.GetFormAt<MpActor>(formId);
    ac.RegisterProfileId(profileId);
    // Player characters start unequipped, not in the Player record's outfit
    ac.SetEquipment(Equipment());
  }

  return formId;
}

void PartOne::SetUserActor(Networking::UserId userId, uint32_t actorFormId)
{
  serverState.EnsureUserExists(userId);

  if (actorFormId > 0) {
    auto& actor = worldState.GetFormAt<MpActor>(actorFormId);

    if (actor.IsDisabled()) {
      std::stringstream ss;
      ss << "Actor with id " << std::hex << actorFormId << " is disabled";
      throw std::runtime_error(ss.str());
    }

    // Clear actor's hoster if any.
    // HostStop message will be sent on the next attempt to update actor's
    // movement
    // Possible fix for "players link to each other" bug
    // See also ActionListener::SendToNeighbours
    auto hosterActorIt = worldState.hosters.find(actor.GetFormId());
    if (hosterActorIt != worldState.hosters.end()) {
      worldState.hosters.erase(hosterActorIt);
    }

    // Both functions are required here, but it is NOT covered by unit tests
    // properly. If you do something wrong here, players will not be able to
    // interact with items in the same cell after reconnecting.
    actor.UnsubscribeFromAll();
    actor.RemoveFromGridAndUnsubscribeAll();

    serverState.actorsMap.Set(userId, &actor);

    auto& userInfo = *serverState.userInfo[userId];
    userInfo.actorAssignedAt = std::chrono::steady_clock::now();
    userInfo.firstEquipmentReportAt.reset();
    if (userInfo.inventoryActorIdExpected != actorFormId) {
      userInfo.inventoryActorIdExpected = 0;
    }
    if (actor.GetProfileId() >= 0) {
      const auto& saved = actor.GetEquipment();
      spdlog::info("PartOne::SetUserActor {} {:x} - saved outfit {} worn of "
                   "{} (numChanges {})",
                   userId, actorFormId, saved.inv.CountWorn(),
                   saved.inv.entries.size(), saved.numChanges);
    }

    actor.ForceSubscriptionsUpdate();

    // We do the same in MpActor::ApplyChangeForm for non-player characters
    if (actor.IsDead() && !actor.IsRespawning()) {
      spdlog::info("PartOne::SetUserActor {} {:x} - respawning dead actor",
                   userId, actorFormId);
      actor.RespawnWithDelay();
    }

    // This is not currently saved client-side, so reset
    actor.SetLastAnimEvent(std::nullopt);

  } else {
    serverState.actorsMap.Erase(userId);
    serverState.userInfo[userId]->inventoryActorIdExpected = 0;
  }
}

uint32_t PartOne::GetUserActor(Networking::UserId userId)
{
  serverState.EnsureUserExists(userId);

  auto actor = serverState.ActorByUser(userId);
  if (!actor) {
    return 0;
  }
  return actor->GetFormId();
}

std::string PartOne::GetUserGuid(Networking::UserId userId)
{
  serverState.EnsureUserExists(userId);
  return serverState.UserGuid(userId);
}

Networking::UserId PartOne::GetUserByActor(uint32_t formId)
{
  auto& form = worldState.LookupFormById(formId);
  if (form) {
    if (auto ac = form.get()->AsActor()) {
      return serverState.UserByActor(ac);
    }
  }
  return Networking::InvalidUserId;
}

void PartOne::DestroyActor(uint32_t actorFormId)
{
  worldState.GetFormAt<MpActor>(actorFormId).Delete();

  std::shared_ptr<MpActor> destroyedForm;
  worldState.DestroyForm<MpActor>(actorFormId, &destroyedForm);

  serverState.actorsMap.Erase(destroyedForm.get());
}

void PartOne::SetRaceMenuOpen(uint32_t actorFormId, bool open)
{
  auto& actor = worldState.GetFormAt<MpActor>(actorFormId);

  if (actor.IsRaceMenuOpen() == open) {
    return;
  }

  actor.SetRaceMenuOpen(open);

  auto userId = serverState.UserByActor(&actor);
  if (userId == Networking::InvalidUserId) {
    spdlog::warn(
      "PartOne::SetRaceMenuOpen {:x} - actor is not attached to any of users",
      actorFormId);
    return;
  }

  SetRaceMenuOpenMessage message;
  message.open = open;
  pImpl->sendTarget->Send(userId, message, true);
}

void PartOne::SendCustomPacket(Networking::UserId userId,
                               const std::string& jContent)
{
  CustomPacketMessage message;
  message.contentJsonDump = jContent;
  pImpl->sendTarget->Send(userId, message, true);
}

std::string PartOne::GetActorName(uint32_t actorFormId)
{
  auto& ac = worldState.GetFormAt<MpActor>(actorFormId);
  const auto appearance = ac.GetAppearance();
  return appearance ? appearance->name : "Prisoner";
}

NiPoint3 PartOne::GetActorPos(uint32_t actorFormId)
{
  auto& ac = worldState.GetFormAt<MpActor>(actorFormId);
  return ac.GetPos();
}

uint32_t PartOne::GetActorCellOrWorld(uint32_t actorFormId)
{
  auto& ac = worldState.GetFormAt<MpActor>(actorFormId);
  return ac.GetCellOrWorld().ToFormId(worldState.espmFiles);
}

const std::set<uint32_t>& PartOne::GetActorsByProfileId(ProfileId profileId)
{
  return worldState.GetActorsByProfileId(profileId);
}

void PartOne::SetEnabled(uint32_t actorFormId, bool enabled)
{
  auto& ac = worldState.GetFormAt<MpActor>(actorFormId);
  enabled ? ac.Enable() : ac.Disable();
}

void PartOne::AttachEspm(espm::Loader* espm)
{
  pImpl->espm = espm;
  worldState.AttachEspm(espm, [this] { return CreateFormCallbacks(); });
}

void PartOne::AttachSaveStorage(
  std::shared_ptr<
    Viet::ISaveStorage<MpChangeForm, FormDesc, std::vector<FormDesc>>>
    saveStorage)
{
  worldState.AttachSaveStorage(saveStorage);

  auto start = std::chrono::steady_clock::now();

  int n = 0;
  int numPlayerCharacters = 0;
  int numDeleted = 0;
  std::vector<std::optional<MpChangeForm>> tombstones;
  saveStorage->IterateSync([&](const MpChangeForm& changeForm) {
    if (changeForm.isDeleted) {
      ++numDeleted;
      return;
    }

    bool isFF = changeForm.formDesc.file.empty();

    if (isFF) {
      auto baseId = changeForm.baseDesc.ToFormId(worldState.espmFiles);
      auto lookupRes = GetEspm().GetBrowser().LookupById(baseId);

      // Drops the gamemode stamped (PlacedItemSystem) persist until it removes them; older ones are deleted
      bool placed =
        changeForm.dynamicFields.GetValueDump("private.placedAt") != "null";
      if (lookupRes.rec && espm::utils::IsItem(lookupRes.rec->GetType()) &&
          !placed) {
        pImpl->logger->info("Deleting unplaced FF item {} (base {}, {})",
                            changeForm.formDesc.ToString(),
                            changeForm.baseDesc.ToString(),
                            lookupRes.rec->GetType().ToString());
        MpChangeForm tombstone;
        tombstone.formDesc = changeForm.formDesc;
        tombstone.isDeleted = true;
        tombstones.push_back(std::move(tombstone));
        return;
      }
    }

    n++;
    // Do not let players become NPCs
    if (changeForm.profileId >= 0 && !changeForm.isDisabled) {
      MpChangeForm disabled = changeForm;
      disabled.isDisabled = true;
      worldState.LoadChangeForm(disabled, CreateFormCallbacks());
    } else {
      worldState.LoadChangeForm(changeForm, CreateFormCallbacks());
    }
    if (changeForm.profileId >= 0) {
      ++numPlayerCharacters;
    }
  });

  auto end = std::chrono::steady_clock::now();
  auto duration =
    std::chrono::duration_cast<std::chrono::milliseconds>(end - start);

  pImpl->logger->info("AttachSaveStorage took {} seconds and {} milliseconds, "
                      "loaded {} ChangeForms (Including {} player characters), "
                      "skipped {} deleted, deleting {} unplaced FF items",
                      duration.count() / 1000, duration.count() % 1000, n,
                      numPlayerCharacters, numDeleted, tombstones.size());

  if (!tombstones.empty()) {
    saveStorage->Upsert(std::move(tombstones), [] {});
  }
}

espm::Loader& PartOne::GetEspm() const
{
  return worldState.GetEspm();
}

bool PartOne::HasEspm() const
{
  return !worldState.espmFiles.empty();
}

void PartOne::AttachLogger(std::shared_ptr<spdlog::logger> logger)
{
  pImpl->logger = logger;
  worldState.logger = logger;
}

spdlog::logger& PartOne::GetLogger()
{
  if (!pImpl->logger) {
    throw std::runtime_error("no logger attached");
  }
  return *pImpl->logger;
}

namespace {
class ScopedTask
{
public:
  ScopedTask(std::function<void()> f_)
    : f(f_)
  {
  }
  ~ScopedTask() { f(); }

private:
  const std::function<void()> f;
};

bool IsClientMessageType(MsgType msgType)
{
  switch (msgType) {
    case MsgType::CustomPacket:
    case MsgType::UpdateMovement:
    case MsgType::UpdateAnimation:
    case MsgType::UpdateAppearance:
    case MsgType::UpdateEquipment:
    case MsgType::Activate:
    case MsgType::PutItem:
    case MsgType::TakeItem:
    case MsgType::FinishSpSnippet:
    case MsgType::OnEquip:
    case MsgType::ConsoleCommand:
    case MsgType::CraftItem:
    case MsgType::Host:
    case MsgType::ChangeValues:
    case MsgType::OnHit:
    case MsgType::DropItem:
    case MsgType::PlayerBowShot:
    case MsgType::SpellCast:
    case MsgType::UpdateAnimVariables:
      return true;
    default:
      return false;
  }
}
}

void PartOne::HandlePacket(void* partOneInstance, Networking::UserId userId,
                           Networking::PacketType packetType,
                           Networking::PacketData data, size_t length)
{
  auto this_ = reinterpret_cast<PartOne*>(partOneInstance);

  constexpr size_t kMaxSafeGuid = 1024;

  switch (packetType) {
    case Networking::PacketType::ServerSideUserConnect: {
      // Length is trustworthy here because ServerSideUserConnect contents is
      // generated by us at the server side. However, we double-check it to
      // stay protected if the mechanism changes in the future.
      if (length > kMaxSafeGuid) {
        spdlog::error(
          "PartOne::HandlePacket - ServerSideUserConnect packet with "
          "excessive length: {}, truncating",
          length);
        length = kMaxSafeGuid;
      }
      std::string guid(reinterpret_cast<const char*>(data), length);
      return this_->AddUser(userId, UserType::User, guid);
    }
    case Networking::PacketType::ServerSideUserDisconnect: {
      ScopedTask t([userId, this_] {
        if (auto actor = this_->serverState.ActorByUser(userId)) {
          if (this_->pImpl->actionListener) {
            this_->pImpl->actionListener->ForgetActor(actor->GetFormId());
          }
        }
        this_->serverState.Disconnect(userId);
        this_->serverState.disconnectingUserId = Networking::InvalidUserId;
      });

      this_->serverState.disconnectingUserId = userId;
      // Pending wear is written before the gamemode sees the player leave
      if (auto actor = this_->serverState.ActorByUser(userId)) {
        Durability::Settle(*actor);
      }
      for (auto& listener : this_->worldState.listeners)
        listener->OnDisconnect(userId);
      return;
    }
    case Networking::PacketType::Message:
      return this_->HandleMessagePacket(userId, data, length);
    default:
      spdlog::error("PartOne::HandlePacket - unexpected PacketType: {}",
                    static_cast<int>(packetType));
  }
}

PartOneSendTargetWrapper& PartOne::GetSendTarget() const
{
  if (!pImpl->sendTarget) {
    throw std::runtime_error("No send target found");
  }
  return *pImpl->sendTarget;
}

float PartOne::CalculateDamage(const MpActor& aggressor, const MpActor& target,
                               const HitData& hitData) const
{
  if (!pImpl->damageFormula) {
    throw std::runtime_error("no damage formula");
  }
  return pImpl->damageFormula->CalculateDamage(aggressor, target, hitData);
}

float PartOne::CalculateDamage(const MpActor& aggressor, const MpActor& target,
                               const SpellCastData& spellCastData) const
{
  if (!pImpl->damageFormula) {
    throw std::runtime_error("no damage formula");
  }
  return pImpl->damageFormula->CalculateDamage(aggressor, target,
                                               spellCastData);
}

void PartOne::NotifyGamemodeApiStateChanged(
  const GamemodeApi::State& newState) noexcept
{
  pImpl->gamemodeApiState = newState;
}

void PartOne::SendHostStop(Networking::UserId badHosterUserId,
                           MpObjectReference& remote)
{
  auto remoteAsActor = remote.AsActor();

  uint64_t longFormId = remote.GetFormId();
  if (remoteAsActor && longFormId < 0xff000000) {
    longFormId += 0x100000000;
  }

  HostStopMessage message;
  message.target = longFormId;
  GetSendTarget().Send(badHosterUserId, message, true);
}

void PartOne::StartHosting(Networking::UserId hosterUserId,
                           MpObjectReference& remote)
{
  // Prevents too fast host switch
  worldState.SetLastMovUpdate(remote.GetIdx(),
                              std::chrono::system_clock::now());

  auto remoteAsActor = remote.AsActor();
  if (remoteAsActor) {
    remoteAsActor->EquipBestWeapon();
  }

  uint64_t longFormId = remote.GetFormId();
  if (remoteAsActor && longFormId < 0xff000000) {
    longFormId += 0x100000000;
  }

  HostStartMessage message;
  message.target = longFormId;
  GetSendTarget().Send(hosterUserId, message, true);

  if (!remoteAsActor) {
    return;
  }

  // Otherwise the new host keeps a stale health percentage until someone hits the actor
  auto formId = remote.GetFormId();
  worldState.SetTimer(std::chrono::seconds(1))
    .Then([this, formId](Viet::Void) {
      auto& form = worldState.LookupFormByIdNoLoad(formId);
      MpActor* actor = form ? form->AsActor() : nullptr;
      if (!actor) {
        return;
      }

      const auto& actorValues = actor->GetActorValues();

      ChangeValuesMessage msg;
      msg.idx = actor->GetIdx();
      msg.data.health = actorValues.healthPercentage;
      msg.data.magicka = actorValues.magickaPercentage;
      msg.data.stamina = actorValues.staminaPercentage;
      actor->GetActorToSendTo().SendToUser(msg, true);
    });
}

FormCallbacks PartOne::CreateFormCallbacks()
{
  auto st = &serverState;

  FormCallbacks::SubscribeCallback
    subscribe =
      [this](MpObjectReference* emitter, MpObjectReference* listener) {
        return pImpl->onSubscribe(pImpl->sendTarget.get(), emitter, listener);
      },
    unsubscribe = [this](MpObjectReference* emitter,
                         MpObjectReference* listener) {
      return pImpl->onUnsubscribe(pImpl->sendTarget.get(), emitter, listener);
    };

  FormCallbacks::SendToUserFn sendToUser =
    [this, st](MpActor* actor, const IMessageBase& message, bool reliable) {
      auto targetuserId = st->UserByActor(actor);
      if (targetuserId == Networking::InvalidUserId ||
          st->disconnectingUserId == targetuserId) {
        return;
      }

      SLNet::BitStream stream;
      GetMessageSerializerInstance().Serialize(message, stream);
      pImpl->sendTarget->Send(
        targetuserId,
        reinterpret_cast<Networking::PacketData>(stream.GetData()),
        stream.GetNumberOfBytesUsed(), reliable);
    };

  FormCallbacks::SendToUserDeferredFn sendToUserDeferred =
    [this, st](MpActor* actor, const IMessageBase& message, bool reliable,
               int deferredChannelId, bool overwritePreviousChannelMessages) {
      if (deferredChannelId < 0 || deferredChannelId >= 100) {
        return spdlog::error(
          "sendToUserDeferred - invalid deferredChannelId {}",
          deferredChannelId);
      }

      auto targetuserId = st->UserByActor(actor);
      if (targetuserId == Networking::InvalidUserId ||
          st->disconnectingUserId == targetuserId) {
        // It's ok, it happens
        return;
      }

      auto& userInfo = st->userInfo[targetuserId];
      if (!userInfo) {
        return spdlog::error("sendToUserDeferred - null userInfo for user {}",
                             targetuserId);
      }

      SLNet::BitStream stream;
      GetMessageSerializerInstance().Serialize(message, stream);

      DeferredMessage deferredMessage;
      deferredMessage.packetData = {
        reinterpret_cast<const Networking::PacketData>(stream.GetData()),
        reinterpret_cast<const Networking::PacketData>(stream.GetData()) +
          stream.GetNumberOfBytesUsed()
      };
      deferredMessage.packetReliable = reliable;
      deferredMessage.actorIdExpected = actor->GetFormId();

      if (userInfo->deferredChannels.size() <= deferredChannelId) {
        userInfo->deferredChannels.resize(deferredChannelId + 1);
      }

      if (overwritePreviousChannelMessages) {
        userInfo->deferredChannels[deferredChannelId] = { deferredMessage };
      } else {
        userInfo->deferredChannels[deferredChannelId].push_back(
          deferredMessage);
      }
      st->MarkDeferred(targetuserId, *userInfo);
    };

  FormCallbacks::GetUserIdFn getUserId =
    [this, st](MpActor* actor) -> Networking::UserId {
    return st->UserByActor(actor);
  };

  FormCallbacks::SendInventoryUpdateFn sendInventoryUpdate =
    [st](MpActor* actor) {
      auto targetuserId = st->UserByActor(actor);
      if (targetuserId == Networking::InvalidUserId ||
          st->disconnectingUserId == targetuserId) {
        return;
      }
      if (auto& userInfo = st->userInfo[targetuserId]) {
        userInfo->inventoryActorIdExpected = actor->GetFormId();
        st->MarkDeferred(targetuserId, *userInfo);
      }
    };

  return { subscribe,          unsubscribe, sendToUser,
           sendToUserDeferred, getUserId,   sendInventoryUpdate };
}

ActionListener& PartOne::GetActionListener()
{
  InitActionListener();
  return *pImpl->actionListener;
}

const std::vector<std::shared_ptr<PartOne::Listener>>& PartOne::GetListeners()
  const
{
  return worldState.listeners;
}

std::vector<PartOne::Message>& PartOne::Messages()
{
  return pImpl->fakeSendTarget.messages;
}

void PartOne::Init()
{
  pImpl.reset(new Impl);
  pImpl->logger.reset(new spdlog::logger{ "empty logger" });

  pImpl->onSubscribe = [this](PartOneSendTargetWrapper* sendTarget,
                              MpObjectReference* emitter,
                              MpObjectReference* listener) {
    if (!emitter) {
      throw std::runtime_error("nullptr emitter in onSubscribe");
    }

    MpActor* listenerAsActor = listener->AsActor();
    if (!listenerAsActor) {
      return;
    }

    auto listenerUserId = serverState.UserByActor(listenerAsActor);
    if (listenerUserId == Networking::InvalidUserId) {
      return;
    }

    auto& emitterPos = emitter->GetPos();
    auto& emitterRot = emitter->GetAngle();

    bool isMe = emitter == listener;

    MpActor* emitterAsActor = emitter->AsActor();

    CreateActorMessage message;

    std::string jAnimation;

    if (emitterAsActor) {
      auto appearance = emitterAsActor->GetAppearance();
      message.appearance = appearance
        ? std::optional<Appearance>(*appearance)
        : std::optional<Appearance>(std::nullopt);
    }

    if (emitterAsActor) {
      message.equipment = isMe ? emitterAsActor->GetEquipment()
                               : emitterAsActor->GetEquipment().Worn();
    }

    if (emitterAsActor) {
      message.animation = emitterAsActor->GetLastAnimEvent();
    }

    uint64_t longFormId = emitter->GetFormId();
    if (emitterAsActor && longFormId < 0xff000000) {
      longFormId += 0x100000000;
    }
    message.refrId = longFormId;

    if (emitter->GetBaseId() != 0x00000000 &&
        emitter->GetBaseId() != 0x00000007) {
      message.baseId = emitter->GetBaseId();
    }

    const bool isOwner = emitter == listener;

    auto mode = VisitPropertiesMode::OnlyPublic;
    if (isOwner) {
      mode = VisitPropertiesMode::All;
    }

    emitter->VisitProperties(message, mode);

    auto isFilteredOut = [&](const CustomPropsEntry& customPropsEntry) {
      auto it = pImpl->gamemodeApiState.createdProperties.find(
        customPropsEntry.propName);
      if (it != pImpl->gamemodeApiState.createdProperties.end()) {
        if (!it->second.isVisibleByOwner) {
          //  From docs: isVisibleByNeighbors is considered to be always false
          //  for properties with `isVisibleByOwner == false`, in that case,
          //  actual flag value is ignored.
          return true;
        }
        if (!it->second.isVisibleByNeighbors && !isOwner) {
          return true;
        }
      }
      return false;
    };

    message.customPropsJsonDumps.erase(
      std::remove_if(message.customPropsJsonDumps.begin(),
                     message.customPropsJsonDumps.end(), isFilteredOut),
      message.customPropsJsonDumps.end());

    const bool hasUser = emitterAsActor &&
      serverState.UserByActor(emitterAsActor) != Networking::InvalidUserId;
    auto hosterIterator = worldState.hosters.find(emitter->GetFormId());

    if (hasUser ||
        (hosterIterator != worldState.hosters.end() &&
         hosterIterator->second != 0 &&
         hosterIterator->second != listener->GetFormId())) {
      message.props.isHostedByOther = true;
    }

    uint32_t worldOrCell =
      emitter->GetCellOrWorld().ToFormId(worldState.espmFiles);

    // See 'perf: improve game framerate #1186'
    // Client needs to know if it is DOOR or not
    if (const std::string& baseType = emitter->GetBaseType();
        baseType == "DOOR") {
      message.baseRecordType = "DOOR";
      if (emitter->IsEspmForm() &&
          worldState.HasDoorTeleport(emitter->GetFormId())) {
        CustomPropsEntry loadDoor;
        loadDoor.propName = "ff_loadDoor";
        loadDoor.propValueJsonDump = "true";
        message.customPropsJsonDumps.push_back(std::move(loadDoor));
      }
    }

    message.idx = emitter->GetIdx();
    message.isMe = isMe;
    message.transform.pos = { emitterPos.x, emitterPos.y, emitterPos.z };
    message.transform.rot = { emitterRot.x, emitterRot.y, emitterRot.z };
    message.transform.worldOrCell = worldOrCell;

    sendTarget->Send(listenerUserId, message, true);
  };

  pImpl->onUnsubscribe = [this](PartOneSendTargetWrapper* sendTarget,
                                MpObjectReference* emitter,
                                MpObjectReference* listener) {
    MpActor* listenerAsActor = listener->AsActor();
    if (!listenerAsActor) {
      return;
    }

    // The client keeps no form for a non-door plugin ref
    if (emitter->IsEspmForm() && !emitter->AsActor() &&
        emitter->GetBaseType() != "DOOR") {
      return;
    }

    auto listenerUserId = serverState.UserByActor(listenerAsActor);
    if (listenerUserId != Networking::InvalidUserId &&
        listenerUserId != serverState.disconnectingUserId) {
      DestroyActorMessage message;
      message.idx = emitter->GetIdx();
      sendTarget->Send(listenerUserId, message, true);
    }
  };
}

void PartOne::AddUser(Networking::UserId userId, UserType type,
                      const std::string& guid)
{
  serverState.Connect(userId, guid);
  for (auto& listener : worldState.listeners)
    listener->OnConnect(userId);
}

void PartOne::HandleMessagePacket(Networking::UserId userId,
                                  Networking::PacketData data, size_t length)
{
  if (!serverState.IsConnected(userId)) {
    spdlog::error("PartOne::HandleMessagePacket - received Message packet "
                  "from non-existing user {}, ignoring",
                  userId);
    return;
  }

  // Byte 1 is the message type; only CustomPacket works before an actor
  const auto msgType =
    length >= 2 ? static_cast<MsgType>(data[1]) : MsgType::Invalid;
  if (!IsClientMessageType(msgType)) {
    return;
  }
  if (msgType != MsgType::CustomPacket && !serverState.ActorByUser(userId)) {
    return;
  }

  if (!pImpl->packetParser) {
    pImpl->packetParser = std::make_shared<PacketParser>();
  }

  InitActionListener();

  pImpl->packetParser->TransformPacketIntoAction(userId, data, length,
                                                 *pImpl->actionListener);
}

void PartOne::InitActionListener()
{
  if (!pImpl->actionListener) {
    pImpl->actionListener = std::make_shared<ActionListener>(*this);
  }
}

void PartOne::TickDeferredMessages()
{
  auto& users = serverState.deferredUsers;
  for (size_t i = 0; i < users.size(); ++i) {
    const Networking::UserId userId = users[i];
    auto& userInfo = serverState.userInfo[userId];
    if (!userInfo || !userInfo->hasDeferred) {
      continue;
    }
    userInfo->hasDeferred = false;
    auto actor = serverState.ActorByUser(userId);
    const uint32_t inventoryActorId =
      std::exchange(userInfo->inventoryActorIdExpected, 0);
    if (actor && inventoryActorId == actor->GetFormId()) {
      SetInventoryMessage message;
      message.inventory = actor->GetInventory();
      pImpl->sendTarget->Send(userId, message, true);
    }
    for (auto& channel : userInfo->deferredChannels) {
      for (auto& message : channel) {
        if (!actor || message.actorIdExpected != actor->GetFormId()) {
          continue;
        }

        pImpl->sendTarget->Send(
          userId,
          reinterpret_cast<Networking::PacketData>(message.packetData.data()),
          message.packetData.size(), message.packetReliable);
      }
      channel.clear();
    }
  }
  users.clear();
}

MessageSerializer& PartOne::GetMessageSerializerInstance()
{
  static auto g_serializer =
    MessageSerializerFactory::CreateMessageSerializer();
  return *g_serializer;
}
