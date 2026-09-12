#include "Inventory.h"
#include <catch2/catch_all.hpp>

TEST_CASE(
  "RemoveItems in case of multiple entries with the same baseId/extras",
  "[Inventory]")
{
  Inventory inv;
  inv.entries.push_back(Inventory::Entry(0xf, 10));
  inv.entries.push_back(Inventory::Entry(0xf, 10));

  inv.RemoveItems({ Inventory::Entry(0xf, 5) });

  REQUIRE(inv.entries.size() == 2);
  REQUIRE(inv.entries[0].count == 5);
  REQUIRE(inv.entries[1].count == 10);
}

TEST_CASE("Similar entries should be merged if needed to remove items",
          "[Inventory]")
{
  Inventory inv;
  inv.entries.push_back(Inventory::Entry(0xf, 10));
  inv.entries.push_back(Inventory::Entry(0xf, 10));

  inv.RemoveItems({ Inventory::Entry(0xf, 15) });

  REQUIRE(inv.entries.size() == 1);
  REQUIRE(inv.entries[0].count == 5);
}

TEST_CASE("Remove all items from similar entries", "[Inventory]")
{
  Inventory inv;
  inv.entries.push_back(Inventory::Entry(0xf, 10));
  inv.entries.push_back(Inventory::Entry(0xf, 10));

  inv.RemoveItems({ Inventory::Entry(0xf, 20) });

  REQUIRE(inv.entries.size() == 0);
}

TEST_CASE("Remove all items from a single entry", "[Inventory]")
{
  Inventory inv;
  inv.entries.push_back(Inventory::Entry(0xf, 10));

  inv.RemoveItems({ Inventory::Entry(0xf, 10) });

  REQUIRE(inv.entries.size() == 0);
}

TEST_CASE("AddItems keeps adding after an entry merges into a stack",
          "[Inventory]")
{
  Inventory inv;
  inv.AddItem(0xf, 10);

  inv.AddItems({ Inventory::Entry(0xf, 5), Inventory::Entry(0x12eb7, 2),
                 Inventory::Entry(0x12eb7, 1) });

  REQUIRE(inv.entries.size() == 2);
  REQUIRE(inv.GetItemCount(0xf) == 15);
  REQUIRE(inv.GetItemCount(0x12eb7) == 3);
}

TEST_CASE("Not enough items to remove", "[Inventory]")
{
  Inventory inv;
  inv.entries.push_back(Inventory::Entry(0xf, 10));
  inv.entries.push_back(Inventory::Entry(0xf, 9));

  REQUIRE_THROWS_AS(inv.RemoveItems({ Inventory::Entry(0xf, 20) }),
                    std::runtime_error);
}
