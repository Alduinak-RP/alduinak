#include "MovementValidation.h"
#include "FormDesc.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include "TeleportMessage2.h"
#include <nlohmann/json.hpp>
#include <string>

namespace MovementValidation {

bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, uint32_t currentCellOrWorld,
              const NiPoint3& newPos, uint32_t newCellOrWorld,
              Networking::UserId userId, MpActor* actor)
{
  constexpr float kSqrMaxDistance = 4096.f * 4096.f;

  PartOneSendTargetWrapper& sendTarget = partOne.GetSendTarget();

  if (currentCellOrWorld != newCellOrWorld ||
      (currentPos - newPos).SqrLength() >= kSqrMaxDistance) {

    // Not doing this to any NPCs at this moment, yet we might consider to
    bool isMe = actor && partOne.serverState.ActorByUser(userId) == actor;
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
  return true;
}

} // namespace MovementValidation
