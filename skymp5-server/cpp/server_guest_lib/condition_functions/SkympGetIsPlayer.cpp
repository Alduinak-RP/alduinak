#include "SkympGetIsPlayer.h"
#include "MpActor.h"
#include <limits>

const char* ConditionFunctions::SkympGetIsPlayer::GetName() const
{
  return "SkympGetIsPlayer";
}

uint16_t ConditionFunctions::SkympGetIsPlayer::GetFunctionIndex() const
{
  return std::numeric_limits<uint16_t>::max();
}

// 1 for an actor a user plays, 0 for NPCs; parameters are unused
float ConditionFunctions::SkympGetIsPlayer::Execute(
  MpActor& actor, [[maybe_unused]] uint32_t parameter1,
  [[maybe_unused]] uint32_t parameter2, const ConditionEvaluatorContext&)
{
  return actor.GetProfileId() >= 0 ? 1.f : 0.f;
}
