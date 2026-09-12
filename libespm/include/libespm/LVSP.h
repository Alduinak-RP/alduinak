#pragma once
#include "LeveledListBase.h"

#pragma pack(push, 1)

namespace espm {

class LVSP final : public LeveledListBase
{
public:
  static constexpr auto kType = "LVSP";
};

static_assert(sizeof(LVSP) == sizeof(RecordHeader));

}

#pragma pack(pop)
