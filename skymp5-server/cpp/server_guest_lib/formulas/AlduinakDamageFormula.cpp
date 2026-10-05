#include "AlduinakDamageFormula.h"

#include "AlduinakHitRules.h"
#include "Durability.h"
#include "DurabilityRules.h"
#include "HitData.h"
#include "ItemRowResolver.h"
#include "MagicRules.h"
#include "MpActor.h"
#include "SpellCastData.h"
#include "TemperCap.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <algorithm>
#include <cmath>
#include <cstring>
#include <nlohmann/json.hpp>
#include <optional>
#include <spdlog/spdlog.h>
#include <stdexcept>

namespace {

constexpr const char* kHumanoidKeyword = "ActorTypeNPC";
// QuickShot rides the Hunter rank markers from Adept up
constexpr const char* kQuickShotProfession = "Hunter";
constexpr int kQuickShotRank = 2;

bool IsPlayer(const MpActor& actor)
{
  return actor.GetProfileId() >= 0;
}

// The per-hit formula lines log at info only while combatTrace is on
spdlog::level::level_enum TraceLevel(const WorldState* worldState)
{
  return worldState && worldState->combatTrace ? spdlog::level::info
                                               : spdlog::level::debug;
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

// AMMO damage of the arrow or bolt the shooter last fired from this weapon, the worn one once that shot is old
float ShotAmmoDamage(const MpActor& aggressor, uint32_t weaponId,
                     WorldState& worldState)
{
  const auto& combat = aggressor.GetCombatState();
  const uint32_t fired = combat.lastShotWeapon == weaponId
    ? HitRules::FiredAmmo(combat, HitRules::Clock::now())
    : 0;
  if (fired) {
    if (const auto ammo = espm::Convert<espm::AMMO>(
          worldState.GetEspm().GetBrowser().LookupById(fired).rec)) {
      return std::max(ammo->GetData(worldState.GetEspmCache()).damage, 0.f);
    }
  }
  return WornAmmoDamage(aggressor, worldState);
}

float RecordSpeed(uint32_t weaponId, WorldState& worldState)
{
  const auto weapon = espm::Convert<espm::WEAP>(
    worldState.GetEspm().GetBrowser().LookupById(weaponId).rec);
  const auto dnam =
    weapon ? weapon->GetData(worldState.GetEspmCache()).weapDNAM : nullptr;
  return dnam ? dnam->speed : 0.f;
}

// Four decimals, so a float reads in JSON as the settings wrote it
double Num(float value)
{
  return std::isfinite(value) ? std::round(value * 10000.0) / 10000.0 : 0.0;
}

nlohmann::json AttackJson(const AlduinakCombatSettings& settings,
                          const HitMath::Attack& attack,
                          const std::string& row, float interval)
{
  return nlohmann::json{
    { "kind", HitMath::AttackKindName(attack.kind) },
    { "type", ItemRows::WeaponTypeName(attack.type) },
    { "row", row },
    { "temperStep", attack.temperStep },
    { "baseDamage", Num(attack.base) },
    { "damage",
      Num(attack.base *
          (1.f + settings.temperingWeaponPerStep * attack.temperStep) *
          attack.conditionMult) },
    { "critChance", Num(attack.critChance) },
    { "critMult", Num(attack.critMult) },
    { "penetration", Num(attack.penetration) },
    { "floor", Num(attack.floor) },
    { "powerMult", Num(attack.powerMult) },
    { "sneakMult", Num(attack.sneakMult) },
    { "speedFactor", Num(attack.speedFactor) },
    { "interval", Num(interval) },
    { "conditionMult", Num(attack.conditionMult) },
    { "broken", attack.broken }
  };
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
    shoots && !bash ? ShotAmmoDamage(aggressor, source, *worldState) : -1.f);
  // Condition is roleplay only
  // if (settings.durability.enabled && worn) {
  //   const auto effect =
  //     DurabilityRules::WeaponEffectOf(settings.durability, worn->condition);
  //   attack.conditionMult = effect.mult;
  //   attack.broken = effect.broken;
  // }
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
    // Condition is roleplay only
    // const float conditionMult = settings.durability.enabled
    //   ? DurabilityRules::ArmorEffectOf(settings.durability, entry.condition)
    //   : 1.f;
    const float conditionMult = 1.f;
    worn.Add(settings, item, step, conditionMult);
    if (pieces) {
      const bool counts = settings.durability.enabled;
      pieces->push_back(
        { entry.baseId, item.kind, item.row, item.buckets, step,
          counts ? std::clamp(entry.condition.value_or(1.f), 0.f, 1.f) : 1.f,
          counts && ConditionTag::IsBroken(entry.condition),
          HitMath::WornDT::PieceDT(settings, item, step, conditionMult) });
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
  hit.conditionMult = attack.conditionMult;
  hit.brokenWeapon = attack.broken;

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
    // A broken shield or parrying weapon lets at least brokenBlockPass through
    const float brokenPass = Durability::BrokenBlockPass(target);
    hit.brokenBlocker = brokenPass > 0.f;
    hit.blockedShare =
      HitMath::BlockedShare(baseShare, GetBlockEffectMult(target, aggressor),
                            hit.brokenBlocker, brokenPass);
    damage *= hit.blockedShare;
  }
  hit.damage = damage;

  if (const auto level = TraceLevel(aggressor.GetParent());
      spdlog::should_log(level)) {
    spdlog::log(
      level,
      "AlduinakDamageFormula - {:x} hits {:x} with {:x} ({}{}{}{}, temper "
      "{}):{}{}{}{}{} {} before DT, DT {} worn + {} natural -> {} effective, "
      "speed x{}, {} unblocked, {} lands{}{}",
      hit.aggressor, hit.target, hit.source,
      HitMath::AttackKindName(hit.kind), hit.row.empty() ? "" : " ", hit.row,
      ItemRows::IsMeleeType(hit.type)
        ? std::string(" ") + ItemRows::WeaponTypeName(hit.type)
        : std::string(),
      hit.temperStep, hit.ignored ? " ignored" : "", hit.crit ? " crit" : "",
      hit.power ? " power" : "", hit.sneak ? " sneak" : "",
      hit.bash ? " bash" : "", hit.preDT, hit.wornDT, hit.naturalDT,
      hit.effectiveDT, hit.speedFactor, hit.unblockedDamage, hit.damage,
      hit.blocked ? fmt::format(" (blocked{}, share {})",
                                hit.brokenBlocker ? " with a broken item" : "",
                                hit.blockedShare)
                  : std::string(),
      hit.conditionMult != 1.f
        ? fmt::format(", the weapon{} deals x{} at its condition",
                      hit.brokenWeapon ? " is broken and" : "",
                      hit.conditionMult)
        : std::string());
  }

  lastHit = std::move(hit);
  return damage;
}

float AlduinakDamageFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  const auto& magic = resolver->GetSettings().magic;
  const WorldState* worldState = target.GetParent();
  const auto parts =
    CalculateSpellDamageParts(aggressor, target, spellCastData);

  LastSpellHit hit;
  hit.aggressor = aggressor.GetFormId();
  hit.target = target.GetFormId();
  hit.spell = spellCastData.spell;
  hit.unresisted = parts.unresisted;
  hit.resisted = parts.damage;
  hit.damage = parts.damage;
  if (parts.damage > 0.f && magic.dtShare > 0.f) {
    hit.wornDT = GetWornDT(target).Total();
    hit.spellDT = MagicRules::SpellDT(hit.wornDT, magic.dtShare);
    hit.damage = MagicRules::SpellAfterDT(parts.damage, hit.wornDT,
                                          magic.dtShare, magic.floor);
  }

  if (hit.damage != hit.unresisted) {
    spdlog::log(
      TraceLevel(worldState),
      "AlduinakDamageFormula - spell {:x} of {:x} on {:x}: {} before "
      "resistances, {} after, worn DT {} x {} takes {}, {} lands",
      hit.spell, hit.aggressor, hit.target, hit.unresisted, hit.resisted,
      hit.wornDT, magic.dtShare, hit.resisted - hit.damage, hit.damage);
  }

  // OnSpellHit caps the hit after the outer wrappers
  lastSpellHit = hit;
  return hit.damage;
}

float AlduinakDamageFormula::GetHitInterval(const MpActor& aggressor,
                                            uint32_t source, bool bash) const
{
  return HitRules::HitInterval(resolver->GetSettings(),
                               GetAttack(aggressor, source, bash));
}

bool AlduinakDamageFormula::HasQuickShot(const MpActor& actor) const
{
  WorldState* worldState = actor.GetParent();
  if (!worldState || !IsPlayer(actor)) {
    return false;
  }
  if (!quickShotMarkers) {
    quickShotMarkers.emplace();
    auto& cache = worldState->GetEspmCache();
    for (const auto& spell :
         worldState->GetEspm().GetBrowser().GetDistinctRecordsByType("SPEL")) {
      const auto marker =
        TemperCap::ParseMarkerEditorId(spell.rec->GetEditorId(cache));
      if (marker && marker->profession == kQuickShotProfession &&
          marker->rank >= kQuickShotRank) {
        quickShotMarkers->push_back(spell.ToGlobalId(spell.rec->GetId()));
      }
    }
    spdlog::info("AlduinakDamageFormula - {} {} rank markers from {} up "
                 "shorten the shot interval (QuickShot)",
                 quickShotMarkers->size(), kQuickShotProfession,
                 TemperCap::kRankNames[kQuickShotRank]);
  }
  return std::any_of(
    quickShotMarkers->begin(), quickShotMarkers->end(),
    [&](uint32_t spellId) { return actor.IsSpellLearned(spellId); });
}

float AlduinakDamageFormula::GetShotInterval(const MpActor& shooter,
                                             uint32_t weaponId,
                                             bool* quickShot) const
{
  if (quickShot) {
    *quickShot = false;
  }
  WorldState* worldState = shooter.GetParent();
  if (!worldState) {
    return 0.f;
  }
  const auto& settings = resolver->GetSettings();
  const auto& item = resolver->Resolve(weaponId, *worldState);
  if (item.kind == ItemRows::Kind::Crossbow) {
    return HitRules::CrossbowShotInterval(settings);
  }
  if (item.kind != ItemRows::Kind::Bow) {
    return 0.f;
  }
  const bool quick = HasQuickShot(shooter);
  if (quickShot) {
    *quickShot = quick;
  }
  const float recordSpeed = RecordSpeed(weaponId, *worldState);
  const float speedFactor = recordSpeed > 0.f
    ? HitMath::SpeedFactor(settings, HitMath::BowCycle(recordSpeed),
                           HitMath::BowCycle(item.speed))
    : 1.f;
  return HitRules::BowShotInterval(settings, item.speed, speedFactor, quick);
}

nlohmann::json AlduinakDamageFormula::GetCombatStats(
  const MpActor& actor) const
{
  WorldState* worldState = actor.GetParent();
  if (!worldState) {
    throw std::runtime_error("AlduinakDamageFormula - no world state");
  }
  const auto& settings = resolver->GetSettings();
  auto& browser = worldState->GetEspm().GetBrowser();
  auto& cache = worldState->GetEspmCache();

  std::vector<WornPiece> worn;
  const HitMath::WornDT wornDT = GetWornDT(actor, &worn);

  // A hit meets the best piece of a slot group, a second one adds nothing
  std::array<bool, ItemRows::kNumShareBuckets> taken{};
  bool shieldTaken = false;
  float armorWeight = 0.f;
  float shieldWeight = 0.f;
  auto pieces = nlohmann::json::array();
  for (const auto& piece : worn) {
    const auto& item = resolver->Resolve(piece.baseId, *worldState);
    const auto armor =
      espm::Convert<espm::ARMO>(browser.LookupById(piece.baseId).rec);
    const float weight =
      armor ? std::max(armor->GetData(cache).weight, 0.f) : 0.f;
    const bool isShield = piece.kind == ItemRows::Kind::Shield;
    (isShield ? shieldWeight : armorWeight) += weight;

    float counted = 0.f;
    auto slots = nlohmann::json::array();
    if (isShield) {
      slots.push_back(ItemRows::SlotBucketName(ItemRows::SlotBucket::Shield));
      if (!shieldTaken && piece.dt == wornDT.shield) {
        counted = piece.dt;
        shieldTaken = true;
      }
    } else {
      for (size_t i = 0; i < taken.size(); ++i) {
        const auto bucket = static_cast<ItemRows::SlotBucket>(i);
        if (!item.Covers(bucket) || !(item.slotShare > 0.f)) {
          continue;
        }
        slots.push_back(ItemRows::SlotBucketName(bucket));
        const float share = piece.dt * settings.slotShare[i] / item.slotShare;
        if (!taken[i] && share == wornDT.buckets[i]) {
          counted += share;
          taken[i] = true;
        }
      }
    }
    pieces.push_back(
      nlohmann::json{ { "baseId", piece.baseId },
                      { "kind", ItemRows::KindName(piece.kind) },
                      { "row", piece.row },
                      { "class", ItemRows::ArmorClassName(item.armorClass) },
                      { "lightOnHeavy", item.lightOnHeavy },
                      { "fallback", item.fallback },
                      { "slots", std::move(slots) },
                      { "temperStep", piece.temperStep },
                      { "condition", Num(piece.condition) },
                      { "broken", piece.broken },
                      { "dt", Num(piece.dt) },
                      { "countedDT", Num(counted) },
                      { "weight", Num(weight) } });
  }

  auto weapons = nlohmann::json::array();
  for (const auto& entry : actor.GetEquipment().inv.entries) {
    const auto hand = entry.GetWorn();
    if (hand == Inventory::Worn::None) {
      continue;
    }
    const auto& item = resolver->Resolve(entry.baseId, *worldState);
    if (item.kind != ItemRows::Kind::Weapon &&
        item.kind != ItemRows::Kind::Bow &&
        item.kind != ItemRows::Kind::Crossbow &&
        item.kind != ItemRows::Kind::Staff &&
        item.kind != ItemRows::Kind::Dummy) {
      continue;
    }
    std::string row;
    const auto attack = GetAttack(actor, entry.baseId, false, &row);
    const float melee = HitRules::HitInterval(settings, attack);
    auto weapon =
      AttackJson(settings, attack, row,
                 melee >= 0.f ? melee : GetShotInterval(actor, entry.baseId));
    weapon["baseId"] = entry.baseId;
    weapon["condition"] = settings.durability.enabled
      ? Num(std::clamp(entry.condition.value_or(1.f), 0.f, 1.f))
      : 1.0;
    weapon["hand"] = hand == Inventory::Worn::Left ? "left" : "right";
    weapon["item"] = ItemRows::KindName(item.kind);
    weapon["fallback"] = item.fallback;
    weapons.push_back(std::move(weapon));
  }

  std::string fistRow;
  const auto fists = GetAttack(actor, kUnarmedSource, false, &fistRow);

  return nlohmann::json{
    { "actorId", actor.GetFormId() },
    { "isPlayer", IsPlayer(actor) },
    { "armorWeight", Num(armorWeight) },
    { "shieldWeight", Num(shieldWeight) },
    { "wornDT", Num(wornDT.Total()) },
    { "naturalDT", Num(GetNaturalDT(actor)) },
    { "pieces", std::move(pieces) },
    { "weapons", std::move(weapons) },
    // What a hostile spell meets on this actor
    { "magic",
      nlohmann::json{
        { "dtShare", Num(settings.magic.dtShare) },
        { "floor", Num(settings.magic.floor) },
        { "spellDT",
          Num(MagicRules::SpellDT(wornDT.Total(), settings.magic.dtShare)) } } },
    { "unarmed",
      AttackJson(settings, fists, fistRow,
                 std::max(HitRules::HitInterval(settings, fists), 0.f)) }
  };
}
