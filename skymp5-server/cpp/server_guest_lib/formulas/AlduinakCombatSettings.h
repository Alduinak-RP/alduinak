#pragma once
#include <array>
#include <cstdint>
#include <map>
#include <memory>
#include <nlohmann/json_fwd.hpp>
#include <optional>
#include <string>
#include <utility>
#include <vector>

namespace ItemRows {

enum class WeaponType : uint8_t
{
  None,
  Dagger,
  Sword,
  WarAxe,
  Mace,
  Greatsword,
  Battleaxe,
  Warhammer,
  Bow,
  Crossbow,
  Unarmed,
  Staff,
  Count
};

enum class ArmorClass : uint8_t
{
  None,
  Light,
  Heavy,
  Clothing
};

// Armor slot groups of slotShare and slotBipeds
enum class SlotBucket : uint8_t
{
  Cuirass,
  Helmet,
  Gauntlets,
  Boots,
  Shield,
  Count
};

inline constexpr size_t kNumWeaponTypes =
  static_cast<size_t>(WeaponType::Count);
inline constexpr size_t kNumSlotBuckets =
  static_cast<size_t>(SlotBucket::Count);
inline constexpr size_t kNumShareBuckets =
  static_cast<size_t>(SlotBucket::Shield);

// Settings key of a weapon type, "" for None
const char* WeaponTypeName(WeaponType type) noexcept;
// None for a name weaponTypes does not know
WeaponType WeaponTypeFromName(const std::string& name) noexcept;
const char* SlotBucketName(SlotBucket bucket) noexcept;
const char* ArmorClassName(ArmorClass cls) noexcept;
bool IsMeleeType(WeaponType type) noexcept;

}

// The parsed alduinakDamageFormulaSettings block of server-settings.json
struct AlduinakCombatSettings
{
  struct WeaponTypeRow
  {
    float speed = 1.f;
    int hands = 1;
    float dmgMult = 1.f;
    float critChance = 0.f;
    float critMult = 1.5f;
    float penetration = 0.f;
    float powerMult = 2.f;
    float sneakMult = 1.5f;
    float floor = 0.2f;
    bool autoCritOnSneak = false;
  };

  struct WeaponRow
  {
    float base = 0.f;
    float penetration = 0.f;
    float critChance = 0.f;
  };

  struct BowRow
  {
    float base = 0.f;
    float speed = 1.f;
  };

  struct CrossbowRow
  {
    float base = 0.f;
  };

  struct ArmorRow
  {
    ItemRows::ArmorClass cls = ItemRows::ArmorClass::Light;
    float setDT = 0.f;
    // Takes the place of setDT x shieldShare for a shield of this row
    std::optional<float> shieldDT;
  };

  struct RaceOverride
  {
    std::string weaponRow;
    ItemRows::WeaponType type = ItemRows::WeaponType::Dagger;
  };

  struct Durability
  {
    bool enabled = false;
    std::map<std::string, float> weaponHP, bowHP, crossbowHP, armorSetHP;
    float shieldHPShare = 0.8f;
    float fallbackWeaponHP = 250.f;
    float fallbackArmorSetHP = 300.f;

    struct Wear
    {
      float landedHit = 1.f;
      float powerExtra = 1.f;
      float parriedHit = 1.f;
      float bash = 1.f;
      float bowHit = 1.f;
      float shieldBlock = 1.f;
      float armorHit = 1.f;
      float armorMinPreDT = 8.f;
    } wear;

    struct Effect
    {
      float kneeCondition = 0.5f;
      float effectAtZero = 0.75f;
      float brokenWeaponMult = 0.25f;
      float brokenArmorDT = 0.f;
      float brokenBlockPass = 0.5f;
    } effect;

    float flushMinSeconds = 5.f;
    float flushCalmSeconds = 10.f;
    bool npcGearWears = false;
    // Form keys ("<hex id>:<plugin>") of bases that never wear
    std::vector<std::string> exempt;
    float deathWear = 0.f;
    bool nameTagShowAtFull = true;
    std::string nameTagBrokenLabel = "Broken";

    struct Repair
    {
      float unitsPerMissingWeapon = 0.5f;
      float unitsPerMissingCuirass = 0.5f;
      float unitsPerMissingOther = 1.f;
      bool requireProfessionRank = false;
      float fatigue = 0.f;
      bool anyBench = false;
      bool menuOnActivate = true;
      // Empty for no chat command
      std::string chatCommand = "repair";
      float lowNoticeBelow = 0.25f;
      // Kind ("weapon", "bow", "crossbow", "armor"), then row, then form key
      std::map<std::string, std::map<std::string, std::string>>
        fallbackMaterial;
    } repair;
  };

  std::string source;
  bool enabled = false;
  float floor = 0.2f;
  float minDamage = 0.5f;
  float critDTMult = 0.5f;
  float powerMult = 2.f;
  float npcNaturalPowerMult = 1.25f;
  float bashMult = 0.3f;
  float playerHitCap = 45.f;
  float shieldShare = 0.06f;
  float lightItemHeavyRowFactor = 0.7f;
  float speedNormMin = 0.4f;
  float speedNormMax = 1.f;
  float rateLimitFactor = 0.888f;
  float quickShotDrawMult = 0.7f;
  float crossbowReload = 1.9f;
  float poisonFloor = 0.5f;
  float healthSnap = 0.00011f;

  float sneakMinSneakSeconds = 1.f;
  float sneakTargetCalmSeconds = 10.f;
  // Kept as written, may be empty
  std::string sneakCalmRuleTargets = "players";

  float powerEventWindowSeconds = 1.6f;
  float powerMinIntervalSeconds = 1.5f;
  float powerSplashWindowSeconds = 0.1f;
  bool powerLogOnly = true;

  // Read by ScampServer.cpp into WorldState::effectModifiers, kept for the boot report
  bool effectModifiers = true;

  float temperingWeaponPerStep = 0.015f;
  float temperingArmorPerStep = 0.015f;

  // Indexed by ItemRows::WeaponType
  std::array<WeaponTypeRow, ItemRows::kNumWeaponTypes> weaponTypes;
  std::map<std::string, WeaponRow> weapons;
  std::string dummyRow = "Dummy";
  std::map<std::string, BowRow> bows;
  std::map<std::string, std::string> bowRowForMaterial;
  std::map<std::string, CrossbowRow> crossbows;

  float arrowScale = 0.25f;
  float arrowZero = 8.f;
  float arrowMax = 4.f;

  float unarmedBase = 5.f;
  float unarmedPenetration = 0.5f;
  float unarmedFloor = 0.5f;
  float unarmedCritChance = 0.05f;
  float unarmedCritMult = 1.5f;
  // Race editor id to the weapon row and type its fists count as
  std::map<std::string, RaceOverride> raceOverride;

  std::map<std::string, ArmorRow> armor;
  // Indexed by ItemRows::SlotBucket, the shield has no share
  std::array<float, ItemRows::kNumShareBuckets> slotShare = { 0.6f, 0.15f,
                                                              0.125f, 0.125f };
  // Biped flags (bit n is slot 30 + n) per ItemRows::SlotBucket
  std::array<uint32_t, ItemRows::kNumSlotBuckets> slotMasks = {
    1u << 2, (1u << 0) | (1u << 1) | (1u << 11) | (1u << 12) | (1u << 13),
    1u << 3, 1u << 7, 1u << 9
  };

  // Keyword editor id and row, first match in list order wins
  std::vector<std::pair<std::string, std::string>> weaponKeywords;
  std::vector<std::pair<std::string, std::string>> armorKeywords;
  std::vector<std::pair<std::string, std::string>> aldCatMat;
  int multiIAKFallback = 3;

  std::string fallbackWeaponRow;
  std::string fallbackBowRow;
  std::string fallbackCrossbowRow;
  std::string fallbackArmorLightRow;
  std::string fallbackArmorHeavyRow;
  std::string fallbackShieldRow;

  // Form key ("<hex id>:<plugin>") to row, template variants included
  std::map<std::string, std::string> overrides;

  float npcPlayerToNpcMult = 1.f;
  bool npcNaturalCapBeforeDT = true;
  float npcNaturalFloor = 0.3f;
  bool npcNaturalCanCrit = false;
  bool npcHumanoidCanCrit = true;
  float npcCritterMaxDamage = 20.f;
  float npcCritterPenetration = 0.5f;
  float npcOtherPenetration = 0.f;
  // RACE form key to the natural DT of that creature
  std::map<std::string, float> naturalDT;

  float blockStaminaPerArmorWeight = 0.006f;
  float blockStaminaWeightCap = 115.f;

  Durability durability;

  [[nodiscard]] const WeaponTypeRow& TypeRow(
    ItemRows::WeaponType type) const noexcept
  {
    return weaponTypes[static_cast<size_t>(type)];
  }

  // Null with at least one problem; warnings never reject the block
  static std::shared_ptr<const AlduinakCombatSettings> FromJson(
    const nlohmann::json& block, std::vector<std::string>& problems,
    std::vector<std::string>& warnings);

  // One line with the table sizes for the boot report
  [[nodiscard]] std::string Summary() const;
};
