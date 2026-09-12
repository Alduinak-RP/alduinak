#pragma once
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <simdjson.h>
#include <string>
#include <tuple>
#include <vector>

class Inventory
{
public:
  enum class Worn
  {
    None = 0,
    Right,
    Left
  };

  // Doesn't parse extra data currently
  template <class Archive>
  void Serialize(Archive& archive)
  {
    archive.Serialize("entries", entries);
  }

  // TODO: get rid of this in favor of Serialize
  nlohmann::json ToJson() const;
  static Inventory FromJson(const simdjson::dom::element& element);
  static Inventory FromJson(const nlohmann::json& j);

  // One effect of a player-made enchantment; clients rebuild the enchantment from these
  class EnchantmentEffect
  {
  public:
    template <class Archive>
    void Serialize(Archive& archive)
    {
      archive.Serialize("effectId", effectId)
        .Serialize("magnitude", magnitude)
        .Serialize("area", area)
        .Serialize("duration", duration)
        .Serialize("cost", cost);
    }

    friend bool operator==(const EnchantmentEffect& lhs,
                           const EnchantmentEffect& rhs) = default;

    uint32_t effectId = 0;
    float magnitude = 0.f;
    uint32_t area = 0;
    uint32_t duration = 0;
    float cost = 0.f;
  };

  class ExtraData
  {
  public:
    template <class Archive>
    void Serialize(Archive& archive)
    {
      archive.Serialize("health", health)
        .Serialize("enchantmentId", enchantmentId)
        .Serialize("maxCharge", maxCharge)
        .Serialize("removeEnchantmentOnUnequip", removeEnchantmentOnUnequip)
        .Serialize("chargePercent", chargePercent)
        .Serialize("name", name)
        .Serialize("soul", soul)
        .Serialize("poisonId", poisonId)
        .Serialize("poisonCount", poisonCount)
        .Serialize("enchantmentEffects", enchantmentEffects)
        .Serialize("worn", worn_)
        .Serialize("wornLeft", wornLeft);
    }

    std::optional<float> health;
    std::optional<uint32_t> enchantmentId;
    std::optional<float> maxCharge;
    std::optional<bool> removeEnchantmentOnUnequip;
    std::optional<float> chargePercent;
    std::optional<std::string> name;
    std::optional<uint8_t> soul;
    std::optional<uint32_t> poisonId;
    std::optional<uint32_t> poisonCount;
    // A player-made enchantment, by definition instead of a runtime form id
    std::optional<std::vector<EnchantmentEffect>> enchantmentEffects;
    std::optional<bool> worn_;
    std::optional<bool> wornLeft;
  };

  class Entry : public ExtraData
  {
  public:
    template <class Archive>
    void Serialize(Archive& archive)
    {
      archive.Serialize("baseId", baseId).Serialize("count", count);

      ExtraData::Serialize(archive);
    }

    Entry();
    Entry(uint32_t baseId_, uint32_t count_,
          const ExtraData& extraData_ = ExtraData());

    uint32_t baseId = 0;
    uint32_t count = 0;

    // TODO: get rid of this in favor of Serialize
    static Entry FromJson(const simdjson::dom::element& e);

    Worn GetWorn() const;
    void SetWorn(Worn worn);
    bool EqualExceptCount(const Entry& other) const;

    // Same item as clients see it: charge, worn state, float noise and names (except on property keys) drift
    bool SameItemAs(const Entry& other) const;
    bool HasIdentityExtras() const;

    friend bool operator==(const Entry& lhs, const Entry& rhs)
    {
      return lhs.EqualExceptCount(rhs) && lhs.count == rhs.count;
    }

    friend bool operator!=(const Entry& lhs, const Entry& rhs)
    {
      return !(lhs == rhs);
    }
  };

  Inventory& AddItem(uint32_t baseId, uint32_t count);
  Inventory& AddItems(const std::vector<Entry>& entries);
  Inventory& RemoveItems(const std::vector<Entry>& entries);

  // Own entries a client-described one stands for: exact extras (same worn state first), then the same item, then a plain copy for extras never recorded; empty if short
  std::vector<Entry> FindEntriesFor(const Entry& described) const;

  bool HasItem(uint32_t baseId) const;
  uint32_t GetItemCount(uint32_t baseId) const;
  uint32_t GetTotalItemCount() const;
  bool IsEmpty() const;

  std::vector<Entry> entries;

  friend bool operator==(const Inventory& lhs, const Inventory& rhs)
  {
    return lhs.entries == rhs.entries;
  }

  friend bool operator!=(const Inventory& lhs, const Inventory& rhs)
  {
    return !(lhs == rhs);
  }
};
