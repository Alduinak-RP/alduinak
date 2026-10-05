#include "DynamicFields.h"

void DynamicFields::SetValueDump(const std::string& propName,
                                 const std::string& valueDump)
{
  propDumps[propName] = valueDump;
}

const std::string& DynamicFields::GetValueDump(
  const std::string& propName) const
{
  static const auto kNull = std::string("null");

  auto it = propDumps.find(propName);
  if (it == propDumps.end()) {
    return kNull;
  }

  return it->second;
}

nlohmann::json DynamicFields::GetAsJson() const
{
  auto obj = nlohmann::json::object();
  for (const auto& [key, valueDump] : propDumps) {
    obj[key] = nlohmann::json::parse(valueDump);
  }
  return obj;
}

// simdjson prints scalars like nlohmann's dump; objects keep the stored key order
DynamicFields DynamicFields::FromJson(const simdjson::dom::element& element)
{
  DynamicFields res;
  for (auto [key, value] : element.get_object()) {
    res.propDumps[std::string(key)] = simdjson::minify(value);
  }
  return res;
}

bool operator<(const DynamicFields& r, const DynamicFields& l)
{
  return r.GetAsJson() < l.GetAsJson();
}

bool operator==(const DynamicFields& r, const DynamicFields& l)
{
  return r.GetAsJson() == l.GetAsJson();
}

bool operator!=(const DynamicFields& r, const DynamicFields& l)
{
  return !(r == l);
}
