#pragma once
#include <algorithm>
#include <cmath>
#include <optional>
#include <string>

// Condition of an item copy (0..1, absent is 100%) and the percent tag clients append to its name
namespace ConditionTag {

// Condition in the stored steps of 1e-4, 1 for a value that is no number
inline float Rounded(float condition)
{
  if (!std::isfinite(condition)) {
    return 1.f;
  }
  const double steps = std::round(static_cast<double>(condition) * 1e4);
  return static_cast<float>(std::clamp(steps, 0.0, 1e4) / 1e4);
}

// The stored field: rounded, absent for a full copy
inline std::optional<float> Stored(float condition)
{
  const float rounded = Rounded(condition);
  return rounded >= 1.f ? std::nullopt : std::optional<float>(rounded);
}

// Percent shown after the name: 100 when absent, 0 only for a broken copy, never below 1 for one that still works
inline int Percent(const std::optional<float>& condition)
{
  if (!condition) {
    return 100;
  }
  const long steps =
    std::lround(static_cast<double>(Rounded(*condition)) * 1e4);
  return steps <= 0 ? 0 : static_cast<int>(std::max(1L, steps / 100));
}

inline bool IsBroken(const std::optional<float>& condition)
{
  return Percent(condition) == 0;
}

// The tag of a condition: "(97%)", "(<brokenLabel>)" for a broken copy
inline std::string Tag(const std::optional<float>& condition,
                       const std::string& brokenLabel)
{
  const int percent = Percent(condition);
  return percent == 0 ? "(" + brokenLabel + ")"
                      : "(" + std::to_string(percent) + "%)";
}

// Percent of the last "(NN%)" or "(<brokenLabel>)" of a name, nothing for a name without one
inline std::optional<int> TagPercent(const std::optional<std::string>& name,
                                     const std::string& brokenLabel)
{
  if (!name) {
    return std::nullopt;
  }
  const std::string& text = *name;
  size_t close = text.rfind(')');
  while (close != std::string::npos && close > 0) {
    const size_t open = text.rfind('(', close);
    if (open == std::string::npos) {
      break;
    }
    const std::string tag = text.substr(open + 1, close - open - 1);
    if (!brokenLabel.empty() && tag == brokenLabel) {
      return 0;
    }
    const bool percent = tag.size() >= 2 && tag.size() <= 4 &&
      tag.back() == '%' &&
      std::all_of(tag.begin(), tag.end() - 1,
                  [](unsigned char c) { return c >= '0' && c <= '9'; });
    if (percent) {
      const int value = std::stoi(tag.substr(0, tag.size() - 1));
      if (value <= 100) {
        return value;
      }
    }
    if (open == 0) {
      break;
    }
    close = text.rfind(')', open - 1);
  }
  return std::nullopt;
}

}
