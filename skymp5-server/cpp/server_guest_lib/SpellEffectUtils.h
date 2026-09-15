#pragma once
#include "WorldState.h"
#include "libespm/espm.h"

// Calls callback(effectItem, mgefData, mgefLookup) for each effect of a SPEL, effectItem may be null
template <class Callback>
void ForEachSpellEffectData(WorldState* worldState, uint32_t spellId,
                            const Callback& callback)
{
  auto& browser = worldState->GetEspm().GetBrowser();
  const auto spellLookup = browser.LookupById(spellId);
  const auto spell = espm::Convert<espm::SPEL>(spellLookup.rec);
  if (!spell) {
    return;
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
      continue;
    }
    callback(effect.effectItem, mgef->GetData(worldState->GetEspmCache()).data,
             mgefLookup);
  }
}
