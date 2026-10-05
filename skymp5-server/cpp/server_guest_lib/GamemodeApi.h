#pragma once
#include <map>
#include <string>

namespace GamemodeApi {
struct PropertyInfo
{
  bool isVisibleByNeighbors = false;
  bool isVisibleByOwner = false;
};

struct State
{
  std::map<std::string, PropertyInfo> createdProperties;
};
}
