#include "ServerState.h"

#include <algorithm>
#include <utility>

#include <spdlog/spdlog.h>

#include "MpActor.h"

void ServerState::Connect(Networking::UserId userId, const std::string& guid)
{
  if (userInfo[userId] != nullptr) {
    spdlog::error("ServerState::Connect: overwritten userInfo for userId={}, "
                  "old guid: {}, new guid: {}",
                  userId, userInfo[userId]->guid, guid);
  }

  userInfo[userId] = std::make_unique<UserInfo>();
  userInfo[userId]->guid = guid;

  spdlog::info("ServerState::Connect: assigning guid for userId={}: guid={}",
               userId, guid);

  if (maxConnectedId < userId) {
    maxConnectedId = userId;
  }
}

void ServerState::Disconnect(Networking::UserId userId) noexcept
{
  userInfo[userId].reset();

  if (maxConnectedId == userId) {
    auto it =
      std::find_if(userInfo.rbegin(), userInfo.rend(),
                   [](const std::unique_ptr<UserInfo>& v) { return !!v; });
    if (it != userInfo.rend()) {
      maxConnectedId = &*it - &userInfo[0];
    } else {
      maxConnectedId = 0;
    }
  }

  actorsMap.Erase(userId);
}

bool ServerState::IsConnected(Networking::UserId userId) const
{
  return userId < std::size(userInfo) && userInfo[userId];
}

MpActor* ServerState::ActorByUser(Networking::UserId userId)
{
  return actorsMap.Find(userId);
}

const std::string& ServerState::UserGuid(Networking::UserId userId)
{
  static const std::string kEmptyString;

  if (userInfo.size() <= userId || !userInfo[userId]) {
    return kEmptyString;
  }

  return userInfo[userId]->guid;
}

Networking::UserId ServerState::UserByActor(MpActor* actor)
{
  return actorsMap.Find(actor);
}

void ServerState::MarkDeferred(Networking::UserId userId, UserInfo& info)
{
  if (!info.hasDeferred) {
    info.hasDeferred = true;
    deferredUsers.push_back(userId);
  }
}

bool RateLimit::Allow(std::chrono::steady_clock::time_point now,
                      std::chrono::steady_clock::duration period)
{
  if (lastAt != std::chrono::steady_clock::time_point{} &&
      now - lastAt < period) {
    ++held;
    return false;
  }
  lastAt = now;
  return true;
}

RefusalLimits* ServerState::FindRefusalLimits(
  Networking::UserId userId, uint32_t actorId,
  std::chrono::steady_clock::time_point now)
{
  constexpr size_t kMaxRefusals = 256;

  if (!IsConnected(userId)) {
    return nullptr;
  }
  auto& refusals = userInfo[userId]->refusals;
  if (refusals.size() >= kMaxRefusals) {
    std::erase_if(refusals, [&](const auto& entry) {
      return now - entry.second.log.lastAt >= RefusalLimits::kLogPeriod &&
        now - entry.second.reply.lastAt >= RefusalLimits::kReplyPeriod;
    });
  }
  return &refusals[actorId];
}

bool ServerState::AllowRefusalReply(Networking::UserId userId,
                                    uint32_t actorId)
{
  const auto now = std::chrono::steady_clock::now();
  auto limits = FindRefusalLimits(userId, actorId, now);
  return !limits || limits->reply.Allow(now, RefusalLimits::kReplyPeriod);
}

std::optional<uint32_t> ServerState::AllowRefusalLog(Networking::UserId userId,
                                                     uint32_t actorId)
{
  const auto now = std::chrono::steady_clock::now();
  auto limits = FindRefusalLimits(userId, actorId, now);
  if (!limits) {
    return 0;
  }
  if (!limits->log.Allow(now, RefusalLimits::kLogPeriod)) {
    return std::nullopt;
  }
  return std::exchange(limits->log.held, 0);
}

std::optional<uint32_t> ServerState::AllowAuthorityLog(
  Networking::UserId userId, AuthorityCheck check)
{
  if (!IsConnected(userId)) {
    return 0;
  }
  auto& limit = userInfo[userId]->authorityLogs[static_cast<size_t>(check)];
  if (!limit.Allow(std::chrono::steady_clock::now(),
                   RefusalLimits::kLogPeriod)) {
    return std::nullopt;
  }
  return std::exchange(limit.held, 0);
}

void ServerState::EnsureUserExists(Networking::UserId userId)
{
  if (userInfo.size() <= userId || !userInfo[userId]) {
    throw std::runtime_error("User with id " + std::to_string(userId) +
                             " doesn't exist");
  }
}
