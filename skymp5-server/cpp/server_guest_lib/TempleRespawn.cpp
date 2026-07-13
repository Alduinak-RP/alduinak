#include "TempleRespawn.h"

#include "FormDesc.h"

#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>

namespace {

LocationalData MakeInteriorDestination(const char* cellDesc, float x, float y,
                                       float z, float rotZ)
{
  // Temple interiors: the cell (and spot) the temple's front door leads to.
  // Coordinates are measured in-game, not derived from the ESM, so the player
  // wakes on standable ground inside the temple.
  return LocationalData{ NiPoint3(x, y, z), NiPoint3(0.f, 0.f, rotZ),
                         FormDesc::FromString(cellDesc) };
}

struct WorldspaceOverride
{
  // The death cell/world this override matches: an exact form, or (when
  // matchWholeFile is set) any cell/worldspace from match.file.
  FormDesc match;
  bool matchWholeFile;

  // Name of the GetTemples() entry the death routes to.
  const char* templeName;
};

// Deaths outside the Tamriel worldspace can't use X/Y distance (coordinates
// are in a different space). Route them by where their region connects back
// to Skyrim: Solstheim/Apocrypha -> Windhelm (the boat), Forgotten Vale ->
// Markarth (Darkfall Cave in the Reach), Soul Cairn -> Solitude (Volkihar).
// Keep in sync with WORLDSPACE_OVERRIDES in the gamemode's respawn.ts.
const std::vector<WorldspaceOverride>& GetWorldspaceOverrides()
{
  static const std::vector<WorldspaceOverride> kOverrides{
    { FormDesc(0, "Dragonborn.esm"), true, "Windhelm" },
    { FormDesc::FromString("bb5:Dawnguard.esm"), false, "Markarth" },
    { FormDesc::FromString("1408:Dawnguard.esm"), false, "Solitude" },
  };
  return kOverrides;
}

const TempleRespawn::Temple& FindTempleByName(const char* name)
{
  for (const auto& temple : TempleRespawn::GetTemples()) {
    if (std::strcmp(temple.name, name) == 0) {
      return temple;
    }
  }
  throw std::runtime_error(std::string("TempleRespawn - no temple named ") +
                           name);
}

}

const std::vector<TempleRespawn::Temple>& TempleRespawn::GetTemples()
{
  static const std::vector<Temple> kTemples = [] {
    const LocationalData solitude = MakeInteriorDestination(
      "16a02:Skyrim.esm", 1676.93f, 1571.19f, 0.f, 15.75f);
    const LocationalData markarth = MakeInteriorDestination(
      "16df3:Skyrim.esm", -1870.36f, 356.02f, 156.24f, 279.5f);
    const LocationalData falkreath = MakeInteriorDestination(
      "13a71:Skyrim.esm", -1728.f, -391.f, 0.f, 180.f); // Hall of the Dead
    const LocationalData whiterun = MakeInteriorDestination(
      "165a7:Skyrim.esm", 223.24f, 248.85f, 54.f, 0.f);
    const LocationalData windhelm = MakeInteriorDestination(
      "16785:Skyrim.esm", 0.f, -2800.f, 64.35f, 0.f);
    const LocationalData riften = MakeInteriorDestination(
      "16bd7:Skyrim.esm", -1414.34f, 208.64f, 64.f, 15.75f);

    return std::vector<Temple>{
      // Hold capitals: anchors are measured Tamriel-worldspace positions at
      // each city, routing to that city's temple interior.
      { "Solitude", NiPoint3(-68173.96f, 103311.75f, 0.f), solitude },
      { "Markarth", NiPoint3(-169535.31f, 5386.96f, 0.f), markarth },
      { "Falkreath", NiPoint3(-34020.39f, -89435.80f, 0.f), falkreath },
      { "Whiterun", NiPoint3(16476.68f, -9595.68f, 0.f), whiterun },
      { "Windhelm", NiPoint3(135019.44f, 33731.66f, 0.f), windhelm },
      { "Riften", NiPoint3(174274.64f, -91459.67f, 0.f), riften },

      // Temple-less holds route to a neighbouring hold's temple:
      // Winterhold & Dawnstar -> Windhelm, Morthal -> Solitude.
      { "Winterhold", NiPoint3(114050.01f, 94006.28f, 0.f), windhelm },
      { "Dawnstar", NiPoint3(26328.23f, 101092.58f, 0.f), windhelm },
      { "Morthal", NiPoint3(-39547.51f, 70770.92f, 0.f), solitude },

      // Settlements: anchor on the village so deaths nearby route to their
      // hold's temple instead of whichever capital happens to be closest as
      // the crow flies.
      { "Riverwood", NiPoint3(19233.25f, -46721.73f, 0.f), whiterun },
      { "Rorikstead", NiPoint3(-78931.07f, 2789.23f, 0.f), whiterun },
      { "Ivarstead", NiPoint3(78291.95f, -67062.64f, 0.f), riften },
      { "Dragon's Bridge", NiPoint3(-100811.45f, 80907.16f, 0.f), solitude },
      { "High Hrothgar", NiPoint3(56897.66f, -31974.11f, 0.f), whiterun },
    };
  }();
  return kTemples;
}

const TempleRespawn::Temple& TempleRespawn::GetNearestTemple(
  const NiPoint3& fromPos, const FormDesc& fromCellOrWorld)
{
  // Deaths outside Tamriel are routed by worldspace, not by X/Y distance:
  // coordinates from another space are meaningless against Tamriel anchors.
  for (const auto& entry : GetWorldspaceOverrides()) {
    const bool matches = entry.matchWholeFile
      ? fromCellOrWorld.file == entry.match.file
      : fromCellOrWorld == entry.match;
    if (matches) {
      return FindTempleByName(entry.templeName);
    }
  }

  const auto& temples = GetTemples();
  if (temples.empty()) {
    throw std::runtime_error(
      "TempleRespawn::GetNearestTemple - routing table is empty");
  }

  const Temple* nearest = &temples.front();
  float nearestDistanceSq = std::numeric_limits<float>::max();

  for (const auto& temple : temples) {
    // Horizontal (X/Y) distance only. Z varies wildly between anchors and
    // would distort "nearest" without changing which hold the player is in.
    const float dx = temple.anchor[0] - fromPos[0];
    const float dy = temple.anchor[1] - fromPos[1];
    const float distanceSq = dx * dx + dy * dy;
    if (distanceSq < nearestDistanceSq) {
      nearestDistanceSq = distanceSq;
      nearest = &temple;
    }
  }

  return *nearest;
}
