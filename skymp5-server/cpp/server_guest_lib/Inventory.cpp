#include "Inventory.h"
#include "archives/JsonInputArchive.h"
#include "archives/JsonOutputArchive.h"
#include "archives/SimdJsonInputArchive.h"
#include <algorithm>
#include <cmath>
#include <fmt/format.h>
#include <spdlog/spdlog.h>
#include <tuple>

namespace {
// Property keys (housing) are told apart by their name
constexpr uint32_t kPropertyKeyBaseId = 0x000DB0E2;

bool NearlyEqual(float a, float b)
{
  return std::fabs(a - b) <= 1e-3f * std::max(1.f, std::fabs(a));
}

// Tempering in tenths, the precision clients read it with
long HealthStep(const std::optional<float>& health)
{
  const float h = health.value_or(1.f);
  return h > 1.f ? std::lround(h * 10.f) : 10;
}

bool SameEffects(
  const std::optional<std::vector<Inventory::EnchantmentEffect>>& lhs,
  const std::optional<std::vector<Inventory::EnchantmentEffect>>& rhs)
{
  static const std::vector<Inventory::EnchantmentEffect> kNone;
  const auto& a = lhs ? *lhs : kNone;
  const auto& b = rhs ? *rhs : kNone;
  if (a.size() != b.size()) {
    return false;
  }
  for (size_t i = 0; i < a.size(); ++i) {
    if (a[i].effectId != b[i].effectId || a[i].area != b[i].area ||
        a[i].duration != b[i].duration ||
        !NearlyEqual(a[i].magnitude, b[i].magnitude)) {
      return false;
    }
  }
  return true;
}
}

Inventory::Entry::Entry()
{
}

Inventory::Entry::Entry(uint32_t baseId_, uint32_t count_,
                        const ExtraData& extraData_)
  : baseId(baseId_)
  , count(count_)
  , ExtraData(extraData_)
{
}

Inventory::Entry Inventory::Entry::FromJson(const simdjson::dom::element& e)
{
  std::string minifiedDump = simdjson::minify(e);
  nlohmann::json j = nlohmann::json::parse(minifiedDump);

  Entry res;
  JsonInputArchive ar(j);
  res.Serialize(ar);
  return res;
}

Inventory::Worn Inventory::Entry::GetWorn() const
{
  bool wornValue = worn_.value_or(false);
  bool wornLeftValue = wornLeft.value_or(false);

  if (wornLeftValue) {
    return Worn::Left;
  }
  if (wornValue) {
    return Worn::Right;
  }
  return Worn::None;
}

void Inventory::Entry::SetWorn(Inventory::Worn worn)
{
  if (worn == GetWorn()) {
    return;
  }

  switch (worn) {
    case Worn::None:
      worn_ = false;
      wornLeft = false;
      break;
    case Worn::Right:
      worn_ = true;
      wornLeft = false;
      break;
    case Worn::Left:
      worn_ = false;
      wornLeft = true;
      break;
    default:
      spdlog::warn("Inventory::SetWorn: unknown worn value {}",
                   static_cast<int>(worn));
      worn_ = false;
      wornLeft = false;
      break;
  }
}

bool Inventory::Entry::EqualExceptCount(const Inventory::Entry& other) const
{
  // GetWorn() instead of direct comparison because of possible false vs
  // nullopt mismatch. Logically it should be the same
  return std::make_tuple(baseId, health, enchantmentId, maxCharge,
                         removeEnchantmentOnUnequip, chargePercent, name, soul,
                         poisonId, poisonCount, enchantmentEffects,
                         GetWorn()) ==
    std::make_tuple(other.baseId, other.health, other.enchantmentId,
                    other.maxCharge, other.removeEnchantmentOnUnequip,
                    other.chargePercent, other.name, other.soul,
                    other.poisonId, other.poisonCount,
                    other.enchantmentEffects, other.GetWorn());
}

bool Inventory::Entry::SameItemAs(const Entry& other) const
{
  if (baseId != other.baseId) {
    return false;
  }
  if (baseId == kPropertyKeyBaseId &&
      name.value_or("") != other.name.value_or("")) {
    return false;
  }
  return HealthStep(health) == HealthStep(other.health) &&
    enchantmentId.value_or(0) == other.enchantmentId.value_or(0) &&
    SameEffects(enchantmentEffects, other.enchantmentEffects) &&
    NearlyEqual(maxCharge.value_or(0.f), other.maxCharge.value_or(0.f)) &&
    removeEnchantmentOnUnequip.value_or(false) ==
    other.removeEnchantmentOnUnequip.value_or(false) &&
    soul.value_or(0) == other.soul.value_or(0) &&
    poisonId.value_or(0) == other.poisonId.value_or(0) &&
    poisonCount.value_or(0) == other.poisonCount.value_or(0);
}

bool Inventory::Entry::HasIdentityExtras() const
{
  return !SameItemAs(Entry(baseId, 0));
}

std::vector<Inventory::Entry> Inventory::FindEntriesFor(
  const Entry& described) const
{
  std::vector<Entry> res;
  std::vector<uint32_t> left;
  left.reserve(entries.size());
  for (const auto& e : entries) {
    left.push_back(e.count);
  }
  uint32_t need = described.count;

  auto draw = [&](auto&& fits) {
    for (size_t i = 0; i < entries.size() && need > 0; ++i) {
      if (left[i] == 0 || !fits(entries[i])) {
        continue;
      }
      const uint32_t n = std::min(need, left[i]);
      left[i] -= n;
      need -= n;
      auto same = std::find_if(res.begin(), res.end(), [&](const Entry& r) {
        return r.EqualExceptCount(entries[i]);
      });
      if (same != res.end()) {
        same->count += n;
      } else {
        res.push_back(entries[i]);
        res.back().count = n;
      }
    }
  };

  draw([&](const Entry& e) { return e.EqualExceptCount(described); });
  Entry unworn = described;
  unworn.SetWorn(Worn::None);
  draw([&](const Entry& e) {
    Entry candidate = e;
    candidate.SetWorn(Worn::None);
    return candidate.EqualExceptCount(unworn);
  });
  draw([&](const Entry& e) { return e.SameItemAs(described); });
  if (described.HasIdentityExtras() && described.baseId != kPropertyKeyBaseId) {
    draw([&](const Entry& e) {
      return e.baseId == described.baseId && !e.HasIdentityExtras();
    });
  }

  if (need > 0) {
    return {};
  }
  return res;
}

Inventory& Inventory::AddItem(uint32_t baseId, uint32_t count)
{
  return AddItems({ { baseId, count } });
}

Inventory& Inventory::AddItems(const std::vector<Entry>& toAdd)
{
  for (auto& entryToAdd : toAdd) {
    auto it = std::find_if(entries.begin(), entries.end(),
                           [&](const Entry& entry) {
                             return entry.EqualExceptCount(entryToAdd);
                           });
    if (it != entries.end()) {
      it->count += entryToAdd.count;
    } else {
      entries.push_back(entryToAdd);
    }
  }
  return *this;
}

Inventory& Inventory::RemoveItems(const std::vector<Entry>& entries)
{
  auto copy = *this;

  for (auto& e : entries) {
    if (!e.count)
      continue;

    uint32_t remaining = e.count;
    uint32_t totalRemoved = 0;
    for (auto& entry : copy.entries) {
      if (entry.EqualExceptCount(e)) {
        if (entry.count > remaining) {
          entry.count -= remaining;
          totalRemoved += remaining;
          remaining = 0;
          break;
        } else {
          totalRemoved += entry.count;
          remaining -= entry.count;
          entry.count = 0;
        }
      }
    }

    if (totalRemoved != e.count) {
      throw std::runtime_error(
        fmt::format("Source inventory doesn't have enough {:#x} ({} is "
                    "required while {} present)",
                    e.baseId, e.count, totalRemoved));
    }

    // remove empty entries
    copy.entries.erase(
      std::remove_if(copy.entries.begin(), copy.entries.end(),
                     [](const Entry& e) { return e.count == 0; }),
      copy.entries.end());
  }

  *this = copy;
  return *this;
}

bool Inventory::HasItem(uint32_t baseId) const
{
  for (auto& entry : entries) {
    if (entry.baseId == baseId) {
      return true;
    }
  }
  return false;
}

uint32_t Inventory::GetItemCount(uint32_t baseId) const
{
  uint32_t sum = 0;
  for (auto& entry : entries) {
    if (entry.baseId == baseId) {
      sum += entry.count;
    }
  }
  return sum;
}

uint32_t Inventory::GetTotalItemCount() const
{
  uint32_t sum = 0;
  for (auto& entry : entries) {
    sum += entry.count;
  }
  return sum;
}

bool Inventory::IsEmpty() const
{
  return entries.empty();
}

nlohmann::json Inventory::ToJson() const
{
  JsonOutputArchive ar;
  const_cast<Inventory*>(this)->Serialize(ar);
  return std::move(ar.j);
}

Inventory Inventory::FromJson(const simdjson::dom::element& element)
{
  SimdJsonInputArchive ar(element);
  Inventory res;
  res.Serialize(ar);
  return res;
}

Inventory Inventory::FromJson(const nlohmann::json& j)
{
  JsonInputArchive ar(j);
  Inventory res;
  res.Serialize(ar);
  return res;
}
