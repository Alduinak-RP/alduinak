#pragma once
#include "papyrus-vm/CIString.h"
#include <functional>

class MpActor;
class WorldState;
struct AnimationData;

class AnimationSystem
{
public:
  AnimationSystem();
  void Init(WorldState* worldState);
  void Process(MpActor* actor, const AnimationData& animData);

private:
  using AnimationCallback = std::function<void(MpActor*)>;
  using AnimationCallbacks = CIMap<AnimationCallback>;

  AnimationCallbacks animationCallbacks;
  WorldState* worldState = nullptr;
};
