#pragma once
#include "WorldState.h"
#include "libespm/espm.h"
#include <spdlog/spdlog.h>

// Calls callback(spellLookup, spellData, effect, mgefData, mgefLookup) for each effect of a SPEL; false if spellId is not a SPEL
template <class Callback>
bool ForEachSpellEffectRecord(WorldState* worldState, uint32_t spellId,
                              const Callback& callback)
{
  auto& browser = worldState->GetEspm().GetBrowser();
  const auto spellLookup = browser.LookupById(spellId);
  const auto spell = espm::Convert<espm::SPEL>(spellLookup.rec);
  if (!spell) {
    return false;
  }
  const auto spellData = spell->GetData(worldState->GetEspmCache());
  for (const auto& effect : spellData.effects) {
    if (effect.effectFormId == 0) {
      continue;
    }
    const auto mgefLookup =
      browser.LookupById(spellLookup.ToGlobalId(effect.effectFormId));
    const auto mgef = espm::Convert<espm::MGEF>(mgefLookup.rec);
    if (!mgef) {
      spdlog::warn("ForEachSpellEffectRecord - spell {:#x} effect {:#x} is "
                   "not an MGEF, ignored",
                   spellId, effect.effectFormId);
      continue;
    }
    callback(spellLookup, spellData, effect,
             mgef->GetData(worldState->GetEspmCache()), mgefLookup);
  }
  return true;
}

// Calls callback(effectItem, mgefData, mgefLookup) for each effect of a SPEL, effectItem may be null; false if spellId is not a SPEL
template <class Callback>
bool ForEachSpellEffectData(WorldState* worldState, uint32_t spellId,
                            const Callback& callback)
{
  return ForEachSpellEffectRecord(
    worldState, spellId,
    [&](const espm::LookupResult&, const espm::SPEL::Data&,
        const espm::SPEL::Effect& effect, const espm::MGEF::Data& mgef,
        const espm::LookupResult& mgefLookup) {
      callback(effect.effectItem, mgef.data, mgefLookup);
    });
}
