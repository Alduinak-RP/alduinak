#include "libespm/WEAP.h"
#include "libespm/RecordHeaderAccess.h"
#include <cstring>

namespace espm {

WEAP::Data WEAP::GetData(
  CompressedFieldsCache& compressedFieldsCache) const noexcept
{
  Data result;
  RecordHeaderAccess::IterateFields(
    this,
    [&](const char* type, uint32_t dataSize, const char* data) {
      if (!std::memcmp(type, "DATA", 4)) {
        result.weapData = reinterpret_cast<const WeapData*>(data);
      } else if (!std::memcmp(type, "DNAM", 4)) {
        result.weapDNAM = reinterpret_cast<const DNAM*>(data);
      } else if (!std::memcmp(type, "EITM", 4) && dataSize >= 4) {
        result.enchantmentFormId = *reinterpret_cast<const uint32_t*>(data);
      }
    },
    compressedFieldsCache);
  return result;
}

}
