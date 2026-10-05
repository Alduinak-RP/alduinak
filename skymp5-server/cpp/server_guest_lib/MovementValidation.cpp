#include "MovementValidation.h"
#include "FormDesc.h"
#include "MpActor.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include "TeleportMessage2.h"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <string>

namespace {
// A player's report covers at most movementSpeed.max over the time since its last accepted one; false only while enforced
bool IsSpeedAllowed(PartOne& partOne, const NiPoint3& currentPos,
                    const NiPoint3& newPos, Networking::UserId userId,
                    MpActor& actor)
{
  // About one report period of a client sending at 7.5 Hz
  constexpr float kMinSeconds = 0.13f;
  constexpr float kSlack = 256.f;

  const auto& bound = partOne.worldState.movementSpeed;
  const auto last = partOne.worldState.GetLastMovUpdate(actor.GetIdx());
  if (!last) {
    return true;
  }

  const float seconds = std::max(
    std::chrono::duration<float>(std::chrono::system_clock::now() - *last)
      .count(),
    kMinSeconds);
  const float maxDistance = bound.max * seconds + kSlack;
  const float dx = newPos.x - currentPos.x;
  const float dy = newPos.y - currentPos.y;
  const float sqrDistance = dx * dx + dy * dy;
  if (sqrDistance <= maxDistance * maxDistance) {
    return true;
  }

  if (auto held = partOne.serverState.AllowAuthorityLog(
        userId, AuthorityCheck::MovementSpeed)) {
    spdlog::warn("MovementValidation - {:x} moved {} units in {} s, over the "
                 "{} units maxMovementSpeed allows, {} ({} more since the "
                 "last line)",
                 actor.GetFormId(), std::sqrt(sqrDistance), seconds,
                 maxDistance,
                 bound.enforce ? "refused" : "logged only", *held);
  }
  return !bound.enforce;
}
}

namespace MovementValidation {

bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, uint32_t currentCellOrWorld,
              const NiPoint3& newPos, uint32_t newCellOrWorld,
              Networking::UserId userId, MpActor* actor)
{
  constexpr float kSqrMaxDistance = 4096.f * 4096.f;

  PartOneSendTargetWrapper& sendTarget = partOne.GetSendTarget();

  // Not doing this to any NPCs at this moment, yet we might consider to
  const bool isMe = actor && partOne.serverState.ActorByUser(userId) == actor;

  if (currentCellOrWorld == newCellOrWorld &&
      (currentPos - newPos).SqrLength() < kSqrMaxDistance &&
      (!isMe || IsSpeedAllowed(partOne, currentPos, newPos, userId, *actor))) {
    return true;
  }

  if (isMe &&
      partOne.serverState.AllowRefusalReply(userId, actor->GetFormId())) {
    TeleportMessage2 msg;
    msg.pos = { currentPos[0], currentPos[1], currentPos[2] };
    msg.rot = { currentRot[0], currentRot[1], currentRot[2] };
    msg.worldOrCell = currentCellOrWorld;
    sendTarget.Send(userId, msg, true);
  }
  return false;
}

} // namespace MovementValidation
