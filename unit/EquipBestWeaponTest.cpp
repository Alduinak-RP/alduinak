#include "TestUtils.hpp"

PartOne& GetPartOne();

namespace {
constexpr uint32_t kPlayerId = 0xff000000;
constexpr uint32_t kNpcId = 0xff000001;
constexpr uint32_t kIronSword = 0x12eb7;

bool EquipmentSent(PartOne& partOne)
{
  const auto& messages = partOne.Messages();
  return std::any_of(messages.begin(), messages.end(), [](const auto& m) {
    return m.j["t"] == MsgType::UpdateEquipment;
  });
}
}

TEST_CASE("A new host's weapon pick resends nothing when the NPC already "
          "wears it",
          "[Hosting]")
{
  PartOne& p = GetPartOne();
  p.CreateActor(kNpcId, { 0, 0, 0 }, 0, 0x3c);
  DoConnect(p, 0);
  p.CreateActor(kPlayerId, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kPlayerId);

  auto& npc = p.worldState.GetFormAt<MpActor>(kNpcId);
  npc.RemoveAllItems();
  npc.AddItem(kIronSword, 1);
  Equipment unarmed;
  unarmed.numChanges = 1;
  npc.SetEquipment(unarmed);

  p.Messages().clear();
  npc.EquipBestWeapon();
  const uint32_t numChanges = npc.GetEquipment().numChanges;
  REQUIRE(npc.GetEquipment().inv.CountWorn() == 1);
  REQUIRE(EquipmentSent(p));

  p.Messages().clear();
  npc.EquipBestWeapon();
  REQUIRE(npc.GetEquipment().numChanges == numChanges);
  REQUIRE(!EquipmentSent(p));
}
