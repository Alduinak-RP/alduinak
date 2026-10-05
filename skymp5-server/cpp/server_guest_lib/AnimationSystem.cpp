#include "AnimationSystem.h"
#include "AnimationData.h"
#include "MpActor.h"
#include "WorldState.h"
#include "formulas/AlduinakHitRules.h"

AnimationSystem::AnimationSystem()
{
  animationCallbacks = {
    {
      "blockStart",
      [](MpActor* actor) { actor->StartBlock(); },
    },
    {
      "blockStop",
      [](MpActor* actor) { actor->SetIsBlockActive(false); },
    }
  };
}

void AnimationSystem::Init(WorldState* pWorldState)
{
  worldState = pWorldState;
}

void AnimationSystem::Process(MpActor* actor, const AnimationData& animData)
{
  // The rebalance checks a power flag against these starts
  if (worldState && worldState->alduinakDamageFormula &&
      HitRules::IsPowerAttackStart(animData.animEventName)) {
    HitRules::NotePowerEvent(actor->GetCombatState(), HitRules::Clock::now());
  }

  CIString s = animData.animEventName.data();
  auto it = animationCallbacks.find(s);
  if (it == animationCallbacks.end()) {
    return;
  }
  it->second(actor);
}
