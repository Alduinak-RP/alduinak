#include "libespm/FURN.h"
#include "libespm/RecordHeaderAccess.h"
#include <bitset>
#include <cstring>

namespace espm {

FURN::Data FURN::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t dataSize, const char* data) {
      if (!std::memcmp(type, "EDID", 4)) {
        result.editorId = data;
      } else if (!std::memcmp(type, "MNAM", 4) && dataSize >= 4) {
        result.markerFlags = *reinterpret_cast<const uint32_t*>(data);
      }
    },
    compressedFieldsCache);
  result.numMarkers =
    static_cast<uint32_t>(std::bitset<24>(result.markerFlags).count());
  return result;
}

}
