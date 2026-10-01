#pragma once
#include <cstdint>
#include <nlohmann/json.hpp>
#include <optional>
#include <simdjson.h>
#include <string>
#include <tuple>
#include <type_traits>
#include <vector>

class BitStreamInputArchive;
class BitStreamOutputArchive;

class Inventory
{
public:
  // Archives without keys: their layout is what clients already built read
  template <class Archive>
  static constexpr bool kPositionalArchive =
    std::is_same_v<Archive, BitStreamInputArchive> ||
    std::is_same_v<Archive, BitStreamOutputArchive>;

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

  // Conditions of the entries, sent after the fields a client without them reads: nothing without one, read only when the message goes on
  template <class Archive>
  void SerializeConditionTail(Archive& archive)
  {
    if constexpr (std::is_same_v<Archive, BitStreamOutputArchive>) {
      uint32_t n = 0;
      for (auto& entry : entries) {
        n += entry.condition ? 1 : 0;
      }
      if (n == 0) {
        return;
      }
      archive.Serialize("n", n);
      for (uint32_t i = 0; i < entries.size(); ++i) {
        if (entries[i].condition) {
          uint32_t index = i;
          archive.Serialize("index", index)
            .Serialize("condition", *entries[i].condition);
        }
      }
    } else if constexpr (std::is_same_v<Archive, BitStreamInputArchive>) {
      constexpr uint32_t kCountBits = 32;
      constexpr uint32_t kPairBits = 64;
      if (archive.bs.GetNumberOfUnreadBits() < kCountBits + kPairBits) {
        return;
      }
      uint32_t n = 0;
      archive.Serialize("n", n);
      for (uint32_t k = 0;
           k < n && archive.bs.GetNumberOfUnreadBits() >= kPairBits; ++k) {
        uint32_t index = 0;
        float value = 1.f;
        archive.Serialize("index", index).Serialize("condition", value);
        if (index < entries.size()) {
          entries[index].condition = value;
        }
      }
    }
  }

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
      if constexpr (!kPositionalArchive<Archive>) {
        archive.Serialize("condition", condition);
      }
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
    // Durability of this copy, 0 (broken) to 1; absent is 100%
    std::optional<float> condition;
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

    // Same item as clients see it: charge, worn state, condition, float noise and names (except on named item bases) drift
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

  // Property keys always count as named; the gamemode adds the writing bases once the plugin is read
  static void SetNamedItemBases(const std::vector<uint32_t>& baseIds);
  static bool IsNamedItemBase(uint32_t baseId);

  // The "(<label>)" clients show after the name of a broken copy, read back by FindEntriesFor
  static void SetBrokenLabel(const std::string& label);
  static const std::string& GetBrokenLabel();

  Inventory& AddItem(uint32_t baseId, uint32_t count);
  Inventory& AddItems(const std::vector<Entry>& entries);
  Inventory& RemoveItems(const std::vector<Entry>& entries);

  // Own entries a client-described one stands for: exact extras (same worn state first), then the same item (copies closest to the percent tag of the described name first), then a plain copy for extras never recorded, then with anyExtras any copy of the base except named item bases; empty if short
  std::vector<Entry> FindEntriesFor(const Entry& described,
                                    bool anyExtras = false) const;

  bool HasItem(uint32_t baseId) const;
  uint32_t GetItemCount(uint32_t baseId) const;
  uint32_t GetTotalItemCount() const;
  size_t CountWorn() const;
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
