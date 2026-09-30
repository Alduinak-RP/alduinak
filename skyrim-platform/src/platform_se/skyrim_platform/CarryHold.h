#pragma once

#include <cstdint>
#include <optional>

// Holds a carried actor on its carrier at the start of every frame, on the main thread, with the engine's own warp
namespace CarryHold {
void Install();

// What a hold measured; drift is how far the body got from its place during the frame before each write
struct Stats
{
  uint32_t frames = 0;
  uint32_t skipped = 0;
  uint32_t snaps = 0;
  double driftSum = 0;
  float maxDrift = 0;
  float worstSecond = 0;
  float maxYawDrift = 0;
};

// Refreshed by the client every frame; false when the hook is missing, so the client holds the body itself
bool Set(RE::FormID held, RE::FormID carrier, float forward, float up,
         float yawDegrees);

std::optional<Stats> Clear(RE::FormID held);
}
