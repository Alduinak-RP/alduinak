#pragma once
#include "EffectModifiers.h"
#include "ItemRowRules.h"
#include <algorithm>
#include <array>
#include <cmath>

// The per-hit arithmetic of the rebalance formula, free of server types
namespace HitMath {

using ItemRows::WeaponType;

// Crit chance never exceeds this, penetration never ignores more DT than this
inline constexpr float kCritChanceCap = 0.4f;
inline constexpr float kPenetrationCap = 0.9f;
inline constexpr int kMaxTemperStep = 6;

enum class AttackKind : uint8_t
{
  // A staff, a dummy row or no weapon at all: the hit deals 0
  None,
  Melee,
  Bow,
  Crossbow,
  // Fists of a humanoid, claws included
  Unarmed,
  // A creature's own attack priced from RACE unarmed damage
  Natural
};

inline const char* AttackKindName(AttackKind kind) noexcept
{
  switch (kind) {
    case AttackKind::Melee:
      return "melee";
    case AttackKind::Bow:
      return "bow";
    case AttackKind::Crossbow:
      return "crossbow";
    case AttackKind::Unarmed:
      return "unarmed";
    case AttackKind::Natural:
      return "natural";
    default:
      return "none";
  }
}

// Everything the formula needs about the attacker's side of one hit
struct Attack
{
  AttackKind kind = AttackKind::None;
  WeaponType type = WeaponType::None;
  // Damage before tempering and DT, the arrow bonus included
  float base = 0.f;
  int temperStep = 0;
  float critChance = 0.f;
  float critMult = 1.f;
  float penetration = 0.f;
  float floor = 0.2f;
  float powerMult = 1.f;
  float sneakMult = 1.f;
  bool autoCritOnSneak = false;
  // Speed normalisation of a record faster than its row, 1 for a standard one
  float speedFactor = 1.f;
  // Seconds of one swing, draw or reload at the row's standard speed
  float cycle = 0.f;
  // Condition of the weapon copy: its damage share and whether it is broken
  float conditionMult = 1.f;
  bool broken = false;
};

struct Target
{
  // Worn pieces and shield, temper included
  float wornDT = 0.f;
  // Hide of a creature
  float naturalDT = 0.f;
  bool isPlayer = true;
};

struct HitFlags
{
  bool power = false;
  bool sneak = false;
  bool bash = false;
};

struct Hit
{
  // The attack has no row to price: 0 damage, before any floor
  bool ignored = false;
  bool crit = false;
  // Damage before DT: tempered, bashed, crit and creature cap applied
  float preDT = 0.f;
  // DT left after the crit halving and penetration
  float effectiveDT = 0.f;
  // Damage after DT, power or sneak, speed and the player to NPC knob; before a block, the wrappers, poison and the cap
  float damage = 0.f;
};

// Temper step 0 (plain) to 6 (Legendary) of an item health of 1.0 to 1.6
inline int TemperStep(float health)
{
  if (!std::isfinite(health)) {
    return 0;
  }
  const long step = std::lround((health - 1.f) * 10.f);
  return static_cast<int>(std::clamp<long>(step, 0, kMaxTemperStep));
}

inline float ArrowBonus(const AlduinakCombatSettings& s, float ammoDamage)
{
  return std::clamp(s.arrowScale * (ammoDamage - s.arrowZero), 0.f,
                    s.arrowMax);
}

inline float MeleeCycle(int hands, float speed)
{
  return (hands == 1 ? 0.867f : 0.756f) / speed;
}

inline float BowCycle(float speed)
{
  return 0.5f + 1.f / std::clamp(speed, 0.5f, 1.f);
}

// Share of the row's damage a record with its own cycle keeps, 1 for a record speed that is not positive
inline float SpeedFactor(const AlduinakCombatSettings& s, float recordCycle,
                         float rowCycle)
{
  if (!(recordCycle > 0.f) || !(rowCycle > 0.f) ||
      !std::isfinite(recordCycle)) {
    return 1.f;
  }
  return std::clamp(recordCycle / rowCycle, s.speedNormMin, s.speedNormMax);
}

inline void FillTypeTraits(const AlduinakCombatSettings& s, WeaponType type,
                           const ItemRows::ItemRow& item, Attack& attack)
{
  const auto& row = s.TypeRow(type);
  attack.type = type;
  attack.critChance =
    std::min(kCritChanceCap, row.critChance + item.critChance);
  attack.critMult = row.critMult;
  attack.penetration = row.penetration + item.penetration;
  attack.floor = row.floor;
  attack.powerMult = row.powerMult;
  attack.sneakMult = row.sneakMult;
  attack.autoCritOnSneak = row.autoCritOnSneak;
}

// A resolved WEAP in hand; recordSpeed is the WEAP's own speed, ammoDamage below 0 means no arrow counts
inline Attack WeaponAttack(const AlduinakCombatSettings& s,
                           const ItemRows::ItemRow& item, float recordSpeed,
                           int temperStep, float ammoDamage)
{
  Attack attack;
  const float bonus = ammoDamage >= 0.f ? ArrowBonus(s, ammoDamage) : 0.f;
  switch (item.kind) {
    case ItemRows::Kind::Weapon: {
      const auto& row = s.TypeRow(item.type);
      attack.kind = AttackKind::Melee;
      FillTypeTraits(s, item.type, item, attack);
      attack.base = item.damage;
      attack.cycle = MeleeCycle(row.hands, row.speed);
      attack.speedFactor = recordSpeed > 0.f
        ? SpeedFactor(s, MeleeCycle(row.hands, recordSpeed), attack.cycle)
        : 1.f;
      break;
    }
    case ItemRows::Kind::Bow:
      attack.kind = AttackKind::Bow;
      FillTypeTraits(s, WeaponType::Bow, item, attack);
      attack.base = item.damage + bonus;
      attack.cycle = BowCycle(item.speed);
      attack.speedFactor = recordSpeed > 0.f
        ? SpeedFactor(s, BowCycle(recordSpeed), attack.cycle)
        : 1.f;
      break;
    case ItemRows::Kind::Crossbow:
      attack.kind = AttackKind::Crossbow;
      FillTypeTraits(s, WeaponType::Crossbow, item, attack);
      attack.base = item.damage + bonus;
      attack.cycle = s.crossbowReload;
      break;
    default:
      return attack;
  }
  attack.temperStep = std::clamp(temperStep, 0, kMaxTemperStep);
  return attack;
}

// Fists of a humanoid race without a claw entry
inline Attack UnarmedAttack(const AlduinakCombatSettings& s)
{
  const auto& row = s.TypeRow(WeaponType::Unarmed);
  Attack attack;
  attack.kind = AttackKind::Unarmed;
  attack.type = WeaponType::Unarmed;
  attack.base = s.unarmedBase;
  attack.critChance = std::min(kCritChanceCap, s.unarmedCritChance);
  attack.critMult = s.unarmedCritMult;
  attack.penetration = s.unarmedPenetration;
  attack.floor = s.unarmedFloor;
  attack.powerMult = row.powerMult;
  attack.sneakMult = row.sneakMult;
  attack.autoCritOnSneak = row.autoCritOnSneak;
  attack.cycle = MeleeCycle(row.hands, row.speed);
  return attack;
}

// Fists of a race with an unarmed.raceOverride entry: the weapon row's rules at the fist's timing, never tempered
inline Attack ClawAttack(const AlduinakCombatSettings& s,
                         const ItemRows::ItemRow& claw)
{
  const auto& fists = s.TypeRow(WeaponType::Unarmed);
  Attack attack;
  attack.kind = AttackKind::Unarmed;
  FillTypeTraits(s, claw.type, claw, attack);
  attack.base = claw.damage;
  attack.cycle = MeleeCycle(fists.hands, fists.speed);
  return attack;
}

// A creature's own attack from its RACE unarmed damage
inline Attack NaturalAttack(const AlduinakCombatSettings& s, float raceDamage)
{
  Attack attack;
  attack.kind = AttackKind::Natural;
  attack.type = WeaponType::Unarmed;
  attack.base = std::isfinite(raceDamage) ? std::max(raceDamage, 0.f) : 0.f;
  attack.critChance =
    s.npcNaturalCanCrit ? std::min(kCritChanceCap, s.unarmedCritChance) : 0.f;
  attack.critMult = s.npcNaturalCanCrit ? s.unarmedCritMult : 1.f;
  attack.penetration = attack.base <= s.npcCritterMaxDamage
    ? s.npcCritterPenetration
    : s.npcOtherPenetration;
  attack.floor = s.npcNaturalFloor;
  attack.powerMult = s.npcNaturalPowerMult;
  return attack;
}

// Seconds the melee rate limit allows between two swings of the attack
inline float MeleeInterval(const AlduinakCombatSettings& s,
                           const Attack& attack)
{
  return s.rateLimitFactor * attack.cycle * attack.speedFactor;
}

// DT of what a target wears: the best piece per slot group and the best shield
struct WornDT
{
  std::array<float, ItemRows::kNumShareBuckets> buckets{};
  float shield = 0.f;

  // DT of one worn copy at its temper step and condition share, 0 for what is no armor or shield
  static float PieceDT(const AlduinakCombatSettings& s,
                       const ItemRows::ItemRow& item, int temperStep,
                       float conditionMult = 1.f)
  {
    if (item.kind != ItemRows::Kind::Armor &&
        item.kind != ItemRows::Kind::Shield) {
      return 0.f;
    }
    const int step = std::clamp(temperStep, 0, kMaxTemperStep);
    return item.dt * (1.f + s.temperingArmorPerStep * step) * conditionMult;
  }

  void Add(const AlduinakCombatSettings& s, const ItemRows::ItemRow& item,
           int temperStep, float conditionMult = 1.f)
  {
    const float dt = PieceDT(s, item, temperStep, conditionMult);
    if (item.kind == ItemRows::Kind::Shield) {
      shield = std::max(shield, dt);
      return;
    }
    if (item.kind != ItemRows::Kind::Armor || !(item.slotShare > 0.f)) {
      return;
    }
    for (size_t i = 0; i < buckets.size(); ++i) {
      if (item.Covers(static_cast<ItemRows::SlotBucket>(i))) {
        buckets[i] =
          std::max(buckets[i], dt * s.slotShare[i] / item.slotShare);
      }
    }
  }

  [[nodiscard]] float Total() const
  {
    float sum = shield;
    for (float dt : buckets) {
      sum += dt;
    }
    return sum;
  }
};

// One hit by the plan's order; critRoll is a uniform sample of [0, 1), canCrit false for blocked hits and attackers that never crit
inline Hit PriceHit(const AlduinakCombatSettings& s, const Attack& attack,
                    const Target& target, const HitFlags& flags,
                    bool aggressorIsPlayer, bool canCrit, float critRoll)
{
  Hit hit;
  if (attack.kind == AttackKind::None) {
    hit.ignored = true;
    return hit;
  }
  float d = attack.base * (1.f + s.temperingWeaponPerStep * attack.temperStep) *
    attack.conditionMult;
  hit.crit = canCrit && !attack.broken &&
    ((flags.sneak && attack.autoCritOnSneak) || critRoll < attack.critChance);
  if (flags.bash) {
    d *= s.bashMult;
    hit.crit = false;
  }
  if (hit.crit) {
    d *= attack.critMult;
  }
  if (attack.kind == AttackKind::Natural && target.isPlayer &&
      s.npcNaturalCapBeforeDT) {
    d = std::min(d, s.playerHitCap);
  }
  hit.preDT = d;

  float dt = target.wornDT + target.naturalDT;
  if (hit.crit) {
    dt *= s.critDTMult;
  }
  hit.effectiveDT = dt * (1.f - std::min(kPenetrationCap, attack.penetration));

  float damage =
    std::max({ d - hit.effectiveDT, attack.floor * d, s.minDamage });
  if (flags.power || flags.sneak) {
    damage *= std::max(flags.power ? attack.powerMult : 1.f,
                       flags.sneak ? attack.sneakMult : 1.f);
  }
  damage *= attack.speedFactor;
  if (!target.isPlayer && aggressorIsPlayer) {
    damage *= s.npcPlayerToNpcMult;
  }
  hit.damage = damage;
  return hit;
}

// Share of the unblocked damage a blocked hit lets through: baseShare scaled by the blocker's block modifier, at least brokenBlockPass for a broken shield or parrying weapon
inline float BlockedShare(float baseShare, float blockMult,
                          bool brokenBlocker = false,
                          float brokenBlockPass = 0.f)
{
  const float share = BlockedPassShare(baseShare, blockMult);
  return brokenBlocker ? std::max(share, brokenBlockPass) : share;
}

// Health a weapon poison of magnitude P takes after the target's plain worn DT
inline float PoisonAfterDT(const AlduinakCombatSettings& s, float poison,
                           float wornDT)
{
  return poison > 0.f ? std::max(poison - wornDT, s.poisonFloor * poison)
                      : 0.f;
}

// The whole hit, poison included, never takes more than playerHitCap from a player
inline float CapPlayerHit(const AlduinakCombatSettings& s, float total,
                          bool targetIsPlayer)
{
  return targetIsPlayer ? std::min(total, s.playerHitCap) : total;
}

// A health fraction float drift left just above 0 counts as 0
inline float SnapHealth(const AlduinakCombatSettings& s, float fraction)
{
  return fraction <= s.healthSnap ? 0.f : fraction;
}

}
