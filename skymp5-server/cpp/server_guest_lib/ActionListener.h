#pragma once
#include "AnimationData.h"
#include "ConsoleCommands.h"
#include "CraftService.h"
#include "Messages.h"
#include "MpActor.h"
#include "PartOne.h"
#include "RawMessageData.h"
#include "SpellCastData.h"
#include "SweetHidePlayerNamesService.h"
#include "libespm/Loader.h"
#include <chrono>
#include <memory>
#include <unordered_map>
#include <vector>

class ServerState;
class WorldState;
struct ActorValues;

class ActionListener
{
public:
  ActionListener(PartOne& partOne_)
    : partOne(partOne_)
  {
    craftService = std::make_shared<CraftService>(partOne_);
    sweetHidePlayerNamesService =
      std::make_shared<SweetHidePlayerNamesService>(partOne_);
  }

  virtual void OnCustomPacket(const RawMessageData& rawMsgData,
                              const CustomPacketMessage& msg);

  virtual void OnUpdateMovement(const RawMessageData& rawMsgData,
                                const UpdateMovementMessage& msg);

  virtual void OnUpdateAnimation(const RawMessageData& rawMsgData,
                                 const UpdateAnimationMessage& msg);
  virtual void OnUpdateAppearance(const RawMessageData& rawMsgData,
                                  const UpdateAppearanceMessage& msg);
  virtual void OnUpdateEquipment(const RawMessageData& rawMsgData,
                                 const UpdateEquipmentMessage& msg);

  virtual void OnActivate(const RawMessageData& rawMsgData,
                          const ActivateMessage& msg);

  virtual void OnPutItem(const RawMessageData& rawMsgData,
                         const PutItemMessage& msg);
  virtual void OnTakeItem(const RawMessageData& rawMsgData,
                          const TakeItemMessage& msg);
  virtual void OnDropItem(const RawMessageData& rawMsgData,
                          const DropItemMessage& msg);

  virtual void OnPlayerBowShot(const RawMessageData& rawMsgData,
                               const PlayerBowShotMessage& msg);

  virtual void OnFinishSpSnippet(const RawMessageData& rawMsgData,
                                 const FinishSpSnippetMessage& msg);

  virtual void OnEquip(const RawMessageData& rawMsgData,
                       const OnEquipMessage& msg);

  virtual void OnConsoleCommand(const RawMessageData& rawMsgData,
                                const ConsoleCommandMessage& msg);

  virtual void OnCraftItem(const RawMessageData& rawMsgData,
                           const CraftItemMessage& msg);

  virtual void OnHostAttempt(const RawMessageData& rawMsgData,
                             const HostMessage& msg);

  virtual void OnCustomEvent(const RawMessageData& rawMsgData,
                             const CustomEventMessage& msg);

  virtual void OnChangeValues(const RawMessageData& rawMsgData,
                              const ChangeValuesMessage& msg);

  virtual void OnHit(const RawMessageData& rawMsgData, const HitMessage& msg);

  virtual void OnUpdateAnimVariables(const RawMessageData& rawMsgData,
                                     const UpdateAnimVariablesMessage& msg);

  virtual void OnSpellCast(const RawMessageData& rawMsgData,
                           const SpellCastMessage& msg);

  virtual void OnUnknown(const RawMessageData& rawMsgData);

  // for CraftTest.cpp
  const std::shared_ptr<CraftService>& GetCraftService() noexcept
  {
    return craftService;
  }

private:
  struct RestorationChannel
  {
    uint32_t spellId = 0;
    uint32_t targetId = 0;
    std::vector<espm::Effects::Effect> effects;
    bool hasSweetpie = false;
    uint32_t ticks = 0;
    // Timer chains carry the generation they were started for
    uint32_t generation = 0;
    std::chrono::steady_clock::time_point lastRefresh;
  };

  void TickRestorationChannel(uint32_t casterId, uint32_t generation);
  void FireHitDamageEvent(MpActor* aggressor, MpActor* target,
                          uint32_t sourceId, float damage);

  void OnSpellHit(MpActor* aggressor, MpObjectReference* targetRef,
                  const HitData& hitData);
  void OnWeaponHit(MpActor* aggressor, MpObjectReference* targetRef,
                   HitData hitData, bool isUnarmed);

  void SendPapyrusOnHitEvent(MpActor* aggressor, MpObjectReference* target,
                             const HitData& hitData);

  // Returns user's actor if there is attached one
  MpActor* SendToNeighbours(uint32_t idx, Networking::UserId userId,
                            Networking::PacketData data, size_t length,
                            bool reliable);

  MpActor* SendToNeighbours(uint32_t idx, const RawMessageData& rawMsgData,
                            bool reliable = false);

  PartOne& partOne;

  std::unordered_map<uint32_t, RestorationChannel> restorationChannels;
  uint32_t restorationChannelGeneration = 0;

  // TODO: inverse dependency
  std::shared_ptr<CraftService> craftService;
  std::shared_ptr<SweetHidePlayerNamesService> sweetHidePlayerNamesService;
};
