// Copied from
// https://gitlab.com/pospelov/skymp2-server/-/raw/master/src/tests/GridTest.cpp
#include "Grid.h"
#include <catch2/catch_all.hpp>

using formid = uint64_t;

TEST_CASE("GetNeighboursByPosition follows Move and Forget", "[Grid]")
{
  Grid gr;
  gr.Move(0xFF00, 645, 232);
  gr.Move(0xABCD, 644, 232);
  gr.Move(0xFF0F0000, 645, 233);
  gr.Move(0xABCF, 644, 233);
  REQUIRE(gr.GetNeighboursByPosition(644, 233) ==
          std::set<formid>({ 0xABCD, 0xABCF, 0xFF00, 0xFF0F0000 }));

  gr.Forget(0xFF00);
  REQUIRE(gr.GetNeighboursByPosition(644, 233) ==
          std::set<formid>({ 0xABCD, 0xABCF, 0xFF0F0000 }));

  gr.Move(0xABCD, 644, 300);
  REQUIRE(gr.GetNeighboursByPosition(644, 233) ==
          std::set<formid>({ 0xABCF, 0xFF0F0000 }));
  REQUIRE(gr.GetNeighboursByPosition(644, 300) ==
          std::set<formid>({ 0xABCD }));
}

TEST_CASE("GetNeighboursByPosition across zero", "[Grid]")
{
  Grid gr;
  gr.Move(0xA200, 0, 0);
  gr.Move(0xA100, -1, -1);
  gr.Move(0xA002, 1, -1);
  REQUIRE(gr.GetNeighboursByPosition(0, 0) ==
          std::set<formid>({ 0xA002, 0xA100, 0xA200 }));
  REQUIRE(gr.GetNeighboursByPosition(-1, -1) ==
          std::set<formid>({ 0xA100, 0xA200 }));

  gr.Forget(0xA200);
  REQUIRE(gr.GetNeighboursByPosition(0, 0) ==
          std::set<formid>({ 0xA002, 0xA100 }));
}
