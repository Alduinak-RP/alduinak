#include "TempleRespawn.h"
#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <string>

PartOne& GetPartOne();
extern espm::Loader l;

TEST_CASE("DeathState packed is correct if actor was killed", "[Respawn]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  p.Messages().clear();
  ac.Kill();
  REQUIRE(p.Messages().size() == 1);
  nlohmann::json message = p.Messages()[0].j;
  REQUIRE(message["t"] == MsgType::DeathStateContainer);

  nlohmann::json updateProperyMsg = message["tIsDead"];
  nlohmann::json teleportMsg = message["tTeleport"];
  nlohmann::json changeValuesMsg = message["tChangeValues"];

  REQUIRE(updateProperyMsg["t"] == MsgType::UpdateProperty);
  REQUIRE(updateProperyMsg["propName"] == "isDead");
  REQUIRE(updateProperyMsg["dataDump"] == "true");
  REQUIRE(updateProperyMsg["idx"] == ac.GetIdx());
  REQUIRE(teleportMsg.is_null());
  REQUIRE(changeValuesMsg.is_null());

  REQUIRE(ac.IsDead());
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 0.f);
}

TEST_CASE("DeathState packed is correct if actor is respawning", "[Respawn]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  // Fall just outside Whiterun. After bleeding out the player should wake up
  // at the nearest temple, which is the Temple of Kynareth in Whiterun.
  const NiPoint3 deathPos{ 20000.f, 0.f, 0.f };
  ac.SetPos(deathPos);
  ac.SetCellOrWorld(FormDesc::Tamriel());

  const auto& temple = TempleRespawn::GetNearestTemple(deathPos);
  REQUIRE(std::string(temple.name) == "Whiterun");

  ac.Kill();
  p.Messages().clear();
  ac.Respawn();

  // Respawning teleports the player into a temple, which streams in the
  // surrounding cell, so the message count is not fixed. The death-state
  // container is still sent first (before the teleport), and the broadcast
  // "isDead=false" property is found by scanning below.
  REQUIRE(p.Messages().size() >= 2);

  nlohmann::json message = p.Messages()[0].j;
  REQUIRE(message["t"] == MsgType::DeathStateContainer);

  nlohmann::json updateProperyMsg = message["tIsDead"];
  nlohmann::json teleportMsg = message["tTeleport"];
  nlohmann::json changeValuesMsg = message["tChangeValues"];

  REQUIRE(updateProperyMsg["t"] == MsgType::UpdateProperty);
  REQUIRE(updateProperyMsg["propName"] == "isDead");
  REQUIRE(updateProperyMsg["dataDump"] == "false");
  REQUIRE(updateProperyMsg["idx"] == ac.GetIdx());

  REQUIRE(teleportMsg["t"] == MsgType::Teleport);
  REQUIRE(changeValuesMsg["t"] == MsgType::ChangeValues);

  // The player is teleported INSIDE the Whiterun temple (interior cell), not
  // back to where they died and not to an exterior spot.
  REQUIRE(teleportMsg["pos"][0] == temple.destination.pos[0]);
  REQUIRE(teleportMsg["pos"][1] == temple.destination.pos[1]);
  REQUIRE(teleportMsg["pos"][2] == temple.destination.pos[2]);
  REQUIRE(teleportMsg["worldOrCell"] == 0x165a7); // Temple of Kynareth

  REQUIRE(ac.GetPos() == temple.destination.pos);

  REQUIRE(ac.IsDead() == false);
  REQUIRE(ac.GetChangeForm().actorValues.healthPercentage == 1.f);

  // TODO: should probably not sending to ourselves. see also RespawnEvent.cpp

  // The RespawnEvent broadcasts an "isDead=false" property update; teleport
  // streaming means it is no longer at a fixed index, so scan for it.
  bool foundIsDeadBroadcast = false;
  for (auto& msg : p.Messages()) {
    nlohmann::json j = msg.j; // copy: operator[] auto-inserts null for absentees
    if (j["propName"] == "isDead" && j["dataDump"] == "false" &&
        j["refrId"] == ac.GetFormId()) {
      foundIsDeadBroadcast = true;
      REQUIRE(j["t"] == MsgType::UpdateProperty);
      REQUIRE(j["idx"] == ac.GetIdx());
      REQUIRE(j["baseRecordType"] == nlohmann::json{});
      break;
    }
  }
  REQUIRE(foundIsDeadBroadcast);
}

TEST_CASE("A gamemode-set spawn point wins over the temple fallback",
          "[Respawn]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  // The gamemode owns respawn routing: once it sets a spawn point (as the
  // roleplay gamemode does on every death), the engine must respawn there and
  // NOT override it with the built-in temple table. This is what keeps
  // gamemode coordinate updates from requiring a native rebuild.
  const LocationalData gamemodeChosen{ { 100.f, 200.f, 300.f },
                                       { 0.f, 0.f, 90.f },
                                       FormDesc::Tamriel() };
  ac.SetSpawnPoint(gamemodeChosen);

  ac.SetPos({ 20000.f, 0.f, 0.f }); // near Whiterun; fallback would say temple
  ac.SetCellOrWorld(FormDesc::Tamriel());

  ac.Kill();
  ac.Respawn();

  REQUIRE(ac.IsDead() == false);
  REQUIRE(ac.GetPos() == gamemodeChosen.pos);
}

TEST_CASE("GetRespawnPosition prefers a gamemode-set spawn point over the "
          "nearest-temple fallback",
          "[Respawn]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  const NiPoint3 deathPos{ 20000.f, 0.f, 0.f }; // near the Whiterun anchor
  ac.SetPos(deathPos);
  ac.SetCellOrWorld(FormDesc::Tamriel());

  // Spawn point never set by the gamemode: the sentinel branch routes the
  // player to the nearest temple.
  REQUIRE(ac.GetRespawnPosition() ==
          TempleRespawn::GetNearestTemple(deathPos).destination);

  // respawn.ts sets a spawn point on every death; once set, it must always
  // win over the native table, even standing right next to a temple anchor.
  const LocationalData gamemodeChosen{ { 100.f, 200.f, 300.f },
                                       { 0.f, 0.f, 90.f },
                                       FormDesc::Tamriel() };
  ac.SetSpawnPoint(gamemodeChosen);
  REQUIRE(ac.GetRespawnPosition() == gamemodeChosen);
}

TEST_CASE("Nearest temple routing covers every hold", "[Respawn]")
{
  using namespace TempleRespawn;

  // Every anchor resolves to itself: the table has no two anchors that
  // collide.
  for (const auto& temple : GetTemples()) {
    REQUIRE(std::string(GetNearestTemple(temple.anchor).name) == temple.name);
  }

  const NiPoint3 windhelmInterior(0.f, -2800.f, 64.35f);
  const NiPoint3 solitudeInterior(1676.93f, 1571.19f, 0.f);
  const NiPoint3 whiterunInterior(223.24f, 248.85f, 54.f);
  const NiPoint3 riftenInterior(-1414.34f, 208.64f, 64.f);

  // Temple-less holds route to a neighbouring temple per the design:
  //   Winterhold & Dawnstar -> Windhelm, Morthal -> Solitude.
  REQUIRE(GetNearestTemple(NiPoint3(26328.f, 101092.f, 0.f)).destination.pos ==
          windhelmInterior);
  REQUIRE(GetNearestTemple(NiPoint3(114050.f, 94006.f, 0.f)).destination.pos ==
          windhelmInterior);
  REQUIRE(GetNearestTemple(NiPoint3(-39547.f, 70770.f, 0.f)).destination.pos ==
          solitudeInterior);

  // A death out in a temple hold resolves to that hold's own temple.
  REQUIRE(std::string(GetNearestTemple(NiPoint3(20000.f, 0.f, 0.f)).name) ==
          "Whiterun");
  REQUIRE(std::string(
            GetNearestTemple(NiPoint3(170000.f, -90000.f, 0.f)).name) ==
          "Riften");
  REQUIRE(std::string(
            GetNearestTemple(NiPoint3(-170000.f, 4000.f, 0.f)).name) ==
          "Markarth");

  // Settlement anchors keep villages routed to their hold's temple.
  REQUIRE(GetNearestTemple(NiPoint3(19233.f, -46721.f, 0.f)).destination.pos ==
          whiterunInterior); // Riverwood
  REQUIRE(GetNearestTemple(NiPoint3(78291.f, -67062.f, 0.f)).destination.pos ==
          riftenInterior); // Ivarstead
  REQUIRE(
    GetNearestTemple(NiPoint3(-100811.f, 80907.f, 0.f)).destination.pos ==
    solitudeInterior); // Dragon's Bridge
  REQUIRE(
    GetNearestTemple(NiPoint3(-78931.f, 2789.f, 0.f)).destination.pos ==
    whiterunInterior); // Rorikstead

  // High Hrothgar: a death on the Seven Thousand Steps resolves to its own
  // anchor and wakes the player in Whiterun's temple, matching the
  // gamemode's ANCHORS table.
  REQUIRE(
    std::string(GetNearestTemple(NiPoint3(56897.f, -31974.f, 0.f)).name) ==
    "High Hrothgar");
  REQUIRE(GetNearestTemple(NiPoint3(56897.f, -31974.f, 0.f)).destination.pos ==
          whiterunInterior);
}

TEST_CASE("Deaths outside Tamriel route by worldspace override, not X/Y",
          "[Respawn]")
{
  using namespace TempleRespawn;

  // X/Y from another worldspace is meaningless against Tamriel anchors, so
  // the override must win even when the raw coordinates sit exactly on some
  // other anchor (here, Riften's).
  const NiPoint3 riftenAnchor(174274.64f, -91459.67f, 0.f);
  REQUIRE(std::string(GetNearestTemple(riftenAnchor).name) == "Riften");

  // Solstheim connects to Skyrim by the Windhelm boat.
  const auto& solstheim =
    GetNearestTemple(riftenAnchor, FormDesc::FromString("800:Dragonborn.esm"));
  REQUIRE(std::string(solstheim.name) == "Windhelm");
  REQUIRE(solstheim.destination.pos == NiPoint3(0.f, -2800.f, 64.35f));

  // The Dragonborn.esm override is file-wide: any of its cells/worldspaces
  // (Apocrypha etc.) routes the same way.
  REQUIRE(
    std::string(GetNearestTemple(riftenAnchor,
                                 FormDesc::FromString("12345:Dragonborn.esm"))
                  .name) == "Windhelm");

  // Forgotten Vale -> Markarth (Darkfall Cave in the Reach).
  REQUIRE(
    std::string(
      GetNearestTemple(riftenAnchor, FormDesc::FromString("bb5:Dawnguard.esm"))
        .name) == "Markarth");

  // Soul Cairn -> Solitude (Castle Volkihar).
  REQUIRE(
    std::string(GetNearestTemple(riftenAnchor,
                                 FormDesc::FromString("1408:Dawnguard.esm"))
                  .name) == "Solitude");

  // Tamriel itself is never overridden: nearest-anchor routing still runs.
  REQUIRE(
    std::string(GetNearestTemple(riftenAnchor, FormDesc::Tamriel()).name) ==
    "Riften");
}

TEST_CASE("A healed player gets up where they fell, not at a temple",
          "[Respawn]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  const NiPoint3 deathPos{ 20000.f, 0.f, 0.f };
  ac.SetPos(deathPos);
  ac.SetCellOrWorld(FormDesc::Tamriel());

  ac.Kill();
  REQUIRE(ac.IsDead());

  // Being healed clears the death state early (shouldTeleport == false). The
  // player stands back up in place and is not whisked off to a temple.
  ac.SetIsDead(false);

  REQUIRE(ac.IsDead() == false);
  REQUIRE(ac.GetPos() == deathPos);
}
