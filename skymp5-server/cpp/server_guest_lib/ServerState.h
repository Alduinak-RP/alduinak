#pragma once
#include "ActorsMap.h"
#include "Config.h"
#include <Networking.h>
#include <array>
#include <chrono>
#include <map>
#include <memory>
#include <optional>
#include <simdjson.h>
#include <unordered_map>

class MpActor;

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

// Checks whose failures are logged, and refused only while the server settings enforce them
enum class AuthorityCheck
{
  MovementSpeed,
  Count
};

struct UserInfo
{
  bool isDisconnecting = false;

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

  std::array<RateLimit, static_cast<size_t>(AuthorityCheck::Count)>
    authorityLogs;
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

  // Failures held back since the last line, nullopt while rate-limited
  std::optional<uint32_t> AllowAuthorityLog(Networking::UserId userId,
                                            AuthorityCheck check);

private:
  RefusalLimits* FindRefusalLimits(Networking::UserId userId, uint32_t actorId,
                                   std::chrono::steady_clock::time_point now);
};
