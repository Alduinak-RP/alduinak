#pragma once

#include "FormDesc.h"
#include "LocationalData.h"
#include "NiPoint3.h"

#include <vector>

// Roleplay respawn: "wake up at the nearest temple".
namespace TempleRespawn {

struct Temple
{
  // Human-readable hold/temple name (used for debugging and unit tests).
  const char* name;

  // Tamriel-worldspace position used to measure "nearest" (X/Y only).
  NiPoint3 anchor;

  // Where the player wakes up.
  LocationalData destination;
};

// Routing table: one entry per hold.
const std::vector<Temple>& GetTemples();

// Returns the temple whose anchor is closest (2D Tamriel X/Y distance) to
// fromPos. Deaths outside the Tamriel worldspace (Solstheim/Apocrypha, the
// Forgotten Vale, the Soul Cairn) are instead routed by fixed worldspace
// overrides: their coordinates live in a different space and can't be
// compared with Tamriel anchors. Keep in sync with pickTemple in the
// gamemode's respawn.ts. Throws if the routing table is somehow empty.
const Temple& GetNearestTemple(
  const NiPoint3& fromPos,
  const FormDesc& fromCellOrWorld = FormDesc::Tamriel());

}
