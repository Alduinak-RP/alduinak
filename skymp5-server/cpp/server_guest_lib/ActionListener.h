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
struct CombatEspmCache;

class ActionListener
{
public:
  ActionListener(PartOne& partOne_);

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
    // An aimed channel heals whoever its hits land on, 0 until the first hit
    uint32_t targetId = 0;
    bool aimed = false;
    std::chrono::steady_clock::time_point lastHitAt;
    std::vector<espm::Effects::Effect> effects;
    bool hasSweetpie = false;
    uint32_t ticks = 0;
    // Timer chains carry the generation they were started for
    uint32_t generation = 0;
    std::chrono::steady_clock::time_point lastRefresh;
    std::chrono::steady_clock::time_point lastApplied;
  };

  struct WardChannel
  {
    uint32_t spellId = 0;
    std::chrono::steady_clock::time_point lastRefresh;
  };

  void UpdateWardChannel(uint32_t casterId,
                         const SpellCastData& spellCastData);
  bool IsWardBlocking(const MpActor& aggressor, const MpActor& target);

  void ApplyParalysis(MpActor& aggressor, MpActor& target, uint32_t spellId);
  bool IsParalyzed(const MpActor& actor);

  // A blocked Falmer swing still casts its hit poison in the victim's own engine, which reports the loss
  struct BlockedHitGuard
  {
    std::chrono::steady_clock::time_point at;
    // The blocked poison's run plus the report's delay
    std::chrono::steady_clock::time_point until;
    uint32_t aggressorId = 0;
    float poisonHealth = 0.f;
    // Health points of reported loss still to refuse
    float budget = 0.f;
    bool logged = false;
  };

  void TrackNpcHitPoison(const MpActor& aggressor, MpActor& target,
                         bool blocked);
  float GuardReportedHealth(const MpActor& actor, float current,
                            float reported);

  // Health reports cropped while healthRegenerationMultiplier is set
  struct RefusedHealthIncreases
  {
    std::chrono::steady_clock::time_point since;
    uint32_t count = 0;
    float largest = 0.f;
  };

  void NoteRefusedHealthIncrease(const MpActor& actor, float refused,
                                 std::chrono::steady_clock::time_point now);

  void TickRestorationChannel(uint32_t casterId, uint32_t generation);
  MpActor* GetRestorationChannelTarget(uint32_t casterId,
                                       const RestorationChannel& channel);
  void ApplyRestorationChannelRemainder(uint32_t casterId,
                                        const RestorationChannel& channel);
  // What the rebalance formula adds to the arguments of the hit damage events
  struct HitEventDetails
  {
    bool blocked = false;
    bool power = false;
    bool bash = false;
    bool critical = false;
    // Damage before DT, for a spell its damage before a ward
    float preDT = 0.f;
  };

  // Returns false when a gamemode handler blocked the event; details follow the damage as blocked, power, bash, critical, preDT
  bool FireHitDamageEvent(const char* eventName, MpActor* aggressor,
                          MpActor* target, uint32_t sourceId, float damage,
                          bool fireOnZeroDamage = false,
                          const HitEventDetails* details = nullptr);

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

  // sanitizedMsg replaces the owner's raw report when the server changed it
  void RelayEquipment(MpActor& actor, const RawMessageData& rawMsgData,
                      const UpdateEquipmentMessage* sanitizedMsg);

  PartOne& partOne;

  std::unordered_map<uint32_t, RestorationChannel> restorationChannels;
  uint32_t restorationChannelGeneration = 0;
  std::unordered_map<uint32_t, WardChannel> wardChannels;
  std::unordered_map<uint32_t, std::chrono::steady_clock::time_point>
    paralyzedUntil;
  std::unordered_map<uint32_t, BlockedHitGuard> blockedHitGuards;
  std::unordered_map<uint32_t, RefusedHealthIncreases> refusedHealthIncreases;
  // Until when a player's reports can still carry an unblocked hit's poison
  std::unordered_map<uint32_t, std::chrono::steady_clock::time_point>
    unblockedPoisonUntil;

  std::shared_ptr<CombatEspmCache> combatEspmCache;

  // TODO: inverse dependency
  std::shared_ptr<CraftService> craftService;
  std::shared_ptr<SweetHidePlayerNamesService> sweetHidePlayerNamesService;
};
