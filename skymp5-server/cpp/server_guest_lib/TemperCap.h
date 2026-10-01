#pragma once
#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace TemperCap {

inline constexpr const char* kMarkerPrefix = "AldProf_";

inline constexpr const char* kRankNames[] = { "Free",   "Novice", "Adept",
                                              "Expert", "Master", "Legendary" };

struct Marker
{
  std::string profession;
  int rank = 0;
};

// AldProf_<Label>_<Rank> split into its label and rank, Novice 1 to Legendary 5
inline std::optional<Marker> ParseMarkerEditorId(const std::string& edid)
{
  const std::string prefix = kMarkerPrefix;
  if (edid.rfind(prefix, 0) != 0) {
    return std::nullopt;
  }
  for (int rank = 1; rank <= 5; ++rank) {
    const std::string suffix = std::string("_") + kRankNames[rank];
    if (edid.size() > prefix.size() + suffix.size() &&
        edid.compare(edid.size() - suffix.size(), suffix.size(), suffix) ==
          0) {
      return Marker{ edid.substr(prefix.size(),
                                 edid.size() - prefix.size() - suffix.size()),
                     rank };
    }
  }
  return std::nullopt;
}

// A rank marker a recipe asks for and whether the character holds it
struct Gate
{
  std::string profession;
  bool held = false;
};

struct Cap
{
  int rank = 0;
  // Empty when no profession sets the cap
  std::string profession;
};

// A gated recipe caps at the rank in a profession whose gate is held, an ungated one at the best rank among its bench's professions
inline Cap Resolve(const std::vector<Gate>& gates,
                   const std::vector<std::string>& benchProfessions,
                   const std::function<int(const std::string&)>& rankOf)
{
  Cap cap;
  const auto consider = [&](const std::string& profession) {
    const int rank = rankOf(profession);
    if (cap.profession.empty() || rank > cap.rank) {
      cap = { rank, profession };
    }
  };
  if (gates.empty()) {
    for (const auto& profession : benchProfessions) {
      if (rankOf(profession) > 0) {
        consider(profession);
      }
    }
    return cap;
  }
  for (const auto& gate : gates) {
    if (gate.held) {
      consider(gate.profession);
    }
  }
  if (cap.profession.empty()) {
    cap.profession = gates.front().profession;
  }
  return cap;
}

// Free Fine 1.1 up to Legendary 1.6, the engine's quality steps
inline float HealthOfRank(int rank)
{
  return 1.1f + 0.1f * static_cast<float>(rank);
}

inline const char* RankName(int rank)
{
  return rank >= 0 && rank <= 5 ? kRankNames[rank] : "?";
}

}
