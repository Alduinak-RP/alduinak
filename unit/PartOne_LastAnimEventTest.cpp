#include "TestUtils.hpp"

TEST_CASE("SetLastAnimEventAndBroadcast reaches the neighbours and later "
          "spawns, never the actor's own user",
          "[PartOne]")
{
  PartOne partOne;

  DoConnect(partOne, 0);
  partOne.CreateActor(0xff000ABC, { 1.f, 2.f, 3.f }, 180.f, 0x3c);
  partOne.SetUserActor(0, 0xff000ABC);

  DoConnect(partOne, 1);
  partOne.CreateActor(0xffABCABC, { 11.f, 22.f, 33.f }, 180.f, 0x3c);
  partOne.SetUserActor(1, 0xffABCABC);
  partOne.Messages().clear();

  auto& actor = partOne.worldState.GetFormAt<MpActor>(0xff000ABC);
  actor.SetLastAnimEventAndBroadcast("IdleSitCrossLeggedEnter");

  REQUIRE(actor.GetLastAnimEvent().has_value());
  REQUIRE(actor.GetLastAnimEvent()->animEventName ==
          "IdleSitCrossLeggedEnter");
  REQUIRE(actor.GetLastAnimEvent()->numChanges > 0x40000000);

  auto isSit = [&](const PartOne::Message& m) {
    return m.j["t"] == MsgType::UpdateAnimation &&
      m.j["idx"] == actor.GetIdx() &&
      m.j["data"]["animEventName"] == "IdleSitCrossLeggedEnter";
  };
  REQUIRE(std::count_if(partOne.Messages().begin(), partOne.Messages().end(),
                        isSit) == 1);
  REQUIRE(std::find_if(partOne.Messages().begin(), partOne.Messages().end(),
                       [&](const PartOne::Message& m) {
                         return isSit(m) && m.userId == 1 && m.reliable;
                       }) != partOne.Messages().end());

  partOne.Messages().clear();

  DoConnect(partOne, 2);
  partOne.CreateActor(0xffABC000, { 1.f, 2.f, 3.f }, 180.f, 0x3c);
  partOne.SetUserActor(2, 0xffABC000);

  auto res = FindRefrMessage<CreateActorMessage>(partOne, 0xff000ABC);
  REQUIRE(res.filteredMessages.size() == 1);
  REQUIRE(res.filteredMessages[0].animation.has_value());
  REQUIRE(res.filteredMessages[0].animation->animEventName ==
          "IdleSitCrossLeggedEnter");

  actor.SetLastAnimEvent(std::nullopt);
  REQUIRE(!actor.GetLastAnimEvent().has_value());
}
