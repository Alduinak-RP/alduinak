#pragma once
#include "RecordHeader.h"

#pragma pack(push, 1)

namespace espm {

class FURN final : public RecordHeader
{
public:
  static constexpr auto kType = "FURN";

  struct Data
  {
    const char* editorId = "";
    // MNAM: bits 0-23 flag the enabled sit/use markers
    uint32_t markerFlags = 0;
    uint32_t numMarkers = 0;
  };

  Data GetData(CompressedFieldsCache& compressedFieldsCache) const noexcept;
};

static_assert(sizeof(FURN) == sizeof(RecordHeader));

}

#pragma pack(pop)
