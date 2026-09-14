#include "TestUtils.hpp"
#include <chrono>

using namespace std::chrono_literals;

namespace {
constexpr uint32_t kActorId = 0xff000abc;
constexpr uint32_t kIronHelmet = 0x12e4d;

const auto kNakedReport = [] {
  auto j = jEquipment;
  j["data"]["numChanges"] = 1;
  return j;
}();

// A character whose saved outfit wears one item, just assigned to user 0
MpActor& SpawnDressed(PartOne& partOne, bool itemInInventory,
                      ProfileId profileId = 1)
{
  DoConnect(partOne, 0);
  partOne.CreateActor(kActorId, { 1.f, 2.f, 3.f }, 180.f, 0x3c, profileId);
  auto& actor = partOne.worldState.GetFormAt<MpActor>(kActorId);
  if (itemInInventory) {
    actor.AddItem(kIronHelmet, 1);
  }
  Equipment eq;
  eq.numChanges = 5;
  Inventory::Entry entry(kIronHelmet, 1);
  entry.SetWorn(Inventory::Worn::Right);
  eq.inv.entries.push_back(entry);
  actor.SetEquipment(eq);
  partOne.SetUserActor(0, kActorId);
  partOne.Messages().clear();
  return actor;
}

void EndSpawnGrace(PartOne& partOne)
{
  partOne.serverState.userInfo[0]->firstEquipmentReportAt =
    std::chrono::steady_clock::now() - 11s;
}

bool EquipmentSent(PartOne& partOne)
{
  const auto& messages = partOne.Messages();
  return std::any_of(messages.begin(), messages.end(), [](const auto& m) {
    return m.j["t"] == MsgType::UpdateEquipment;
  });
}
}

TEST_CASE("A naked report right after spawn keeps the saved outfit",
          "[SpawnEquipment]")
{
  PartOne partOne;
  auto& actor = SpawnDressed(partOne, true);

  DoMessage(partOne, 0, kNakedReport);

  REQUIRE(actor.GetEquipment().inv.CountWorn() == 1);
  REQUIRE(actor.GetEquipment().numChanges == 5);
  REQUIRE(!EquipmentSent(partOne));
}

TEST_CASE("A naked report after the spawn grace is accepted",
          "[SpawnEquipment]")
{
  PartOne partOne;
  auto& actor = SpawnDressed(partOne, true);
  EndSpawnGrace(partOne);

  DoMessage(partOne, 0, kNakedReport);

  REQUIRE(actor.GetEquipment().inv.CountWorn() == 0);
  REQUIRE(EquipmentSent(partOne));
}

TEST_CASE("A new assign opens the spawn grace again", "[SpawnEquipment]")
{
  PartOne partOne;
  auto& actor = SpawnDressed(partOne, true);
  EndSpawnGrace(partOne);
  partOne.SetUserActor(0, kActorId);

  DoMessage(partOne, 0, kNakedReport);

  REQUIRE(actor.GetEquipment().inv.CountWorn() == 1);
}

TEST_CASE("A naked report is accepted when the saved outfit left the "
          "inventory",
          "[SpawnEquipment]")
{
  PartOne partOne;
  auto& actor = SpawnDressed(partOne, false);

  DoMessage(partOne, 0, kNakedReport);

  REQUIRE(actor.GetEquipment().inv.CountWorn() == 0);
  REQUIRE(EquipmentSent(partOne));
}

TEST_CASE("A naked report of an actor without a profile is accepted",
          "[SpawnEquipment]")
{
  PartOne partOne;
  auto& actor = SpawnDressed(partOne, true, -1);

  DoMessage(partOne, 0, kNakedReport);

  REQUIRE(actor.GetEquipment().inv.CountWorn() == 0);
}
