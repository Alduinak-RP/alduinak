#pragma once
#include "ActorsMap.h"
#include "Config.h"
#include <Networking.h>
#include <array>
#include <chrono>
#include <deque>
#include <map>
#include <memory>
#include <optional>
#include <simdjson.h>
#include <unordered_map>

class MpActor;

struct PacketHistoryElement
{
  size_t offset = 0;
  size_t length = 0;
  uint64_t timeMs = 0;
};

struct PacketHistory
{
  std::vector<uint8_t> buffer;
  std::deque<PacketHistoryElement> packets;
};

struct Playback
{
  PacketHistory history;
  std::chrono::time_point<std::chrono::steady_clock> startTime;
};

struct DeferredMessage
{
  std::vector<uint8_t> packetData;
  bool packetReliable = false;
  uint32_t actorIdExpected = 0;
};

// Lets one event through per period and counts the ones held back
struct RateLimit
{
  std::chrono::steady_clock::time_point lastAt;
  uint32_t held = 0;

  bool Allow(std::chrono::steady_clock::time_point now,
             std::chrono::steady_clock::duration period);
};

// Replies to a refused report and their error line, per actor
struct RefusalLimits
{
  static constexpr std::chrono::seconds kReplyPeriod{ 1 };
  static constexpr std::chrono::seconds kLogPeriod{ 30 };

  RateLimit reply;
  RateLimit log;
};

struct UserInfo
{
  bool isDisconnecting = false;

  bool isPacketHistoryRecording = false;
  PacketHistory packetHistory;
  std::optional<std::chrono::time_point<std::chrono::steady_clock>>
    packetHistoryStartTime;

  std::vector<std::vector<DeferredMessage>> deferredChannels;

  // Actor whose SetInventory is sent at the next deferred flush, 0 for none
  uint32_t inventoryActorIdExpected = 0;

  // Set while the user is listed in ServerState::deferredUsers
  bool hasDeferred = false;

  std::string guid;

  // Start of the spawn equipment guard, set by PartOne::SetUserActor
  std::chrono::steady_clock::time_point actorAssignedAt;
  std::optional<std::chrono::steady_clock::time_point> firstEquipmentReportAt;

  std::unordered_map<uint32_t, RefusalLimits> refusals;
};

class ServerState
{
public:
  ServerState() { userInfo.resize(kMaxPlayers); }

  std::vector<std::unique_ptr<UserInfo>> userInfo;
  Networking::UserId maxConnectedId = 0;
  ActorsMap actorsMap;
  Networking::UserId disconnectingUserId = Networking::InvalidUserId;

  // Users with deferred messages or a pending SetInventory
  std::vector<Networking::UserId> deferredUsers;

  std::map<Networking::UserId, Playback>
    activePlaybacks; // do not modify directly, use requestedPlaybacks
  std::map<Networking::UserId, Playback> requestedPlaybacks;

  void Connect(Networking::UserId userId, const std::string& guid);
  void Disconnect(Networking::UserId userId) noexcept;
  bool IsConnected(Networking::UserId userId) const;
  MpActor* ActorByUser(Networking::UserId userId);
  const std::string& UserGuid(Networking::UserId userId);
  Networking::UserId UserByActor(MpActor* actor);
  void EnsureUserExists(Networking::UserId userId);
  void MarkDeferred(Networking::UserId userId, UserInfo& info);

  // True at most once per second for the user and actor
  bool AllowRefusalReply(Networking::UserId userId, uint32_t actorId);

  // Refusals held back since the last line, nullopt while rate-limited
  std::optional<uint32_t> AllowRefusalLog(Networking::UserId userId,
                                          uint32_t actorId);

private:
  RefusalLimits* FindRefusalLimits(Networking::UserId userId, uint32_t actorId,
                                   std::chrono::steady_clock::time_point now);
};
