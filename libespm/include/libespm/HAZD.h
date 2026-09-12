#pragma once
#include "RecordHeader.h"

#pragma pack(push, 1)

namespace espm {

class HAZD final : public RecordHeader
{
public:
  static constexpr auto kType = "HAZD";

  struct Data
  {
    // Raw (file-local) SPEL id applied to actors inside the hazard
    uint32_t spell = 0;
  };

  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept;
};

static_assert(sizeof(HAZD) == sizeof(RecordHeader));

}

#pragma pack(pop)
