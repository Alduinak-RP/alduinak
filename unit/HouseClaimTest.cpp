#include "HoldClaims.h"
#include <catch2/catch_all.hpp>

using namespace HoldClaims;

// Cell registry: houses identified by interior cell, caves excluded

TEST_CASE("Houses are identified by their interior cell", "[HouseClaim]")
{
  const uint32_t breezehome = 0x000165A8;
  REQUIRE(IsClaimableHouse(breezehome));
  REQUIRE(HoldOfCell(breezehome) == "whiterun");

  const HoldCell* cell = FindCell(breezehome);
  REQUIRE(cell != nullptr);
  REQUIRE(cell->kind == CellKind::House);

  // An unknown form id belongs to no hold and is not claimable.
  REQUIRE(FindCell(0xDEADBEEF) == nullptr);
  REQUIRE_FALSE(IsClaimableHouse(0xDEADBEEF));
  REQUIRE(HoldOfCell(0xDEADBEEF).empty());
}

TEST_CASE("Caves are excluded from the claimable house list", "[HouseClaim]")
{
  bool foundCave = false;
  for (const auto& cell : GetHoldCells()) {
    if (cell.kind == CellKind::Cave) {
      foundCave = true;
      // A cave is never a claimable house
      REQUIRE(IsCave(cell.cellId));
      REQUIRE_FALSE(IsClaimableHouse(cell.cellId));
      for (const auto& house : GetHousesInHold(cell.hold)) {
        REQUIRE(house.cellId != cell.cellId);
        REQUIRE(house.kind == CellKind::House);
      }
    }
  }
  REQUIRE(foundCave);
}

TEST_CASE("Every hold's house list contains only houses", "[HouseClaim]")
{
  const char* holds[] = { "whiterun",  "eastmarch",  "rift",
                          "reach",     "haafingar",  "pale",
                          "falkreath", "hjaalmarch", "winterhold" };
  for (const char* hold : holds) {
    auto houses = GetHousesInHold(hold);
    REQUIRE_FALSE(houses.empty());
    for (const auto& house : houses) {
      REQUIRE(house.hold == hold);
      REQUIRE(house.kind == CellKind::House);
    }
  }
}

TEST_CASE("Every rank round-trips through its string id", "[HouseClaim]")
{
  const Rank ranks[] = { Rank::Jarl,         Rank::Steward, Rank::Captain,
                         Rank::CourtWizard,  Rank::Thane,   Rank::Housecarl,
                         Rank::VillageElder, Rank::Guard,   Rank::Lord,
                         Rank::Citizen };
  for (Rank rank : ranks) {
    auto parsed = RankFromString(ToString(rank));
    REQUIRE(parsed.has_value());
    REQUIRE(*parsed == rank);
  }

  // A few convenience aliases the gamemode may receive.
  REQUIRE(RankFromString("Lady") == Rank::Lord);
  REQUIRE(RankFromString("elder") == Rank::VillageElder);
  REQUIRE(RankFromString("wizard") == Rank::CourtWizard);
  REQUIRE_FALSE(RankFromString("emperor").has_value());
}

TEST_CASE("Hold seat caps: 1 Jarl, 4 Stewards/Captains/Wizards, 5 Thanes/Elders",
          "[HouseClaim]")
{
  REQUIRE(RankCap(Rank::Jarl) == 1);
  REQUIRE(RankCap(Rank::Steward) == 4);
  REQUIRE(RankCap(Rank::Captain) == 4);
  REQUIRE(RankCap(Rank::CourtWizard) == 4);
  REQUIRE(RankCap(Rank::Thane) == 5);
  REQUIRE(RankCap(Rank::VillageElder) == 5);

  // The rest are uncapped.
  REQUIRE_FALSE(RankCap(Rank::Housecarl).has_value());
  REQUIRE_FALSE(RankCap(Rank::Guard).has_value());
  REQUIRE_FALSE(RankCap(Rank::Lord).has_value());
  REQUIRE_FALSE(RankCap(Rank::Citizen).has_value());

  // A hold that already has its single Jarl / four stewards is full.
  REQUIRE_FALSE(CanAddMemberAtRank(Rank::Jarl, 1));
  REQUIRE(CanAddMemberAtRank(Rank::Steward, 3));
  REQUIRE_FALSE(CanAddMemberAtRank(Rank::Steward, 4));
  REQUIRE_FALSE(CanAddMemberAtRank(Rank::Captain, 4));
  REQUIRE(CanAddMemberAtRank(Rank::Thane, 4));
  REQUIRE_FALSE(CanAddMemberAtRank(Rank::Thane, 5));
  REQUIRE_FALSE(CanAddMemberAtRank(Rank::VillageElder, 5));
  // Uncapped ranks always have room.
  REQUIRE(CanAddMemberAtRank(Rank::Guard, 999));
}

TEST_CASE("A Jarl has full power over every door and container in the hold",
          "[HouseClaim]")
{
  REQUIRE(CanAccess(Rank::Jarl, CellKind::House, false));
  REQUIRE(CanAccess(Rank::Jarl, CellKind::Dungeon, false));
  REQUIRE(CanLock(Rank::Jarl, CellKind::House, false));
  REQUIRE(CanLock(Rank::Jarl, CellKind::Dungeon, false));
  REQUIRE(CanTransferOwnership(Rank::Jarl, CellKind::House, false));
  REQUIRE(CanTransferOwnership(Rank::Jarl, CellKind::Dungeon, false));
  REQUIRE(CanRevokeOwnership(Rank::Jarl, CellKind::House, false));

  const Rank everyoneBelow[] = { Rank::Steward,     Rank::Captain,
                                 Rank::CourtWizard, Rank::Thane,
                                 Rank::Housecarl,   Rank::VillageElder,
                                 Rank::Guard,       Rank::Lord,
                                 Rank::Citizen };
  for (Rank target : everyoneBelow) {
    REQUIRE(CanAppoint(Rank::Jarl, target));
  }
  REQUIRE_FALSE(CanAppoint(Rank::Jarl, Rank::Jarl));
}

TEST_CASE("Stewards run housing and hire nobles and citizens", "[HouseClaim]")
{
  // Housing authority: access, lock, transfer and reclaim buildings.
  REQUIRE(CanAccess(Rank::Steward, CellKind::House, false));
  REQUIRE(CanLock(Rank::Steward, CellKind::House, false));
  REQUIRE(CanTransferOwnership(Rank::Steward, CellKind::House, false));
  REQUIRE(CanRevokeOwnership(Rank::Steward, CellKind::House, false));
  
  REQUIRE_FALSE(CanAccess(Rank::Steward, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanLock(Rank::Steward, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanTransferOwnership(Rank::Steward, CellKind::Dungeon, false));

  REQUIRE(CanAppoint(Rank::Steward, Rank::Lord));
  REQUIRE(CanAppoint(Rank::Steward, Rank::Citizen));

  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Housecarl));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::CourtWizard));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::VillageElder));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Guard));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Captain));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Thane));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Steward));
  REQUIRE_FALSE(CanAppoint(Rank::Steward, Rank::Jarl));
}

TEST_CASE("Captains run the dungeon and hire guards", "[HouseClaim]")
{
  REQUIRE(CanAccess(Rank::Captain, CellKind::Dungeon, false));
  REQUIRE(CanLock(Rank::Captain, CellKind::Dungeon, false));

  REQUIRE_FALSE(CanAccess(Rank::Captain, CellKind::House, false));
  REQUIRE_FALSE(CanTransferOwnership(Rank::Captain, CellKind::House, false));

  REQUIRE(CanAppoint(Rank::Captain, Rank::Guard));

  REQUIRE_FALSE(CanAppoint(Rank::Captain, Rank::Housecarl));
  REQUIRE_FALSE(CanAppoint(Rank::Captain, Rank::Thane));
  REQUIRE_FALSE(CanAppoint(Rank::Captain, Rank::Citizen));
}

TEST_CASE("Thanes rule locally: dungeon access and a broad hiring reach",
          "[HouseClaim]")
{
  REQUIRE(CanAccess(Rank::Thane, CellKind::Dungeon, false));

  REQUIRE_FALSE(CanAccess(Rank::Thane, CellKind::House, false));
  REQUIRE_FALSE(CanTransferOwnership(Rank::Thane, CellKind::House, false));

  REQUIRE(CanAppoint(Rank::Thane, Rank::Housecarl));
  REQUIRE(CanAppoint(Rank::Thane, Rank::VillageElder));
  REQUIRE(CanAppoint(Rank::Thane, Rank::Lord));
  REQUIRE(CanAppoint(Rank::Thane, Rank::Citizen));
  REQUIRE(CanAppoint(Rank::Thane, Rank::Guard));
  
  REQUIRE_FALSE(CanAppoint(Rank::Thane, Rank::Captain));
  REQUIRE_FALSE(CanAppoint(Rank::Thane, Rank::Steward));
  REQUIRE_FALSE(CanAppoint(Rank::Thane, Rank::CourtWizard));
}

TEST_CASE("Housecarls are local captains who raise guards", "[HouseClaim]")
{
  REQUIRE(CanAccess(Rank::Housecarl, CellKind::Dungeon, false));
  REQUIRE(CanAppoint(Rank::Housecarl, Rank::Guard));
  REQUIRE_FALSE(CanAppoint(Rank::Housecarl, Rank::Housecarl));
  REQUIRE_FALSE(CanAppoint(Rank::Housecarl, Rank::Citizen));
}

TEST_CASE("Village elders are mayors who enroll citizens and lords",
          "[HouseClaim]")
{
  REQUIRE(CanAppoint(Rank::VillageElder, Rank::Citizen));
  REQUIRE(CanAppoint(Rank::VillageElder, Rank::Lord));
  
  REQUIRE_FALSE(CanAppoint(Rank::VillageElder, Rank::Guard));
  REQUIRE_FALSE(CanAccess(Rank::VillageElder, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanAccess(Rank::VillageElder, CellKind::House, false));
}

TEST_CASE("Nobles enroll citizens", "[HouseClaim]")
{
  REQUIRE(CanAppoint(Rank::Lord, Rank::Citizen));

  REQUIRE_FALSE(CanAppoint(Rank::Lord, Rank::Lord));
  REQUIRE_FALSE(CanAppoint(Rank::Lord, Rank::Guard));
  REQUIRE_FALSE(CanAccess(Rank::Lord, CellKind::House, false));
}

TEST_CASE("Court wizards, guards and citizens appoint no one", "[HouseClaim]")
{
  const Rank noAuthority[] = { Rank::CourtWizard, Rank::Guard, Rank::Citizen };
  const Rank anyTarget[] = { Rank::Guard, Rank::Citizen, Rank::Housecarl,
                             Rank::Lord };
  for (Rank who : noAuthority) {
    for (Rank target : anyTarget) {
      REQUIRE_FALSE(CanAppoint(who, target));
    }
  }

  REQUIRE(CanAccess(Rank::Guard, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanAccess(Rank::CourtWizard, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanAccess(Rank::Lord, CellKind::Dungeon, false));
  REQUIRE_FALSE(CanAccess(Rank::Citizen, CellKind::Dungeon, false));
}

TEST_CASE("Any owner can transfer and reclaim their own building",
          "[HouseClaim]")
{
  // Even a plain citizen who owns a house can give it away or take it back.
  REQUIRE(CanTransferOwnership(Rank::Citizen, CellKind::House, true));
  REQUIRE(CanRevokeOwnership(Rank::Citizen, CellKind::House, true));
  REQUIRE(CanAccess(Rank::Citizen, CellKind::House, true));
  REQUIRE(CanLock(Rank::Citizen, CellKind::House, true));

  // A Thane or Elder reclaims a building they own
  REQUIRE(CanRevokeOwnership(Rank::Thane, CellKind::House, true));
  REQUIRE(CanRevokeOwnership(Rank::VillageElder, CellKind::House, true));
  REQUIRE_FALSE(CanRevokeOwnership(Rank::Thane, CellKind::House, false));
  REQUIRE_FALSE(
    CanRevokeOwnership(Rank::VillageElder, CellKind::House, false));
}

TEST_CASE("The Steward -> Thane -> Elder -> Citizen grant chain",
          "[HouseClaim]")
{
  // The Steward hands a building to a Thane by rank authority.
  REQUIRE(CanTransferOwnership(Rank::Steward, CellKind::House, false));
  // The Thane, now the owner, can pass it down to an Elder.
  REQUIRE(CanTransferOwnership(Rank::Thane, CellKind::House, true));
  // The Elder, now the owner, can pass it to a citizen — or reclaim it.
  REQUIRE(CanTransferOwnership(Rank::VillageElder, CellKind::House, true));
  REQUIRE(CanRevokeOwnership(Rank::VillageElder, CellKind::House, true));
  // Someone with neither ownership nor rank authority cannot.
  REQUIRE_FALSE(CanTransferOwnership(Rank::Citizen, CellKind::House, false));
}

// Cross-hold authority

TEST_CASE("A Jarl's authority does not cross into another hold",
          "[HouseClaim]")
{
  // Callers resolve the requester's rank against the target cell's hold.
  const uint32_t whiterunHouse = 0x000165A8; // Breezehome
  const uint32_t riftenHouse = 0x000C9F1A;   // Honeyside
  REQUIRE(HoldOfCell(whiterunHouse) != HoldOfCell(riftenHouse));

  const Rank rankInRiften = Rank::Outsider; // not a member of the Rift
  REQUIRE_FALSE(CanAccess(rankInRiften, CellKind::House, false));
  REQUIRE_FALSE(CanTransferOwnership(rankInRiften, CellKind::House, false));
}

// Locks are always Master difficulty

TEST_CASE("Claim locks are Master difficulty", "[HouseClaim]")
{
  REQUIRE(kClaimLockLevel == LockLevel::Master);

  ClaimRegistry registry;
  const uint32_t door = 0x000165A8;

  REQUIRE_FALSE(registry.IsLocked(door));
  REQUIRE(registry.GetLockLevel(door) == LockLevel::Unlocked);

  registry.Lock(door);
  REQUIRE(registry.IsLocked(door));
  REQUIRE(registry.GetLockLevel(door) == LockLevel::Master);

  registry.Unlock(door);
  REQUIRE_FALSE(registry.IsLocked(door));
  REQUIRE(registry.GetLockLevel(door) == LockLevel::Unlocked);
}

// Transferring / releasing a house carries its containers

TEST_CASE("Transferring a house transfers every container inside it",
          "[HouseClaim]")
{
  ClaimRegistry registry;

  const uint32_t house = 0x000165A8;     // Breezehome cell
  const uint32_t chest = 0x0A000001;     // a container inside Breezehome
  const uint32_t cupboard = 0x0A000002;  // another container inside it
  const uint32_t strongbox = 0x0B000099; // a container in a *different* house

  const uint32_t jarl = 1001;
  const uint32_t newOwner = 2002;

  registry.RegisterContainer(chest, house);
  registry.RegisterContainer(cupboard, house);
  registry.RegisterContainer(strongbox, 0x000C9F1A); // Honeyside, untouched

  // Jarl owns everything to start with.
  registry.SetOwner(house, jarl);
  registry.SetOwner(chest, jarl);
  registry.SetOwner(cupboard, jarl);
  registry.SetOwner(strongbox, jarl);

  // House + 2 containers change hands; the unrelated strongbox does not.
  const int changed = registry.TransferHouse(house, newOwner);
  REQUIRE(changed == 3);

  REQUIRE(registry.GetOwner(house) == newOwner);
  REQUIRE(registry.GetOwner(chest) == newOwner);
  REQUIRE(registry.GetOwner(cupboard) == newOwner);
  REQUIRE(registry.GetOwner(strongbox) == jarl);
}

TEST_CASE("Releasing a house clears the house and its containers",
          "[HouseClaim]")
{
  ClaimRegistry registry;
  const uint32_t house = 0x00017013; // Vlindrel Hall
  const uint32_t chest = 0x0C000001;
  const uint32_t owner = 55;

  registry.RegisterContainer(chest, house);
  registry.SetOwner(house, owner);
  registry.SetOwner(chest, owner);

  // Reclaiming to unowned clears the house and its container.
  REQUIRE(registry.ReleaseHouse(house) == 2);
  REQUIRE(registry.GetOwner(house) == ClaimRegistry::kNoOwner);
  REQUIRE(registry.GetOwner(chest) == ClaimRegistry::kNoOwner);
}

TEST_CASE("Transferring an already-owned house is idempotent", "[HouseClaim]")
{
  ClaimRegistry registry;
  const uint32_t house = 0x00017013; // Vlindrel Hall
  const uint32_t owner = 7;

  registry.SetOwner(house, owner);
  // Nobody new takes it, so nothing changes hands.
  REQUIRE(registry.TransferHouse(house, owner) == 0);
  REQUIRE(registry.GetOwner(house) == owner);
}
