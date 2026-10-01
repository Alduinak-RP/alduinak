#pragma once
#include <algorithm>
#include <charconv>
#include <cmath>
#include <string>

// private.healthScale: share of the base maximum an actor's health points count against
namespace HealthScale {

inline constexpr const char* kProperty = "private.healthScale";
inline constexpr float kMin = 0.01f;
inline constexpr float kMax = 100.f;

// Scale of a stored JSON value: a number kept inside the bounds, 1 for anything that is not a number
inline float FromDump(const std::string& dump)
{
  double value = 1.0;
  const char* end = dump.data() + dump.size();
  const auto parsed = std::from_chars(dump.data(), end, value);
  if (parsed.ec != std::errc() || parsed.ptr != end || !std::isfinite(value)) {
    return 1.f;
  }
  return static_cast<float>(
    std::clamp(value, static_cast<double>(kMin), static_cast<double>(kMax)));
}

// Health points a full bar stands for
inline float Maximum(float baseHealth, float scale)
{
  return baseHealth * scale;
}

}
