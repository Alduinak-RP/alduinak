#pragma once
#include "FormDesc.h"
#include "NiPoint3.h"
#include "PartOne.h"
#include <cstdint>
#include <string>
#include <vector>

class MpActor;

namespace MovementValidation {
// Cells are form ids, so a bad file index from a client is a mismatch
bool Validate(PartOne& partOne, const NiPoint3& currentPos,
              const NiPoint3& currentRot, uint32_t currentCellOrWorld,
              const NiPoint3& newPos, uint32_t newCellOrWorld,
              Networking::UserId userId, MpActor* actor);
}
