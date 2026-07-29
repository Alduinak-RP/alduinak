#pragma once
#include <array>
#include <cstdint>
#include <unordered_map>

namespace espm {

// A plugin's place in a form-id space: full = index<<24 | 24-bit local id.
// Light (ESL) = 0xFE000000 | slot<<12 | 12-bit local id (TESDataHandler::LookupFormID).
struct PluginSlot
{
  bool light = false;
  uint32_t index = 0; // 0..0xFD when full, 0..0xFFF when light

  uint32_t Base() const noexcept
  {
    return light ? (0xFE000000u | ((index & 0xFFFu) << 12))
                 : ((index & 0xFFu) << 24);
  }

  uint32_t LocalMask() const noexcept { return light ? 0xFFFu : 0xFFFFFFu; }
};

// Translates form ids between raw per-file space and combined space.
// Full sources use the array fast path; light sources key by 12-bit slot (all share 0xFE).
class IdMapping
{
public:
  // Out of valid range, so callers keep the ">= 0xff000000 means skip this source" contract.
  static constexpr uint32_t kInvalid = 0xFFFFFFFFu;

  IdMapping() { mapped.fill(false); }

  void Set(const PluginSlot& from, const PluginSlot& to) noexcept
  {
    if (from.light) {
      light[static_cast<uint16_t>(from.index & 0xFFFu)] = to;
      return;
    }
    const uint32_t i = from.index & 0xFFu;
    full[i] = to;
    mapped[i] = true;
  }

  uint32_t Map(uint32_t id) const noexcept
  {
    const uint32_t high = id >> 24;
    if (high == 0xFEu) {
      const auto it = light.find(static_cast<uint16_t>((id >> 12) & 0xFFFu));
      if (it == light.end()) {
        return kInvalid;
      }
      return it->second.Base() | (id & 0xFFFu);
    }
    if (!mapped[high]) {
      return kInvalid;
    }
    const PluginSlot& to = full[high];
    return to.Base() | (id & to.LocalMask());
  }

private:
  std::array<PluginSlot, 256> full{};
  std::array<bool, 256> mapped{};
  std::unordered_map<uint16_t, PluginSlot> light;
};

}
