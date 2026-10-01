#include "AlduinakDamageFormula.h"

#include "HitData.h"
#include "ItemRowResolver.h"
#include "MpActor.h"
#include "SpellCastData.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <algorithm>
#include <cstring>
#include <optional>
#include <spdlog/spdlog.h>
#include <stdexcept>

namespace {

constexpr uint32_t kUnarmedSource = 0x1f4;
constexpr const char* kHumanoidKeyword = "ActorTypeNPC";

bool IsPlayer(const MpActor& actor)
{
  return actor.GetProfileId() >= 0;
}

// Temper step of a player's worn copy, never above the best copy of that base the player owns; NPC gear is plain
int WornTemperStep(const MpActor& wearer, const Inventory::Entry& worn)
{
  if (!IsPlayer(wearer)) {
    return 0;
  }
  const float claimed = worn.health.value_or(1.f);
  if (!(claimed > 1.f)) {
    return 0;
  }
  float best = 1.f;
  for (const auto& entry : wearer.GetInventory().entries) {
    if (entry.baseId == worn.baseId) {
      best = std::max(best, entry.health.value_or(1.f));
    }
  }
  return HitMath::TemperStep(std::min(claimed, best));
}

// The worn copy of the weapon that hit, the right hand first
std::optional<Inventory::Entry> FindWornWeapon(const MpActor& aggressor,
                                               uint32_t source)
{
  std::optional<Inventory::Entry> found;
  for (const auto& entry : aggressor.GetEquipment().inv.entries) {
    if (entry.baseId != source || entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    if (entry.GetWorn() == Inventory::Worn::Right) {
      return entry;
    }
    found = entry;
  }
  return found;
}

// AMMO damage of the worn arrows or bolts, below 0 without any
float WornAmmoDamage(const MpActor& aggressor, WorldState& worldState)
{
  auto& browser = worldState.GetEspm().GetBrowser();
  for (const auto& entry : aggressor.GetEquipment().inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    if (const auto ammo =
          espm::Convert<espm::AMMO>(browser.LookupById(entry.baseId).rec)) {
      return std::max(ammo->GetData(worldState.GetEspmCache()).damage, 0.f);
    }
  }
  return -1.f;
}

float RecordSpeed(uint32_t weaponId, WorldState& worldState)
{
  const auto weapon = espm::Convert<espm::WEAP>(
    worldState.GetEspm().GetBrowser().LookupById(weaponId).rec);
  const auto dnam =
    weapon ? weapon->GetData(worldState.GetEspmCache()).weapDNAM : nullptr;
  return dnam ? dnam->speed : 0.f;
}

}

AlduinakDamageFormula::AlduinakDamageFormula(
  std::shared_ptr<ItemRowResolver> resolver_)
  : resolver(std::move(resolver_))
  , rng(std::random_device{}())
{
  if (!resolver) {
    throw std::runtime_error("AlduinakDamageFormula needs the row resolver");
  }
}

const AlduinakCombatSettings& AlduinakDamageFormula::GetSettings()
  const noexcept
{
  return resolver->GetSettings();
}

void AlduinakDamageFormula::Seed(uint32_t seed) const
{
  rng.seed(seed);
}

const AlduinakDamageFormula::RaceInfo& AlduinakDamageFormula::GetRaceInfo(
  uint32_t raceId, WorldState& worldState) const
{
  auto it = races.find(raceId);
  if (it != races.end()) {
    return it->second;
  }
  RaceInfo info;
  auto& browser = worldState.GetEspm().GetBrowser();
  auto& cache = worldState.GetEspmCache();
  const auto lookup = browser.LookupById(raceId);
  if (const auto race = espm::Convert<espm::RACE>(lookup.rec)) {
    const auto data = race->GetData(cache);
    info.unarmedDamage = data.unarmedDamage;
    info.humanoid = (data.flags & espm::RACE::kPlayable) != 0;
    for (uint32_t rawId : lookup.rec->GetKeywordIds(cache)) {
      const auto keyword = browser.LookupById(lookup.ToGlobalId(rawId));
      if (keyword.rec &&
          !std::strcmp(keyword.rec->GetEditorId(cache), kHumanoidKeyword)) {
        info.humanoid = true;
      }
    }
    spdlog::info("AlduinakDamageFormula - race {:x} ({}): fists are {}",
                 raceId, lookup.rec->GetEditorId(cache),
                 info.humanoid
                   ? "the unarmed row"
                   : fmt::format("a creature attack of {} damage",
                                 info.unarmedDamage));
  } else {
    spdlog::warn("AlduinakDamageFormula - {:x} is not a RACE, its fists use "
                 "the unarmed row",
                 raceId);
  }
  return races.emplace(raceId, info).first->second;
}

HitMath::Attack AlduinakDamageFormula::GetAttack(const MpActor& aggressor,
                                                 uint32_t source, bool bash,
                                                 std::string* row) const
{
  WorldState* worldState = aggressor.GetParent();
  if (!worldState) {
    throw std::runtime_error("AlduinakDamageFormula - no world state");
  }
  const auto& settings = resolver->GetSettings();
  const auto& item = resolver->Resolve(source, *worldState);
  if (source == kUnarmedSource || item.kind == ItemRows::Kind::Unarmed) {
    const uint32_t raceId = aggressor.GetRaceId();
    if (const auto claw = resolver->GetClawRow(raceId, *worldState)) {
      if (row) {
        *row = claw->row;
      }
      return HitMath::ClawAttack(settings, *claw);
    }
    const auto& race = GetRaceInfo(raceId, *worldState);
    return race.humanoid
      ? HitMath::UnarmedAttack(settings)
      : HitMath::NaturalAttack(settings, race.unarmedDamage);
  }
  if (row) {
    *row = item.row;
  }
  const bool shoots = item.kind == ItemRows::Kind::Bow ||
    item.kind == ItemRows::Kind::Crossbow;
  const auto worn = FindWornWeapon(aggressor, source);
  auto attack = HitMath::WeaponAttack(
    settings, item, RecordSpeed(source, *worldState),
    worn ? WornTemperStep(aggressor, *worn) : 0,
    shoots && !bash ? WornAmmoDamage(aggressor, *worldState) : -1.f);
  if (attack.kind == HitMath::AttackKind::None &&
      item.kind != ItemRows::Kind::Staff &&
      item.kind != ItemRows::Kind::Dummy) {
    spdlog::warn("AlduinakDamageFormula - source {:x} of {:x} is no weapon "
                 "the rows know ({}), the hit deals 0",
                 source, aggressor.GetFormId(), item.rule);
  }
  return attack;
}

HitMath::WornDT AlduinakDamageFormula::GetWornDT(
  const MpActor& target, std::vector<WornPiece>* pieces) const
{
  HitMath::WornDT worn;
  WorldState* worldState = target.GetParent();
  if (!worldState) {
    return worn;
  }
  const auto& settings = resolver->GetSettings();
  for (const auto& entry : target.GetEquipment().inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    const auto& item = resolver->Resolve(entry.baseId, *worldState);
    if (item.kind != ItemRows::Kind::Armor &&
        item.kind != ItemRows::Kind::Shield) {
      continue;
    }
    const int step = WornTemperStep(target, entry);
    worn.Add(settings, item, step);
    if (pieces) {
      pieces->push_back({ entry.baseId, item.kind, item.row, item.buckets,
                          step,
                          HitMath::WornDT::PieceDT(settings, item, step) });
    }
  }
  return worn;
}

float AlduinakDamageFormula::GetNaturalDT(const MpActor& target) const
{
  WorldState* worldState = target.GetParent();
  if (!worldState || IsPlayer(target)) {
    return 0.f;
  }
  return resolver->GetNaturalDT(target.GetRaceId(), *worldState);
}

float AlduinakDamageFormula::CapHit(const MpActor& target, float total) const
{
  return HitMath::CapPlayerHit(resolver->GetSettings(), total,
                               IsPlayer(target));
}

float AlduinakDamageFormula::CalculateDamage(const MpActor& aggressor,
                                             const MpActor& target,
                                             const HitData& hitData) const
{
  const auto& settings = resolver->GetSettings();
  const bool aggressorIsPlayer = IsPlayer(aggressor);

  LastHit hit;
  hit.aggressor = aggressor.GetFormId();
  hit.target = target.GetFormId();
  hit.source = hitData.source;
  hit.power = hitData.isPowerAttack;
  hit.sneak = hitData.isSneakAttack;
  hit.bash = hitData.isBashAttack;
  hit.blocked = hitData.isHitBlocked;

  const auto attack =
    GetAttack(aggressor, hitData.source, hitData.isBashAttack, &hit.row);
  hit.kind = attack.kind;
  hit.type = attack.type;
  hit.temperStep = attack.temperStep;
  hit.speedFactor = attack.speedFactor;

  HitMath::Target defender;
  defender.isPlayer = IsPlayer(target);
  defender.wornDT = GetWornDT(target).Total();
  defender.naturalDT = GetNaturalDT(target);
  hit.wornDT = defender.wornDT;
  hit.naturalDT = defender.naturalDT;

  const bool mayCrit = aggressorIsPlayer ||
    (attack.kind == HitMath::AttackKind::Natural
       ? settings.npcNaturalCanCrit
       : settings.npcHumanoidCanCrit);
  const bool canCrit =
    mayCrit && !hitData.isHitBlocked && !hitData.isBashAttack;
  const float critRoll = canCrit && attack.critChance > 0.f
    ? std::uniform_real_distribution<float>(0.f, 1.f)(rng)
    : 1.f;

  const auto priced = HitMath::PriceHit(
    settings, attack, defender,
    { hitData.isPowerAttack, hitData.isSneakAttack, hitData.isBashAttack },
    aggressorIsPlayer, canCrit, critRoll);
  hit.ignored = priced.ignored;
  hit.crit = priced.crit;
  hit.preDT = priced.preDT;
  hit.effectiveDT = priced.effectiveDT;

  float damage = priced.damage;
  if (damage > 0.f) {
    damage *= GetWeaponEffectMult(aggressor, target, hitData.source);
  }
  hit.unblockedDamage = damage;

  if (hitData.isHitBlocked) {
    // A player's block lets npcBlockedDamageShare of an NPC's hit through, every other block stops the hit
    const WorldState* worldState = aggressor.GetParent();
    const bool npcOnPlayer = !aggressorIsPlayer && defender.isPlayer;
    const float baseShare = npcOnPlayer && worldState
      ? worldState->npcBlockedDamageShare
      : kBlockedHitDamageMult;
    hit.blockedShare = HitMath::BlockedShare(
      baseShare, GetBlockEffectMult(target, aggressor));
    damage *= hit.blockedShare;
  }
  hit.damage = damage;

  spdlog::info(
    "AlduinakDamageFormula - {:x} hits {:x} with {:x} ({}{}{}{}, temper "
    "{}):{}{}{}{}{} {} before DT, DT {} worn + {} natural -> {} effective, "
    "speed x{}, {} unblocked, {} lands{}",
    hit.aggressor, hit.target, hit.source, HitMath::AttackKindName(hit.kind),
    hit.row.empty() ? "" : " ", hit.row,
    ItemRows::IsMeleeType(hit.type)
      ? std::string(" ") + ItemRows::WeaponTypeName(hit.type)
      : std::string(),
    hit.temperStep, hit.ignored ? " ignored" : "", hit.crit ? " crit" : "",
    hit.power ? " power" : "", hit.sneak ? " sneak" : "",
    hit.bash ? " bash" : "", hit.preDT, hit.wornDT, hit.naturalDT,
    hit.effectiveDT, hit.speedFactor, hit.unblockedDamage, hit.damage,
    hit.blocked ? fmt::format(" (blocked, share {})", hit.blockedShare)
                : std::string());

  lastHit = std::move(hit);
  return damage;
}

float AlduinakDamageFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  // OnSpellHit caps the hit after the outer wrappers
  return spellFormula.CalculateDamage(aggressor, target, spellCastData);
}
