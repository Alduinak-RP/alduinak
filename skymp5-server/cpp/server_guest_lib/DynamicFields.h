#pragma once

#include <string>
#include <unordered_map>

#include <nlohmann/json.hpp>
#include <simdjson.h>

class DynamicFields
{
public:
  void SetValueDump(const std::string& propName, const std::string& valueDump);
  const std::string& GetValueDump(const std::string& propName) const;

  nlohmann::json GetAsJson() const;
  static DynamicFields FromJson(const simdjson::dom::element& element);

  template <class F>
  void ForEachValueDump(const F& f) const
  {
    for (const auto& [propName, valueDump] : propDumps) {
      f(propName, valueDump);
    }
  }

  friend bool operator<(const DynamicFields& r, const DynamicFields& l);
  friend bool operator==(const DynamicFields& r, const DynamicFields& l);
  friend bool operator!=(const DynamicFields& r, const DynamicFields& l);

private:
  std::unordered_map<std::string, std::string> propDumps;
};
