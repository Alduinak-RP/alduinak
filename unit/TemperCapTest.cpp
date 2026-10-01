#include <catch2/catch_all.hpp>

#include "TemperCap.h"
#include <map>

namespace {
auto RanksOf(std::map<std::string, int> ranks)
{
  return [ranks](const std::string& profession) {
    auto it = ranks.find(profession);
    return it == ranks.end() ? 0 : it->second;
  };
}

const std::vector<std::string> kBench = { "Blacksmith", "Woodworker",
                                          "Tailor" };
}

TEST_CASE("Rank marker editor ids split into profession and rank",
          "[TemperCap]")
{
  auto marker = TemperCap::ParseMarkerEditorId("AldProf_Blacksmith_Master");
  REQUIRE(marker);
  REQUIRE(marker->profession == "Blacksmith");
  REQUIRE(marker->rank == 4);

  marker = TemperCap::ParseMarkerEditorId("AldProf_Wood_Worker_Novice");
  REQUIRE(marker);
  REQUIRE(marker->profession == "Wood_Worker");
  REQUIRE(marker->rank == 1);

  REQUIRE(TemperCap::ParseMarkerEditorId("AldProf_Tailor_Legendary")->rank ==
          5);
  REQUIRE(!TemperCap::ParseMarkerEditorId("AldProf__Adept"));
  REQUIRE(!TemperCap::ParseMarkerEditorId("AldProf_Tailor"));
  REQUIRE(!TemperCap::ParseMarkerEditorId("AldFaction_Whiterun_Novice"));
  REQUIRE(!TemperCap::ParseMarkerEditorId(""));
}

TEST_CASE("A gated temper recipe caps at the rank of its own profession",
          "[TemperCap]")
{
  const auto ranks = RanksOf({ { "Blacksmith", 4 }, { "Tailor", 1 } });

  // A Master Blacksmith with a Novice Tailor tertiary on a tailor's piece
  auto cap = TemperCap::Resolve({ { "Tailor", true } }, kBench, ranks);
  REQUIRE(cap.rank == 1);
  REQUIRE(cap.profession == "Tailor");
  REQUIRE_THAT(TemperCap::HealthOfRank(cap.rank),
               Catch::Matchers::WithinAbs(1.2, 0.0001));

  cap = TemperCap::Resolve({ { "Blacksmith", true } }, kBench, ranks);
  REQUIRE(cap.rank == 4);
  REQUIRE(cap.profession == "Blacksmith");
  REQUIRE_THAT(TemperCap::HealthOfRank(cap.rank),
               Catch::Matchers::WithinAbs(1.5, 0.0001));
}

TEST_CASE("Only a held gate of a shared recipe sets the cap", "[TemperCap]")
{
  const auto ranks = RanksOf({ { "Blacksmith", 3 }, { "Tailor", 1 } });

  auto cap = TemperCap::Resolve(
    { { "Blacksmith", false }, { "Tailor", true } }, kBench, ranks);
  REQUIRE(cap.rank == 1);
  REQUIRE(cap.profession == "Tailor");

  cap = TemperCap::Resolve({ { "Blacksmith", true }, { "Tailor", true } },
                           kBench, ranks);
  REQUIRE(cap.rank == 3);
  REQUIRE(cap.profession == "Blacksmith");

  cap = TemperCap::Resolve({ { "Tailor", false } }, kBench, ranks);
  REQUIRE(cap.rank == 0);
  REQUIRE(cap.profession == "Tailor");
}

TEST_CASE("An ungated temper recipe caps at the best rank among its bench's "
          "professions",
          "[TemperCap]")
{
  auto cap = TemperCap::Resolve(
    {}, kBench, RanksOf({ { "Blacksmith", 2 }, { "Tailor", 5 } }));
  REQUIRE(cap.rank == 5);
  REQUIRE(cap.profession == "Tailor");

  cap = TemperCap::Resolve({}, kBench, RanksOf({ { "Hunter", 5 } }));
  REQUIRE(cap.rank == 0);
  REQUIRE(cap.profession.empty());
  REQUIRE_THAT(TemperCap::HealthOfRank(cap.rank),
               Catch::Matchers::WithinAbs(1.1, 0.0001));

  cap = TemperCap::Resolve({}, {}, RanksOf({ { "Blacksmith", 5 } }));
  REQUIRE(cap.rank == 0);
}

TEST_CASE("One profession caps as before", "[TemperCap]")
{
  for (int rank = 1; rank <= 5; ++rank) {
    const auto ranks = RanksOf({ { "Blacksmith", rank } });
    REQUIRE(TemperCap::Resolve({ { "Blacksmith", true } }, kBench, ranks)
              .rank == rank);
    REQUIRE(TemperCap::Resolve({}, kBench, ranks).rank == rank);
    REQUIRE(TemperCap::HealthOfRank(rank) ==
            1.1f + 0.1f * static_cast<float>(rank));
  }
}
