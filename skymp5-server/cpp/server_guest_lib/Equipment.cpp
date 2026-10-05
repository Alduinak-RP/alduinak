#include "Equipment.h"
#include "archives/JsonInputArchive.h"
#include "archives/JsonOutputArchive.h"
#include "archives/SimdJsonInputArchive.h"

bool Equipment::IsSpellEquipped(const uint32_t spellFormId) const
{
  return spellFormId == leftSpell || spellFormId == rightSpell ||
    spellFormId == voiceSpell || spellFormId == instantSpell;
}

Equipment Equipment::Worn() const
{
  Equipment res;
  res.leftSpell = leftSpell;
  res.rightSpell = rightSpell;
  res.voiceSpell = voiceSpell;
  res.instantSpell = instantSpell;
  res.numChanges = numChanges;
  for (const auto& entry : inv.entries) {
    if (entry.GetWorn() != Inventory::Worn::None) {
      res.inv.entries.push_back(entry);
    }
  }
  return res;
}

nlohmann::json Equipment::ToJson() const
{
  JsonOutputArchive ar;
  const_cast<Equipment*>(this)->Serialize(ar);
  return std::move(ar.j);
}

Equipment Equipment::FromJson(const simdjson::dom::element& element)
{
  SimdJsonInputArchive ar(element);
  Equipment res;
  res.Serialize(ar);
  return res;
}

Equipment Equipment::FromJson(const nlohmann::json& element)
{
  JsonInputArchive ar(element);
  Equipment res;
  res.Serialize(ar);
  return res;
}
