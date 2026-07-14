#include "HoldClaims.h"

#include <algorithm>
#include <cctype>

namespace {

std::string ToLower(const std::string& text)
{
  std::string out = text;
  std::transform(out.begin(), out.end(), out.begin(),
                 [](unsigned char c) { return std::tolower(c); });
  return out;
}

bool HasHouseAuthority(HoldClaims::Rank rank)
{
  return rank == HoldClaims::Rank::Jarl || rank == HoldClaims::Rank::Steward;
}

bool HasDungeonAuthority(HoldClaims::Rank rank)
{
  using R = HoldClaims::Rank;
  return rank == R::Jarl || rank == R::Captain || rank == R::Thane ||
    rank == R::Housecarl || rank == R::Guard;
}

}

const char* HoldClaims::ToString(Rank rank) noexcept
{
  switch (rank) {
    case Rank::Outsider:
      return "outsider";
    case Rank::Jarl:
      return "jarl";
    case Rank::Steward:
      return "steward";
    case Rank::Captain:
      return "captain";
    case Rank::CourtWizard:
      return "courtwizard";
    case Rank::Thane:
      return "thane";
    case Rank::Housecarl:
      return "housecarl";
    case Rank::VillageElder:
      return "villageelder";
    case Rank::Guard:
      return "guard";
    case Rank::Lord:
      return "lord";
    case Rank::Citizen:
      return "citizen";
  }
  return "outsider";
}

const char* HoldClaims::ToString(CellKind kind) noexcept
{
  switch (kind) {
    case CellKind::House:
      return "house";
    case CellKind::Dungeon:
      return "dungeon";
    case CellKind::Cave:
      return "cave";
  }
  return "house";
}

const char* HoldClaims::ToString(LockLevel level) noexcept
{
  switch (level) {
    case LockLevel::Unlocked:
      return "unlocked";
    case LockLevel::Novice:
      return "novice";
    case LockLevel::Apprentice:
      return "apprentice";
    case LockLevel::Adept:
      return "adept";
    case LockLevel::Expert:
      return "expert";
    case LockLevel::Master:
      return "master";
  }
  return "unlocked";
}

std::optional<HoldClaims::Rank> HoldClaims::RankFromString(
  const std::string& text)
{
  const std::string lower = ToLower(text);
  if (lower == "jarl") {
    return Rank::Jarl;
  }
  if (lower == "steward") {
    return Rank::Steward;
  }
  if (lower == "captain") {
    return Rank::Captain;
  }
  if (lower == "courtwizard" || lower == "court_wizard" || lower == "wizard") {
    return Rank::CourtWizard;
  }
  if (lower == "thane") {
    return Rank::Thane;
  }
  if (lower == "housecarl") {
    return Rank::Housecarl;
  }
  if (lower == "villageelder" || lower == "village_elder" ||
      lower == "elder") {
    return Rank::VillageElder;
  }
  if (lower == "guard") {
    return Rank::Guard;
  }
  if (lower == "lord" || lower == "lady" || lower == "lordlady") {
    return Rank::Lord;
  }
  if (lower == "citizen") {
    return Rank::Citizen;
  }
  if (lower == "outsider") {
    return Rank::Outsider;
  }
  return std::nullopt;
}

std::optional<int> HoldClaims::RankCap(Rank rank) noexcept
{
  switch (rank) {
    case Rank::Jarl:
      return 1;
    case Rank::Steward:
    case Rank::Captain:
    case Rank::CourtWizard:
      return 4;
    case Rank::Thane:
    case Rank::VillageElder:
      return 5;
    case Rank::Outsider:
    case Rank::Housecarl:
    case Rank::Guard:
    case Rank::Lord:
    case Rank::Citizen:
      return std::nullopt; // unlimited
  }
  return std::nullopt;
}

bool HoldClaims::CanAddMemberAtRank(Rank rank, int currentCount) noexcept
{
  const std::optional<int> cap = RankCap(rank);
  if (!cap.has_value()) {
    return true; // unlimited
  }
  return currentCount < *cap;
}

const std::vector<HoldClaims::HoldCell>& HoldClaims::GetHoldCells()
{
  // Interior cell form ids grouped by hold.
  // Caves are listed only so the registry can explicitly exclude them
  static const std::vector<HoldCell> kCells = {
    // Whiterun (no cave entry: 0x1A26F is the WhiterunWorld worldspace id)
    { 0x000165A8, "whiterun", CellKind::House },   // Breezehome
    { 0x0001B131, "whiterun", CellKind::Dungeon }, // Dragonsreach Dungeon

    // Eastmarch
    { 0x0003480E, "eastmarch", CellKind::House },   // Hjerim
    { 0x000D7B12, "eastmarch", CellKind::Dungeon }, // Windhelm Barracks jail

    // Rift
    { 0x000C9F1A, "rift", CellKind::House },   // Honeyside
    { 0x0008BFE6, "rift", CellKind::Dungeon }, // Riften Jail
    { 0x0002C401, "rift", CellKind::Cave },    // (excluded) cave

    // Reach
    { 0x00017013, "reach", CellKind::House },   // Vlindrel Hall
    { 0x00018B22, "reach", CellKind::Dungeon }, // Markarth Hall of Justice

    // Haafingar
    { 0x000165A0, "haafingar", CellKind::House },   // Proudspire Manor
    { 0x000136C9, "haafingar", CellKind::Dungeon }, // Castle Dour Dungeon

    // Pale
    { 0x0301AB54, "pale", CellKind::House },   // Heljarchen Hall
    { 0x0001620B, "pale", CellKind::Dungeon }, // Dawnstar jail

    // Falkreath
    { 0x0300307B, "falkreath", CellKind::House },   // Lakeview Manor
    { 0x000FA3D9, "falkreath", CellKind::Dungeon }, // Falkreath jail
    { 0x0004FA42, "falkreath", CellKind::Cave },    // (excluded) cave

    // Hjaalmarch
    { 0x0300307E, "hjaalmarch", CellKind::House },   // Windstad Manor
    { 0x00038A92, "hjaalmarch", CellKind::Dungeon }, // Morthal jail

    // Winterhold
    { 0x0001E7E0, "winterhold", CellKind::House },   // College quarters
    { 0x0001E7E2, "winterhold", CellKind::Dungeon }, // Winterhold jail
  };
  return kCells;
}

const HoldClaims::HoldCell* HoldClaims::FindCell(uint32_t cellId)
{
  const auto& cells = GetHoldCells();
  for (const auto& cell : cells) {
    if (cell.cellId == cellId) {
      return &cell;
    }
  }
  return nullptr;
}

std::string HoldClaims::HoldOfCell(uint32_t cellId)
{
  const HoldCell* cell = FindCell(cellId);
  return cell ? cell->hold : std::string();
}

bool HoldClaims::IsClaimableHouse(uint32_t cellId)
{
  const HoldCell* cell = FindCell(cellId);
  return cell && cell->kind == CellKind::House;
}

bool HoldClaims::IsCave(uint32_t cellId)
{
  const HoldCell* cell = FindCell(cellId);
  return cell && cell->kind == CellKind::Cave;
}

std::vector<HoldClaims::HoldCell> HoldClaims::GetHousesInHold(
  const std::string& hold)
{
  std::vector<HoldCell> houses;
  for (const auto& cell : GetHoldCells()) {
    if (cell.kind == CellKind::House && cell.hold == hold) {
      houses.push_back(cell);
    }
  }
  return houses;
}

bool HoldClaims::CanAccess(Rank rank, CellKind kind, bool isOwner) noexcept
{
  // You can always reach what you personally own.
  if (isOwner) {
    return true;
  }
  switch (kind) {
    case CellKind::House:
      // Housing is the Steward's and Jarl's to manage.
      return HasHouseAuthority(rank);
    case CellKind::Dungeon:
      // The dungeon belongs to the martial chain.
      return HasDungeonAuthority(rank);
    case CellKind::Cave:
      return false;
  }
  return false;
}

bool HoldClaims::CanLock(Rank rank, CellKind kind, bool isOwner) noexcept
{
  if (isOwner) {
    return true;
  }
  switch (kind) {
    case CellKind::House:
      return HasHouseAuthority(rank);
    case CellKind::Dungeon:
      return HasDungeonAuthority(rank);
    case CellKind::Cave:
      return false;
  }
  return false;
}

bool HoldClaims::CanTransferOwnership(Rank rank, CellKind kind,
                                      bool isOwner) noexcept
{
  if (kind == CellKind::Cave) {
    return false;
  }
  if (isOwner) {
    return true;
  }
  if (rank == Rank::Jarl) {
    return true;
  }
  if (rank == Rank::Steward) {
    return kind == CellKind::House;
  }
  return false;
}

bool HoldClaims::CanRevokeOwnership(Rank rank, CellKind kind,
                                    bool isOwner) noexcept
{
  return CanTransferOwnership(rank, kind, isOwner);
}

bool HoldClaims::CanAppoint(Rank appointer, Rank targetRank) noexcept
{
  if (targetRank == Rank::Outsider || targetRank == Rank::Jarl) {
    return false;
  }
  switch (appointer) {
    case Rank::Jarl:
      return true;
    case Rank::Steward:
      return targetRank == Rank::Lord || targetRank == Rank::Citizen;
    case Rank::Captain:
      return targetRank == Rank::Guard;
    case Rank::Thane:
      return targetRank == Rank::Housecarl || targetRank == Rank::Guard ||
        targetRank == Rank::VillageElder || targetRank == Rank::Lord ||
        targetRank == Rank::Citizen;
    case Rank::Housecarl:
      return targetRank == Rank::Guard;
    case Rank::VillageElder:
      return targetRank == Rank::Lord || targetRank == Rank::Citizen;
    case Rank::Lord:
      return targetRank == Rank::Citizen;
    case Rank::CourtWizard:
    case Rank::Guard:
    case Rank::Citizen:
    case Rank::Outsider:
      return false;
  }
  return false;
}

void HoldClaims::ClaimRegistry::RegisterContainer(uint32_t containerRefId,
                                                  uint32_t houseCellId)
{
  containersByHouse[houseCellId].insert(containerRefId);
}

void HoldClaims::ClaimRegistry::SetOwner(uint32_t refId,
                                         uint32_t ownerProfileId)
{
  if (ownerProfileId == kNoOwner) {
    owners.erase(refId);
  } else {
    owners[refId] = ownerProfileId;
  }
}

uint32_t HoldClaims::ClaimRegistry::GetOwner(uint32_t refId) const
{
  auto it = owners.find(refId);
  return it == owners.end() ? kNoOwner : it->second;
}

void HoldClaims::ClaimRegistry::Lock(uint32_t refId)
{
  locks[refId] = kClaimLockLevel;
}

void HoldClaims::ClaimRegistry::Unlock(uint32_t refId)
{
  locks[refId] = LockLevel::Unlocked;
}

bool HoldClaims::ClaimRegistry::IsLocked(uint32_t refId) const
{
  auto it = locks.find(refId);
  return it != locks.end() && it->second != LockLevel::Unlocked;
}

HoldClaims::LockLevel HoldClaims::ClaimRegistry::GetLockLevel(
  uint32_t refId) const
{
  auto it = locks.find(refId);
  return it == locks.end() ? LockLevel::Unlocked : it->second;
}

int HoldClaims::ClaimRegistry::TransferHouse(uint32_t houseCellId,
                                             uint32_t newOwnerProfileId)
{
  int changed = 0;

  // The house cell itself.
  if (GetOwner(houseCellId) != newOwnerProfileId) {
    ++changed;
  }
  SetOwner(houseCellId, newOwnerProfileId);

  // Every container registered inside the house follows the house.
  auto it = containersByHouse.find(houseCellId);
  if (it != containersByHouse.end()) {
    for (uint32_t containerRefId : it->second) {
      if (GetOwner(containerRefId) != newOwnerProfileId) {
        ++changed;
      }
      SetOwner(containerRefId, newOwnerProfileId);
    }
  }

  return changed;
}

int HoldClaims::ClaimRegistry::ReleaseHouse(uint32_t houseCellId)
{
  // Releasing is a transfer back to "unowned"
  int cleared = 0;

  if (GetOwner(houseCellId) != kNoOwner) {
    ++cleared;
  }
  SetOwner(houseCellId, kNoOwner);

  auto it = containersByHouse.find(houseCellId);
  if (it != containersByHouse.end()) {
    for (uint32_t containerRefId : it->second) {
      if (GetOwner(containerRefId) != kNoOwner) {
        ++cleared;
      }
      SetOwner(containerRefId, kNoOwner);
    }
  }

  return cleared;
}
