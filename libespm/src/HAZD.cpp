#include "libespm/HAZD.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>

namespace espm {

HAZD::Data HAZD::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t size, const char* data) {
      if (!std::memcmp(type, "DATA", 4) && size >= 0x1c) {
        result.spell = *reinterpret_cast<const uint32_t*>(data + 0x18);
      }
    },
    compressedFieldsCache);

  return result;
}

}
