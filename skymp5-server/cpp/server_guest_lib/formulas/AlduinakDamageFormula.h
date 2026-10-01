#pragma once
#include "AlduinakHitMath.h"
#include "IDamageFormula.h"
#include "TES5DamageFormula.h"
#include <cstdint>
#include <memory>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <random>
#include <string>
#include <unordered_map>
#include <vector>

class ItemRowResolver;
class WorldState;

// The rebalance formula of alduinakDamageFormulaSettings: row damage against worn DT for weapon hits, TES5 for spells
class AlduinakDamageFormula : public IDamageFormula
{
public:
  // What the last weapon hit was priced from, for the caller's log, events and wear
  struct LastHit
  {
    uint32_t aggressor = 0;
    uint32_t target = 0;
    uint32_t source = 0;
    HitMath::AttackKind kind = HitMath::AttackKind::None;
    ItemRows::WeaponType type = ItemRows::WeaponType::None;
    // Settings row of the weapon, empty for fists and creatures
    std::string row;
    int temperStep = 0;
    bool ignored = false;
    bool crit = false;
    bool power = false;
    bool sneak = false;
    bool bash = false;
    bool blocked = false;
    // Share of the unblocked damage that landed, 1 for a hit that was not blocked
    float blockedShare = 1.f;
    float preDT = 0.f;
    float wornDT = 0.f;
    float naturalDT = 0.f;
    float effectiveDT = 0.f;
    float speedFactor = 1.f;
    // Damage as if nothing blocked the hit
    float unblockedDamage = 0.f;
    // What CalculateDamage returned, before the wrappers, poison and the cap
    float damage = 0.f;
  };

  // One worn armor piece or shield with the DT it gives
  struct WornPiece
  {
    uint32_t baseId = 0;
    ItemRows::Kind kind = ItemRows::Kind::None;
    std::string row;
    // Bit per ItemRows::SlotBucket
    uint8_t buckets = 0;
    int temperStep = 0;
    float dt = 0.f;
  };

  explicit AlduinakDamageFormula(std::shared_ptr<ItemRowResolver> resolver_);

  [[nodiscard]] float CalculateDamage(const MpActor& aggressor,
                                      const MpActor& target,
                                      const HitData& hitData) const override;

  [[nodiscard]] float CalculateDamage(
    const MpActor& aggressor, const MpActor& target,
    const SpellCastData& spellCastData) const override;

  [[nodiscard]] const AlduinakCombatSettings& GetSettings() const noexcept;

  [[nodiscard]] const LastHit& GetLastHit() const noexcept { return lastHit; }

  // The attack of a WEAP or fist source in the aggressor's hands, row receives the weapon's settings row
  [[nodiscard]] HitMath::Attack GetAttack(const MpActor& aggressor,
                                          uint32_t source, bool bash = false,
                                          std::string* row = nullptr) const;

  // DT of what the target wears, pieces receives every worn armor piece and shield
  [[nodiscard]] HitMath::WornDT GetWornDT(
    const MpActor& target, std::vector<WornPiece>* pieces = nullptr) const;

  // npc.naturalDT of an NPC's race, 0 for a player
  [[nodiscard]] float GetNaturalDT(const MpActor& target) const;

  // total capped at playerHitCap for a player target
  [[nodiscard]] float CapHit(const MpActor& target, float total) const;

  // Seconds the rate limit asks between two melee hits with the source, below 0 where the record's own limit stays
  [[nodiscard]] float GetHitInterval(const MpActor& aggressor, uint32_t source,
                                     bool bash) const;

  // Seconds the bow or crossbow needs between two shots, 0 for anything else
  [[nodiscard]] float GetShotInterval(const MpActor& shooter,
                                      uint32_t weaponId,
                                      bool* quickShot = nullptr) const;

  // A Hunter of Adept rank or above draws faster
  [[nodiscard]] bool HasQuickShot(const MpActor& actor) const;

  // Worn armor weight, DT per worn piece, the weapons in hand and the fists, for getCombatStats
  [[nodiscard]] nlohmann::json GetCombatStats(const MpActor& actor) const;

  // Fixes the crit rolls, for tests
  void Seed(uint32_t seed) const;

private:
  struct RaceInfo
  {
    // Playable or ActorTypeNPC: fists use the unarmed row
    bool humanoid = true;
    float unarmedDamage = 0.f;
  };

  const RaceInfo& GetRaceInfo(uint32_t raceId, WorldState& worldState) const;

  std::shared_ptr<ItemRowResolver> resolver;
  TES5DamageFormula spellFormula;
  mutable std::mt19937 rng;
  mutable std::unordered_map<uint32_t, RaceInfo> races;
  // Hunter rank markers that carry QuickShot, read from the load order on first use
  mutable std::optional<std::vector<uint32_t>> quickShotMarkers;
  mutable LastHit lastHit;
};
