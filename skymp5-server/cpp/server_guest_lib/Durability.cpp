#include "Durability.h"

#include "MpActor.h"
#include "WorldState.h"
#include "formulas/ItemRowResolver.h"
#include "gamemode_events/CustomEvent.h"
#include "libespm/espm.h"
#include <TimeUtils.h>
#include <algorithm>
#include <cmath>
#include <limits>
#include <nlohmann/json.hpp>
#include <spdlog/spdlog.h>
#include <string>

namespace {

constexpr uint32_t kUnarmedSource = 0x1f4;
constexpr const char* kBrokenEvent = "onItemBroken";

struct Context
{
  WorldState* worldState = nullptr;
  ItemRowResolver* resolver = nullptr;
  const DurabilityRules::Settings* settings = nullptr;
};

std::optional<Context> ContextOf(const MpActor& actor)
{
  WorldState* worldState = actor.GetParent();
  const auto* settings = Durability::GetSettings(worldState);
  if (!settings) {
    return std::nullopt;
  }
  return Context{ worldState, worldState->itemRowResolver.get(), settings };
}

bool Wears(const MpActor& actor, const Context& ctx)
{
  return actor.GetProfileId() >= 0 || ctx.settings->npcGearWears;
}

bool IsWeaponKind(ItemRows::Kind kind)
{
  return kind == ItemRows::Kind::Weapon || kind == ItemRows::Kind::Bow ||
    kind == ItemRows::Kind::Crossbow;
}

// Staffs, dummies, clothing and jewelry have no HP and never wear
bool IsDurable(const ItemRows::ItemRow& item)
{
  return item.hp > 0.f &&
    (IsWeaponKind(item.kind) || item.kind == ItemRows::Kind::Armor ||
     item.kind == ItemRows::Kind::Shield);
}

bool WearsOut(const Context& ctx, uint32_t baseId)
{
  return IsDurable(ctx.resolver->Resolve(baseId, *ctx.worldState)) &&
    !ctx.resolver->IsExempt(baseId, *ctx.worldState);
}

// The same copy apart from the poison a hit spends on it
bool SameCopy(Inventory::Entry a, Inventory::Entry b)
{
  a.poisonId.reset();
  a.poisonCount.reset();
  b.poisonId.reset();
  b.poisonCount.reset();
  return a.SameItemAs(b);
}

float ConditionOf(const std::optional<float>& condition)
{
  return std::clamp(condition.value_or(1.f), 0.f, 1.f);
}

// The worn copy of the weapon that hit, the right hand first
const Inventory::Entry* FindWornWeapon(const MpActor& actor, uint32_t source)
{
  const Inventory::Entry* found = nullptr;
  for (const auto& entry : actor.GetEquipment().inv.entries) {
    if (entry.baseId != source || entry.GetWorn() == Inventory::Worn::None) {
      continue;
    }
    if (entry.GetWorn() == Inventory::Worn::Right) {
      return &entry;
    }
    found = &entry;
  }
  return found;
}

const Inventory::Entry* FindWornShield(const MpActor& actor,
                                       const Context& ctx)
{
  for (const auto& entry : actor.GetEquipment().inv.entries) {
    if (entry.GetWorn() != Inventory::Worn::None &&
        ctx.resolver->Resolve(entry.baseId, *ctx.worldState).kind ==
          ItemRows::Kind::Shield) {
      return &entry;
    }
  }
  return nullptr;
}

// The weapon a block without a shield is made with, the right hand first
const Inventory::Entry* FindParryingWeapon(const MpActor& actor,
                                           const Context& ctx)
{
  const Inventory::Entry* found = nullptr;
  for (const auto& entry : actor.GetEquipment().inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None ||
        !IsWeaponKind(
          ctx.resolver->Resolve(entry.baseId, *ctx.worldState).kind)) {
      continue;
    }
    if (entry.GetWorn() == Inventory::Worn::Right) {
      return &entry;
    }
    found = &entry;
  }
  return found;
}

// Index of the inventory copy a worn slot stands for: the worn entry's twin at the bound condition, then the closest condition; -1 without a copy of the base
int FindCopy(const Inventory& inventory, uint32_t baseId,
             const std::optional<float>& condition,
             const Inventory::Entry* worn)
{
  int best = -1;
  int bestRank = std::numeric_limits<int>::max();
  float bestDistance = 0.f;
  for (size_t i = 0; i < inventory.entries.size(); ++i) {
    const auto& entry = inventory.entries[i];
    if (entry.baseId != baseId || entry.count == 0) {
      continue;
    }
    const bool twin = worn && SameCopy(entry, *worn);
    const bool exact = entry.condition == condition;
    const int rank = twin && exact ? 0 : twin ? 1 : exact ? 2 : 3;
    const float distance =
      std::fabs(ConditionOf(entry.condition) - ConditionOf(condition));
    if (rank < bestRank || (rank == bestRank && distance < bestDistance)) {
      best = static_cast<int>(i);
      bestRank = rank;
      bestDistance = distance;
    }
  }
  return best;
}

// Bound weapons and other worn things the inventory never held take no wear
void AddWear(const MpActor& actor, const Inventory::Entry& worn, float points)
{
  if (!(points > 0.f)) {
    return;
  }
  auto& state = actor.GetDurabilityState();
  for (auto& pending : state.pending) {
    if (pending.baseId == worn.baseId && pending.worn == worn.GetWorn()) {
      pending.points += points;
      return;
    }
  }
  const auto& inventory = actor.GetInventory();
  const int index = FindCopy(inventory, worn.baseId, worn.condition, &worn);
  if (index >= 0) {
    state.pending.push_back({ worn.baseId, worn.GetWorn(),
                              inventory.entries[index].condition, points });
  }
}

// Copies of the worn entry's kind at a condition
uint32_t CountTwins(const Inventory& inventory, const Inventory::Entry& worn,
                    const std::optional<float>& condition)
{
  uint32_t count = 0;
  for (const auto& entry : inventory.entries) {
    if (entry.baseId == worn.baseId && entry.condition == condition &&
        SameCopy(entry, worn)) {
      count += entry.count;
    }
  }
  return count;
}

// The one condition a rewrite gave more twins of than before held, when the worn copy's own condition is gone: a repair of that copy
std::optional<std::optional<float>> RewrittenCondition(
  const Inventory& before, const Inventory& after,
  const Inventory::Entry& worn)
{
  if (CountTwins(after, worn, worn.condition) > 0 ||
      CountTwins(before, worn, worn.condition) == 0) {
    return std::nullopt;
  }
  std::optional<std::optional<float>> gained;
  for (const auto& entry : after.entries) {
    if (entry.baseId != worn.baseId || !SameCopy(entry, worn) ||
        (gained && *gained == entry.condition) ||
        CountTwins(after, worn, entry.condition) <=
          CountTwins(before, worn, entry.condition)) {
      continue;
    }
    if (gained) {
      return std::nullopt;
    }
    gained = entry.condition;
  }
  return gained;
}

bool BindWornEntries(const Context& ctx, const Inventory& inventory,
                     Equipment& equipment, const Inventory* before = nullptr)
{
  bool changed = false;
  for (auto& entry : equipment.inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None ||
        !IsDurable(ctx.resolver->Resolve(entry.baseId, *ctx.worldState))) {
      continue;
    }
    const auto rewritten =
      before ? RewrittenCondition(*before, inventory, entry) : std::nullopt;
    const int index =
      FindCopy(inventory, entry.baseId, entry.condition, &entry);
    const std::optional<float> condition = rewritten ? *rewritten
      : index >= 0 ? inventory.entries[index].condition
                   : std::nullopt;
    if (entry.condition != condition) {
      entry.condition = condition;
      changed = true;
    }
  }
  return changed;
}

struct BrokenItem
{
  uint32_t baseId = 0;
  ItemRows::Kind kind = ItemRows::Kind::None;
  std::string row;
};

// Writes pending wear into the inventory copies and the worn entries with one change form edit; final drops what the rounding left over
bool Flush(MpActor& actor, const Context& ctx, bool final)
{
  auto& state = actor.GetDurabilityState();
  if (state.pending.empty()) {
    return false;
  }
  Inventory inventory = actor.GetInventory();
  Equipment equipment = actor.GetEquipment();
  std::vector<BrokenItem> broken;
  bool changed = false;
  for (auto& pending : state.pending) {
    const auto& item = ctx.resolver->Resolve(pending.baseId, *ctx.worldState);
    auto worn =
      std::find_if(equipment.inv.entries.begin(), equipment.inv.entries.end(),
                   [&](const Inventory::Entry& entry) {
                     return entry.baseId == pending.baseId &&
                       entry.GetWorn() == pending.worn;
                   });
    const Inventory::Entry* wornEntry =
      worn == equipment.inv.entries.end() ? nullptr : &*worn;
    const int index =
      FindCopy(inventory, pending.baseId, pending.condition, wornEntry);
    if (index < 0 || !IsDurable(item)) {
      spdlog::info("Durability - {:x} holds no copy of {:x}, {} points of "
                   "wear dropped",
                   actor.GetFormId(), pending.baseId, pending.points);
      pending.points = 0.f;
      continue;
    }
    const Inventory::Entry copy = inventory.entries[index];
    const auto after =
      DurabilityRules::ApplyWear(copy.condition, pending.points, item.hp);
    const auto stored = ConditionTag::Stored(after.condition);
    if (stored == copy.condition) {
      continue;
    }
    Inventory::Entry from = copy;
    from.count = 1;
    Inventory::Entry to = from;
    to.condition = stored;
    inventory.RemoveItems({ from });
    inventory.AddItems({ to });
    if (wornEntry) {
      worn->condition = stored;
    }
    spdlog::info("Durability - {:x} {:x} ({} {}): {}% -> {}% after {} "
                 "points of {} HP",
                 actor.GetFormId(), pending.baseId,
                 ItemRows::KindName(item.kind), item.row,
                 ConditionTag::Percent(copy.condition),
                 ConditionTag::Percent(stored), pending.points, item.hp);
    pending.condition = stored;
    pending.points = after.carry;
    changed = true;
    if (after.broke) {
      broken.push_back({ pending.baseId, item.kind, item.row });
    }
  }
  if (final) {
    state.pending.clear();
  } else {
    std::erase_if(state.pending, [](const Durability::Pending& pending) {
      return pending.points == 0.f;
    });
  }
  if (changed) {
    state.lastFlushAt = Durability::Clock::now();
    actor.SetInventoryAndEquipment(inventory, equipment);
  }
  for (const auto& item : broken) {
    spdlog::info("Durability: {:x} {:x} broke", actor.GetFormId(),
                 item.baseId);
    const nlohmann::json args = { item.baseId, ItemRows::KindName(item.kind),
                                  item.row };
    CustomEvent(actor.GetFormId(), kBrokenEvent, args.dump())
      .Fire(ctx.worldState);
  }
  return changed;
}

void OnCalmTimer(WorldState* worldState, uint32_t formId);

// One timer per actor with pending wear, due when the fight has been over for calmSeconds
void ArmCalmTimer(MpActor& actor, const Context& ctx, float seconds)
{
  auto& state = actor.GetDurabilityState();
  if (state.calmTimerSet || state.pending.empty()) {
    return;
  }
  state.calmTimerSet = true;
  WorldState* worldState = ctx.worldState;
  const uint32_t formId = actor.GetFormId();
  worldState
    ->SetTimer(
      Viet::TimeUtils::To<std::chrono::milliseconds>(std::max(seconds, 0.5f)))
    .Then(
      [worldState, formId](Viet::Void) { OnCalmTimer(worldState, formId); });
}

void OnCalmTimer(WorldState* worldState, uint32_t formId)
{
  auto& form = worldState->LookupFormByIdNoLoad(formId);
  MpActor* actor = form ? form->AsActor() : nullptr;
  if (!actor) {
    return;
  }
  auto& state = actor->GetDurabilityState();
  state.calmTimerSet = false;
  const auto ctx = ContextOf(*actor);
  if (!ctx || state.pending.empty()) {
    return;
  }
  const float calm = ctx->settings->flushCalmSeconds;
  const float since = state.lastHitAt
    ? std::chrono::duration<float>(Durability::Clock::now() - *state.lastHitAt)
        .count()
    : calm;
  if (since + 0.05f >= calm) {
    Flush(*actor, *ctx, true);
  } else {
    ArmCalmTimer(*actor, *ctx, calm - since);
  }
}

// Flushes when a shown percent moves and the last flush is old enough, and keeps the calm timer running
void AfterWear(MpActor& actor, const Context& ctx)
{
  auto& state = actor.GetDurabilityState();
  if (state.pending.empty()) {
    return;
  }
  const bool percentChanges =
    std::any_of(state.pending.begin(), state.pending.end(),
                [&](const Durability::Pending& pending) {
                  return DurabilityRules::PercentChanges(
                    pending.condition, pending.points,
                    ctx.resolver->Resolve(pending.baseId, *ctx.worldState).hp);
                });
  const float sinceFlush = state.lastFlushAt
    ? std::chrono::duration<float>(Durability::Clock::now() -
                                   *state.lastFlushAt)
        .count()
    : std::numeric_limits<float>::infinity();
  if (DurabilityRules::FlushDue(*ctx.settings, percentChanges, sinceFlush)) {
    Flush(actor, ctx, false);
  }
  ArmCalmTimer(actor, ctx, ctx.settings->flushCalmSeconds);
}

// "weapon" for what is held, the first slot group an armor piece covers
const char* SlotName(const ItemRows::ItemRow& item)
{
  if (item.kind == ItemRows::Kind::Shield) {
    return ItemRows::SlotBucketName(ItemRows::SlotBucket::Shield);
  }
  if (item.kind == ItemRows::Kind::Armor) {
    for (size_t i = 0; i < ItemRows::kNumShareBuckets; ++i) {
      const auto bucket = static_cast<ItemRows::SlotBucket>(i);
      if (item.Covers(bucket)) {
        return ItemRows::SlotBucketName(bucket);
      }
    }
  }
  return "weapon";
}

double Num(float value)
{
  return std::isfinite(value) ? std::round(value * 10000.0) / 10000.0 : 0.0;
}

}

const DurabilityRules::Settings* Durability::GetSettings(
  const WorldState* worldState)
{
  if (!worldState || !worldState->itemRowResolver) {
    return nullptr;
  }
  const auto& settings = worldState->itemRowResolver->GetSettings().durability;
  return settings.enabled ? &settings : nullptr;
}

DurabilityRules::WeaponEffect Durability::WornWeaponEffect(
  const MpActor& aggressor, uint32_t source)
{
  const auto* settings = GetSettings(aggressor.GetParent());
  const auto* worn = settings ? FindWornWeapon(aggressor, source) : nullptr;
  return worn ? DurabilityRules::WeaponEffectOf(*settings, worn->condition)
              : DurabilityRules::WeaponEffect();
}

float Durability::WornArmorEffect(const WorldState* worldState,
                                  const Inventory::Entry& worn)
{
  const auto* settings = GetSettings(worldState);
  return settings ? DurabilityRules::ArmorEffectOf(*settings, worn.condition)
                  : 1.f;
}

float Durability::BrokenBlockPass(const MpActor& blocker)
{
  const auto ctx = ContextOf(blocker);
  if (!ctx) {
    return 0.f;
  }
  const auto* shield = FindWornShield(blocker, *ctx);
  const auto* held = shield ? shield : FindParryingWeapon(blocker, *ctx);
  return held && ConditionTag::IsBroken(held->condition)
    ? ctx->settings->effect.brokenBlockPass
    : 0.f;
}

float Durability::RecordDamage(const MpActor& aggressor, uint32_t source)
{
  WorldState* worldState = aggressor.GetParent();
  if (!worldState || !worldState->HasEspm()) {
    return 0.f;
  }
  auto& browser = worldState->GetEspm().GetBrowser();
  auto& cache = worldState->GetEspmCache();
  if (source == kUnarmedSource) {
    const auto race =
      espm::Convert<espm::RACE>(browser.LookupById(aggressor.GetRaceId()).rec);
    return race ? race->GetData(cache).unarmedDamage : 0.f;
  }
  const auto weapon =
    espm::Convert<espm::WEAP>(browser.LookupById(source).rec);
  const auto data = weapon ? weapon->GetData(cache).weapData : nullptr;
  return data ? static_cast<float>(data->damage) : 0.f;
}

namespace {
void WearFromHit(MpActor& aggressor, MpActor& target, const Context& context,
                 const HitData& hitData, float preDT, float damage);
}

void Durability::OnWeaponHit(MpActor& aggressor, MpActor& target,
                             const HitData& hitData, float preDT, float damage)
{
  const auto ctx = ContextOf(aggressor);
  if (!ctx) {
    return;
  }
  try {
    WearFromHit(aggressor, target, *ctx, hitData, preDT, damage);
  } catch (std::exception& e) {
    spdlog::error("Durability - wear of the hit of {:x} on {:x} failed: {}",
                  aggressor.GetFormId(), target.GetFormId(), e.what());
  }
}

namespace {
void WearFromHit(MpActor& aggressor, MpActor& target, const Context& context,
                 const HitData& hitData, float preDT, float damage)
{
  const Context* ctx = &context;
  const auto now = Durability::Clock::now();
  aggressor.GetDurabilityState().lastHitAt = now;
  target.GetDurabilityState().lastHitAt = now;

  const DurabilityRules::HitFacts facts{ hitData.isPowerAttack,
                                         hitData.isBashAttack,
                                         hitData.isHitBlocked };
  const auto sourceKind = hitData.source == kUnarmedSource
    ? ItemRows::Kind::Unarmed
    : ctx->resolver->Resolve(hitData.source, *ctx->worldState).kind;
  // A staff, a dummy and a hit that took nothing without being blocked (a practice arrow, a zone without damage) wear neither side
  const bool counts = sourceKind != ItemRows::Kind::Staff &&
    sourceKind != ItemRows::Kind::Dummy && (facts.blocked || damage > 0.f);
  const bool shoots = (sourceKind == ItemRows::Kind::Bow ||
                       sourceKind == ItemRows::Kind::Crossbow) &&
    !facts.bash;
  if (!counts) {
    AfterWear(aggressor, *ctx);
    AfterWear(target, *ctx);
    return;
  }

  const auto& wear = ctx->settings->wear;
  if (Wears(aggressor, *ctx) && WearsOut(*ctx, hitData.source)) {
    if (const auto* worn = FindWornWeapon(aggressor, hitData.source)) {
      AddWear(aggressor, *worn,
              DurabilityRules::AggressorWear(wear, shoots, facts));
    }
  }

  if (Wears(target, *ctx)) {
    const auto* shield = FindWornShield(target, *ctx);
    switch (
      DurabilityRules::TargetWearOf(wear, facts, shield != nullptr, preDT)) {
      case DurabilityRules::TargetWear::Shield:
        if (WearsOut(*ctx, shield->baseId)) {
          AddWear(target, *shield, DurabilityRules::ShieldWear(wear, facts));
        }
        break;
      case DurabilityRules::TargetWear::ParryingWeapon:
        if (const auto* weapon = FindParryingWeapon(target, *ctx);
            weapon && WearsOut(*ctx, weapon->baseId)) {
          AddWear(target, *weapon, DurabilityRules::ParryWear(wear));
        }
        break;
      case DurabilityRules::TargetWear::Armor: {
        // Every worn piece takes its slot share of the hit, so a full set loses the same percent on each piece
        float wornShares = 0.f;
        std::vector<std::pair<const Inventory::Entry*, float>> pieces;
        for (const auto& entry : target.GetEquipment().inv.entries) {
          if (entry.GetWorn() == Inventory::Worn::None) {
            continue;
          }
          const auto& item =
            ctx->resolver->Resolve(entry.baseId, *ctx->worldState);
          if (item.kind == ItemRows::Kind::Armor && item.slotShare > 0.f &&
              item.hp > 0.f) {
            wornShares += item.slotShare;
            pieces.push_back({ &entry, item.slotShare });
          }
        }
        const float points = DurabilityRules::ArmorWear(wear, facts);
        for (const auto& [entry, share] : pieces) {
          if (!ctx->resolver->IsExempt(entry->baseId, *ctx->worldState)) {
            AddWear(
              target, *entry,
              DurabilityRules::ArmorPieceWear(points, share, wornShares));
          }
        }
        break;
      }
      default:
        break;
    }
  }

  AfterWear(aggressor, *ctx);
  AfterWear(target, *ctx);
}
}

bool Durability::Settle(MpActor& actor)
{
  const auto ctx = ContextOf(actor);
  if (!ctx) {
    return false;
  }
  try {
    Flush(actor, *ctx, true);
    SyncWorn(actor);
  } catch (std::exception& e) {
    actor.GetDurabilityState().pending.clear();
    spdlog::error("Durability - settling {:x} failed, its pending wear is "
                  "dropped: {}",
                  actor.GetFormId(), e.what());
  }
  return true;
}

bool Durability::BindWorn(const MpActor& actor, Equipment& equipment)
{
  const auto ctx = ContextOf(actor);
  return ctx && BindWornEntries(*ctx, actor.GetInventory(), equipment);
}

void Durability::SyncWorn(MpActor& actor, const Inventory* before)
{
  const auto ctx = ContextOf(actor);
  if (!ctx) {
    return;
  }
  Equipment equipment = actor.GetEquipment();
  if (BindWornEntries(*ctx, actor.GetInventory(), equipment, before)) {
    actor.SetEquipment(equipment);
  }
}

void Durability::OnDeath(MpActor& actor)
{
  const auto ctx = ContextOf(actor);
  if (!ctx) {
    return;
  }
  try {
    if (ctx->settings->deathWear > 0.f && Wears(actor, *ctx)) {
      for (const auto& entry : actor.GetEquipment().inv.entries) {
        if (entry.GetWorn() != Inventory::Worn::None &&
            WearsOut(*ctx, entry.baseId)) {
          AddWear(actor, entry,
                  ctx->settings->deathWear *
                    ctx->resolver->Resolve(entry.baseId, *ctx->worldState).hp);
        }
      }
    }
  } catch (std::exception& e) {
    spdlog::error("Durability - death wear of {:x} failed: {}",
                  actor.GetFormId(), e.what());
  }
  Settle(actor);
}

nlohmann::json Durability::GetDurability(const MpActor& actor)
{
  const auto ctx = ContextOf(actor);
  if (!ctx) {
    return nullptr;
  }
  const auto& inventory = actor.GetInventory();
  std::vector<Inventory::Worn> wornAt(inventory.entries.size(),
                                      Inventory::Worn::None);
  for (const auto& entry : actor.GetEquipment().inv.entries) {
    if (entry.GetWorn() == Inventory::Worn::None ||
        !IsDurable(ctx->resolver->Resolve(entry.baseId, *ctx->worldState))) {
      continue;
    }
    const int index =
      FindCopy(inventory, entry.baseId, entry.condition, &entry);
    if (index >= 0) {
      wornAt[index] = entry.GetWorn();
    }
  }

  auto copies = nlohmann::json::array();
  for (size_t i = 0; i < inventory.entries.size(); ++i) {
    const auto& entry = inventory.entries[i];
    const auto& item = ctx->resolver->Resolve(entry.baseId, *ctx->worldState);
    if (entry.count == 0 || !IsDurable(item)) {
      continue;
    }
    const float condition = ConditionOf(entry.condition);
    copies.push_back(nlohmann::json{
      { "index", i },
      { "baseId", entry.baseId },
      { "count", entry.count },
      { "condition", Num(condition) },
      { "percent", ConditionTag::Percent(entry.condition) },
      { "broken", ConditionTag::IsBroken(entry.condition) },
      { "hp", std::round(condition * item.hp * 10.0) / 10.0 },
      { "maxHp", Num(item.hp) },
      { "row", item.row },
      { "kind", ItemRows::KindName(item.kind) },
      { "slot", SlotName(item) },
      { "worn", wornAt[i] != Inventory::Worn::None },
      { "wornLeft", wornAt[i] == Inventory::Worn::Left },
      { "health", Num(entry.health.value_or(1.f)) },
      { "exempt", ctx->resolver->IsExempt(entry.baseId, *ctx->worldState) },
      { "fallbackMaterial",
        ctx->resolver->GetRepairFallbackMaterial(item, *ctx->worldState) } });
  }
  return copies;
}
