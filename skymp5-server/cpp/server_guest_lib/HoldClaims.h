#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace HoldClaims {

enum class Rank
{
  Outsider = 0,
  Jarl,
  Steward,
  Captain,
  CourtWizard,
  Thane,
  Housecarl,
  Guard,
  VillageElder,
  Lord,
  Citizen,
};

// What an interior cell is used for
enum class CellKind
{
  House,
  Dungeon,
  Cave,
};

// Skyrim lock difficulty
enum class LockLevel
{
  Unlocked = 0,
  Novice = 1,
  Apprentice = 2,
  Adept = 3,
  Expert = 4,
  Master = 5,
};

// The difficulty every claim lock is set to.
constexpr LockLevel kClaimLockLevel = LockLevel::Master;

const char* ToString(Rank rank) noexcept;
const char* ToString(CellKind kind) noexcept;
const char* ToString(LockLevel level) noexcept;

// Parses a rank id, case-insensitive, with a few aliases 
// Returns std::nullopt for anything unrecognised.
std::optional<Rank> RankFromString(const std::string& text);

// How many members a hold may hold at a rank. std::nullopt means unlimited.
// Jarl 1; Steward, Captain, Court Wizard 4; Thane, Village Elder 5; rest uncapped.
std::optional<int> RankCap(Rank rank) noexcept;

// True when a hold with `currentCount` members already at `rank` has room for one more.
bool CanAddMemberAtRank(Rank rank, int currentCount) noexcept;

// One row of the hold registry: an interior cell, the hold it belongs to, and what it is used for.
struct HoldCell
{
  uint32_t cellId = 0; // interior cell form id ("internal cell")
  std::string hold;    // hold id, e.g. "whiterun"
  CellKind kind = CellKind::House;
};

// The full registry of interior cells the gamemode knows about, grouped by hold.
const std::vector<HoldCell>& GetHoldCells();

// Looks up a single cell. Returns nullptr if the cell is not in the registry.
const HoldCell* FindCell(uint32_t cellId);

// Hold that owns a cell, or "" when the cell is unknown.
std::string HoldOfCell(uint32_t cellId);

// True only for House cells. Dungeons and caves are not claimable houses
bool IsClaimableHouse(uint32_t cellId);

bool IsCave(uint32_t cellId);

// Every claimable house in a hold (caves and dungeons excluded).
std::vector<HoldCell> GetHousesInHold(const std::string& hold);

bool CanAccess(Rank rank, CellKind kind, bool isOwner) noexcept;
bool CanLock(Rank rank, CellKind kind, bool isOwner) noexcept;
bool CanTransferOwnership(Rank rank, CellKind kind, bool isOwner) noexcept;
bool CanRevokeOwnership(Rank rank, CellKind kind, bool isOwner) noexcept;
bool CanAppoint(Rank appointer, Rank targetRank) noexcept;

class ClaimRegistry
{
public:
  // 0 is the "unowned" / "no profile" sentinel.
  static constexpr uint32_t kNoOwner = 0;

  // Registers containers to a house, so transfering house also does containers
  void RegisterContainer(uint32_t containerRefId, uint32_t houseCellId);

  void SetOwner(uint32_t refId, uint32_t ownerProfileId);
  uint32_t GetOwner(uint32_t refId) const;

  // Locking always uses Master difficulty (see kClaimLockLevel).
  void Lock(uint32_t refId);
  void Unlock(uint32_t refId);
  bool IsLocked(uint32_t refId) const;
  LockLevel GetLockLevel(uint32_t refId) const;

  int TransferHouse(uint32_t houseCellId, uint32_t newOwnerProfileId);

  // Revokes ownership of a house and its containers, leaving them unowned.
  // Returns how many references were cleared.
  int ReleaseHouse(uint32_t houseCellId);

private:
  std::unordered_map<uint32_t, uint32_t> owners; // refId -> profileId
  std::unordered_map<uint32_t, LockLevel> locks; // refId -> lock level
  std::unordered_map<uint32_t, std::unordered_set<uint32_t>>
    containersByHouse; // houseCellId -> refs
};

}
