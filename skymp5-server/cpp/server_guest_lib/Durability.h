#pragma once
#include "HitData.h"
#include "Inventory.h"
#include "formulas/DurabilityRules.h"
#include <chrono>
#include <cstdint>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <vector>

class MpActor;
class WorldState;
struct Equipment;

// Wear of worn weapons, armor and shields: alduinakDamageFormulaSettings.durability, every entry point does nothing while it is off
namespace Durability {

using Clock = std::chrono::steady_clock;

// Wear a worn copy took since its condition was last written
struct Pending
{
  uint32_t baseId = 0;
  Inventory::Worn worn = Inventory::Worn::None;
  // Condition of the copy when the wear began, which finds it again in the inventory
  std::optional<float> condition;
  float points = 0.f;
};

// What durability remembers about one actor between flushes, never saved
struct State
{
  std::vector<Pending> pending;
  std::optional<Clock::time_point> lastFlushAt;
  // The last weapon hit dealt, taken or blocked
  std::optional<Clock::time_point> lastHitAt;
  bool calmTimerSet = false;
};

// The durability block while durability.enabled is true, null otherwise
[[nodiscard]] const DurabilityRules::Settings* GetSettings(
  const WorldState* worldState);

// Damage share and broken flag of the worn copy of the weapon that hit
[[nodiscard]] DurabilityRules::WeaponEffect WornWeaponEffect(
  const MpActor& aggressor, uint32_t source);

// DT or armor rating share of a worn armor piece or shield entry
[[nodiscard]] float WornArmorEffect(const WorldState* worldState,
                                    const Inventory::Entry& worn);

// brokenBlockPass when the blocker holds up a broken shield, or without a shield parries with a broken weapon; 0 otherwise
[[nodiscard]] float BrokenBlockPass(const MpActor& blocker);

// Damage of the source before armor as TES5 reads it: the WEAP damage, the race's unarmed damage for fists
[[nodiscard]] float RecordDamage(const MpActor& aggressor, uint32_t source);

// Wear of one accepted weapon hit on both sides, then the flush rules; preDT is the damage before DT, damage what landed
void OnWeaponHit(MpActor& aggressor, MpActor& target, const HitData& hitData,
                 float preDT, float damage);

// Writes the pending wear into the inventory copies now and binds the worn entries; false while durability is off
bool Settle(MpActor& actor);

// Gives every worn entry the condition of the inventory copy it stands for; true when one changed
bool BindWorn(const MpActor& actor, Equipment& equipment);

// BindWorn on the stored equipment after the inventory was rewritten; before is the inventory as it was, which tells a repaired worn copy from its twins
void SyncWorn(MpActor& actor, const Inventory* before = nullptr);

// Settles a dying actor, after deathWear when that is set
void OnDeath(MpActor& actor);

// Every durable inventory copy for getDurability, null while durability is off
[[nodiscard]] nlohmann::json GetDurability(const MpActor& actor);

}
