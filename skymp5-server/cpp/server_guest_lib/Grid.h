// Made for skymp2-server (June 2018)
// Thanks to Ivan Savelo for his help

#pragma once
#include "DSLine.h"
#include <cstdint>
#include <set>
#include <unordered_map>
#include <utility>

template <class T>
class GridImpl
{
public:
  void Move(const T& id, int16_t x, int16_t y)
  {
    auto& obj = objects[id];

    if (obj.coords != std::make_pair(x, y)) {
      auto to = std::make_pair(x, y);
      this->MoveImpl(id, obj.active ? &obj.coords : nullptr, &to);

      obj.active = true;
      obj.coords = { x, y };
    }
  }

  void Forget(const T& id)
  {
    auto& obj = objects[id];

    if (obj.active) {
      obj.active = false;
      this->MoveImpl(id, &obj.coords, nullptr);
      objects.erase(id);
    }
  }

  const std::set<T>& GetNeighboursByPosition(int16_t x, int16_t y) const
  {
    auto& neiX = nei.At(x);
    return neiX.At(y);
  }

private:
  struct Obj
  {
    bool active = 0;
    std::pair<int16_t, int16_t> coords = { -32000, -32000 };
  };

  void MoveImpl(const T& id, std::pair<int16_t, int16_t>* from,
                std::pair<int16_t, int16_t>* to)
  {
    auto& obj = objects[id];

    if (from) {
      for (int i = -1; i <= 1; ++i) {
        for (int j = -1; j <= 1; ++j) {
          nei.At(from->first + i).At(from->second + j).erase(id);
        }
      }
    }

    if (to) {
      for (int i = -1; i <= 1; ++i) {
        for (int j = -1; j <= 1; ++j) {
          nei.At(to->first + i).At(to->second + j).insert(id);
        }
      }
    }
  }

  mutable std::unordered_map<T, Obj> objects;
  mutable DSLine<DSLine<std::set<T>>> nei;
};

using Grid = GridImpl<uint64_t>;
