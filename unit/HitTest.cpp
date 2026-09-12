#include "TestUtils.hpp"
#include <catch2/catch_all.hpp>
#include <chrono>

#include "GetBaseActorValues.h"
#include "HitMessage.h"
#include "PacketParser.h"
#include "libespm/Loader.h"

PartOne& GetPartOne();
extern espm::Loader l;
using namespace std::chrono_literals;

namespace {
const auto kExtraWornTrue = [] {
  Inventory::ExtraData extra;
  extra.worn_ = true;
  return extra;
}();
}

TEST_CASE("OnHit damages target actor based on damage formula", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E; // iron dagger 4 damage, id = 80254
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  auto past = std::chrono::steady_clock::now() - 10s;
  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(p.Messages().size() == 1);
  auto changeForm = ac.GetChangeForm();
  REQUIRE(changeForm.actorValues.healthPercentage == 0.75f);
  REQUIRE(changeForm.actorValues.magickaPercentage == 1.f);
  REQUIRE(changeForm.actorValues.staminaPercentage == 1.f);

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("OnHit function sends ChangeValues message with coorect percentages",
          "[TES5DamageFormula]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);
  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);
  ac.SetEquipment(Equipment());

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E; // iron dagger 4 damage
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  p.Messages().clear();
  auto past = std::chrono::steady_clock::now() - 4s;
  ac.SetLastHitTime(0xff000000, past);
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(p.Messages().size() == 1);
  nlohmann::json message = p.Messages()[0].j;

  REQUIRE(message["data"]["health"] == 0.75f);
  REQUIRE(message["data"]["magicka"] == nlohmann::json{});
  REQUIRE(message["data"]["stamina"] == nlohmann::json{});

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

TEST_CASE("OnHit doesn't damage character if it is out of range", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  RawMessageData rawMsgData;
  rawMsgData.userId = 0;

  const uint32_t aggressor = 0xff000000;
  const uint32_t target = 0xff000001;

  p.CreateActor(aggressor, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, aggressor);
  auto& acAggressor = p.worldState.GetFormAt<MpActor>(aggressor);

  p.CreateActor(target, { 0, 0, 0 }, 0, 0x3c);
  auto& acTarget = p.worldState.GetFormAt<MpActor>(target);

  HitMessage hitMsg;
  hitMsg.data.target = target;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;

  int16_t face =
    espm::GetData<espm::NPC_>(acAggressor.GetBaseId(), &p.worldState)
      .objectBounds.pos2[1];
  int16_t targetSide =
    espm::GetData<espm::NPC_>(acTarget.GetBaseId(), &p.worldState)
      .objectBounds.pos2[1];

  // fCombatDistance global value * reach
  const float awaitedRange = 141.f * 0.7f + face + targetSide;
  acTarget.SetPos({ awaitedRange * 1.001f, 0, 0 });
  acTarget.SetAngle({ 0.f, 0.f, 180.f });
  ActorValues actorValues;
  actorValues.healthPercentage = 0.1f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  acTarget.SetPercentages(actorValues);

  auto past = std::chrono::steady_clock::now() - 2s;
  acTarget.SetLastHitTime(target, past);
  acAggressor.SetLastHitTime(target, past);
  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  auto changeForm = acTarget.GetChangeForm();
  REQUIRE(changeForm.actorValues.healthPercentage == 0.1f);

  p.DestroyActor(aggressor);
  p.DestroyActor(target);
  DoDisconnect(p, 0);
}

TEST_CASE("Dead actors can't attack", "[Hit]")
{
  PartOne& p = GetPartOne();
  RawMessageData rawMsgData;

  const uint32_t aggressor = 0xff000000;
  const uint32_t target = 0xff000001;

  p.CreateActor(aggressor, { 0, 0, 0 }, 0, 0x3c);
  p.CreateActor(target, { 0, 0, 0 }, 0, 0x3c);

  DoConnect(p, 0);
  p.SetUserActor(0, aggressor);
  rawMsgData.userId = 0;

  HitMessage hitMsg;
  hitMsg.data.target = target;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;

  auto& acTarget = p.worldState.GetFormAt<MpActor>(target);
  ActorValues actorValues;
  actorValues.healthPercentage = 0.2f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  acTarget.SetPercentages(actorValues);

  auto& acAggressor = p.worldState.GetFormAt<MpActor>(aggressor);
  acAggressor.Kill();
  REQUIRE(acAggressor.IsDead() == true);

  p.GetActionListener().OnHit(rawMsgData, hitMsg);

  REQUIRE(acTarget.GetChangeForm().actorValues.healthPercentage == 0.2f);

  p.DestroyActor(aggressor);
  p.DestroyActor(target);
  DoDisconnect(p, 0);
}

TEST_CASE("checking weapon cooldown", "[Hit]")
{
  PartOne& p = GetPartOne();
  DoConnect(p, 0);
  p.CreateActor(0xff000000, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, 0xff000000);

  auto& ac = p.worldState.GetFormAt<MpActor>(0xff000000);

  ActorValues actorValues;
  actorValues.healthPercentage = 1.f;
  actorValues.magickaPercentage = 1.f;
  actorValues.staminaPercentage = 1.f;
  ac.SetPercentages(actorValues);

  RawMessageData msgData;
  msgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.target = 0x14;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.source = 0x0001397E;
  ac.AddItem(hitMsg.data.source, 1);

  Equipment eq;
  eq.inv.entries.push_back(Inventory::Entry(80254, 1, kExtraWornTrue));
  ac.SetEquipment(eq);

  auto past = std::chrono::steady_clock::now() - 300ms;

  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(msgData, hitMsg);

  auto current = ac.GetLastHitTime(0xff000000);
  std::chrono::duration<float> duration = current - past;
  float passedTime = duration.count();
  float daggerSpeed = 1.3f;

  REQUIRE(passedTime <= 1.1 * (1 / daggerSpeed));
  REQUIRE(p.Messages().size() == 0);

  past = std::chrono::steady_clock::now() - 3s;
  ac.SetLastHitTime(0xff000000, past);
  p.Messages().clear();
  p.GetActionListener().OnHit(msgData, hitMsg);
  current = ac.GetLastHitTime(0xff000000);
  duration = current - past;
  passedTime = duration.count();

  REQUIRE(passedTime >= 1.1 * (1 / daggerSpeed));
  REQUIRE(p.Messages().size() == 1);
  nlohmann::json message = p.Messages()[0].j;
  uint64_t msgType = 16; // OnHit sends ChangeValues message type
  REQUIRE(message["t"] == msgType);
  REQUIRE(message["data"]["health"] == 0.75f);
  REQUIRE(message["data"]["magicka"] == nlohmann::json{});
  REQUIRE(message["data"]["stamina"] == nlohmann::json{});

  p.DestroyActor(0xff000000);
  DoDisconnect(p, 0);
}

namespace {
nlohmann::json MakeSpellCastMessage(uint32_t spell, bool interruptCast)
{
  return nlohmann::json{
    { "t", MsgType::SpellCast },
    { "data",
      { { "caster", 0x14 },
        { "target", 0x14 },
        { "spell", spell },
        { "isDualCasting", false },
        { "interruptCast", interruptCast },
        { "castingSource", 0 },
        { "aimAngle", 0.f },
        { "aimHeading", 0.f },
        { "actorAnimationVariables",
          { { "booleans", nlohmann::json::array() },
            { "floats", nlohmann::json::array() },
            { "integers", nlohmann::json::array() } } },
        { "keepAlive", false } } }
  };
}
}

TEST_CASE("An active ward blocks a frontal spell hit like a shield", "[Hit]")
{
  PartOne& p = GetPartOne();
  constexpr uint32_t kAggressor = 0xff000000;
  constexpr uint32_t kTarget = 0xff000001;
  constexpr uint32_t kFlames = 0x00012fcd;
  constexpr uint32_t kGreaterWard = 0x000211f0;

  DoConnect(p, 0);
  DoConnect(p, 1);
  p.CreateActor(kAggressor, { 30, 100, 0 }, 0, 0x3c);
  p.CreateActor(kTarget, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kAggressor);
  p.SetUserActor(1, kTarget);
  auto& aggressor = p.worldState.GetFormAt<MpActor>(kAggressor);
  auto& target = p.worldState.GetFormAt<MpActor>(kTarget);

  Equipment aggressorEquipment;
  aggressorEquipment.leftSpell = kFlames;
  aggressor.SetEquipment(aggressorEquipment);
  Equipment targetEquipment;
  targetEquipment.leftSpell = kGreaterWard;
  target.SetEquipment(targetEquipment);

  RawMessageData rawMsgData;
  rawMsgData.userId = 0;
  HitMessage hitMsg;
  hitMsg.data.aggressor = 0x14;
  hitMsg.data.target = kTarget;
  hitMsg.data.source = kFlames;

  auto healthLostToHit = [&] {
    target.SetPercentages({ 1.f, 1.f, 1.f });
    p.GetActionListener().OnHit(rawMsgData, hitMsg);
    return 1.f - target.GetChangeForm().actorValues.healthPercentage;
  };

  // Angle 0 faces +y, towards the aggressor
  target.SetAngle({ 0.f, 0.f, 0.f });
  const float unwarded = healthLostToHit();
  REQUIRE(unwarded > 0.f);

  DoMessage(p, 1, MakeSpellCastMessage(kGreaterWard, false));
  REQUIRE(healthLostToHit() == Catch::Approx(unwarded * 0.1f));

  target.SetAngle({ 0.f, 0.f, 180.f });
  REQUIRE(healthLostToHit() == Catch::Approx(unwarded));

  target.SetAngle({ 0.f, 0.f, 0.f });
  DoMessage(p, 1, MakeSpellCastMessage(kGreaterWard, true));
  REQUIRE(healthLostToHit() == Catch::Approx(unwarded));

  p.DestroyActor(kAggressor);
  p.DestroyActor(kTarget);
  DoDisconnect(p, 0);
  DoDisconnect(p, 1);
}

TEST_CASE("A paralysed actor cannot attack or move", "[Hit]")
{
  PartOne& p = GetPartOne();
  constexpr uint32_t kCaster = 0xff000000;
  constexpr uint32_t kVictim = 0xff000001;
  constexpr uint32_t kParalyze = 0x0005ad5f;
  constexpr uint32_t kIronDagger = 0x0001397e;

  DoConnect(p, 0);
  DoConnect(p, 1);
  p.CreateActor(kCaster, { 0, 100, 0 }, 0, 0x3c);
  p.CreateActor(kVictim, { 0, 0, 0 }, 0, 0x3c);
  p.SetUserActor(0, kCaster);
  p.SetUserActor(1, kVictim);
  auto& caster = p.worldState.GetFormAt<MpActor>(kCaster);
  auto& victim = p.worldState.GetFormAt<MpActor>(kVictim);

  Equipment casterEquipment;
  casterEquipment.leftSpell = kParalyze;
  caster.SetEquipment(casterEquipment);
  victim.AddItem(kIronDagger, 1);
  Equipment victimEquipment;
  victimEquipment.inv.entries.push_back(
    Inventory::Entry(kIronDagger, 1, kExtraWornTrue));
  victim.SetEquipment(victimEquipment);

  RawMessageData victimMsgData;
  victimMsgData.userId = 1;
  HitMessage stab;
  stab.data.aggressor = 0x14;
  stab.data.target = kCaster;
  stab.data.source = kIronDagger;

  auto casterHealthAfterStab = [&] {
    caster.SetPercentages({ 1.f, 1.f, 1.f });
    victim.SetLastHitTime(kCaster, std::chrono::steady_clock::now() - 10s);
    p.GetActionListener().OnHit(victimMsgData, stab);
    return caster.GetChangeForm().actorValues.healthPercentage;
  };

  REQUIRE(casterHealthAfterStab() < 1.f);

  RawMessageData casterMsgData;
  casterMsgData.userId = 0;
  HitMessage paralyze;
  paralyze.data.aggressor = 0x14;
  paralyze.data.target = kVictim;
  paralyze.data.source = kParalyze;
  p.GetActionListener().OnHit(casterMsgData, paralyze);

  REQUIRE(casterHealthAfterStab() == 1.f);

  auto movement = jMovement;
  movement["idx"] = victim.GetIdx();
  movement["data"]["pos"] = { 300.f, 0.f, 0.f };
  DoMessage(p, 1, movement);
  REQUIRE(victim.GetPos() == NiPoint3{ 0.f, 0.f, 0.f });

  p.DestroyActor(kCaster);
  p.DestroyActor(kVictim);
  DoDisconnect(p, 0);
  DoDisconnect(p, 1);
}
