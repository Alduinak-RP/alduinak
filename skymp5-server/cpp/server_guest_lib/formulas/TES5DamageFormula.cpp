#include "TES5DamageFormula.h"

#include "ConditionsEvaluator.h"
#include "EvaluateTemplate.h"
#include "HitData.h"
#include "MpActor.h"
#include "SpellCastData.h"
#include "SpellEffectUtils.h"
#include "WorldState.h"
#include "libespm/espm.h"
#include <algorithm>
#include <spdlog/spdlog.h>

namespace internal {

bool IsUnarmedAttack(const uint32_t sourceFormId)
{
  return sourceFormId == 0x1f4;
}

class TES5DamageFormulaImpl
{
public:
  TES5DamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                        const HitData& hitData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const HitData& hitData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseWeaponDamage() const;
  [[nodiscard]] float CalcWeaponRating() const;
  [[nodiscard]] float CalcArmorRatingComponent(
    const Inventory::Entry& opponentEquipmentEntry) const;
  [[nodiscard]] float CalcOpponentArmorRating() const;
  [[nodiscard]] float CalcEnchantmentArmorRating(
    uint32_t armorId, uint32_t rawEnchantmentId) const;
  [[nodiscard]] float DetermineDamageFromSource(uint32_t source) const;
  [[nodiscard]] float CalcUnarmedDamage() const;
  [[nodiscard]] float CalcArmorDamagePenalty() const;
};

TES5DamageFormulaImpl::TES5DamageFormulaImpl(const MpActor& aggressor_,
                                             const MpActor& target_,
                                             const HitData& hitData_)
  : aggressor(aggressor_)
  , target(target_)
  , hitData(hitData_)
  , espmProvider(aggressor.GetParent())
{
}

float TES5DamageFormulaImpl::GetBaseWeaponDamage() const
{
  const auto weapData =
    espm::GetData<espm::WEAP>(hitData.source, espmProvider);
  if (!weapData.weapData) {
    throw std::runtime_error(
      fmt::format("no weapData for {:#x}", hitData.source));
  }
  return weapData.weapData->damage;
}

float TES5DamageFormulaImpl::CalcWeaponRating() const
{
  // TODO(#457): take other components into account
  return GetBaseWeaponDamage();
}

// Record fields hold ids relative to the plugin that defines the record
float TES5DamageFormulaImpl::CalcEnchantmentArmorRating(
  uint32_t armorId, uint32_t rawEnchantmentId) const
{
  auto& browser = espmProvider->GetEspm().GetBrowser();
  auto& cache = espmProvider->GetEspmCache();
  const auto ench = browser.LookupById(
    browser.LookupById(armorId).ToGlobalId(rawEnchantmentId));
  const auto enchRecord = espm::Convert<espm::ENCH>(ench.rec);
  if (!enchRecord) {
    spdlog::warn("TES5DamageFormula - armor {:#x} enchantment {:#x} is not an "
                 "ENCH, ignored",
                 armorId, rawEnchantmentId);
    return 0.f;
  }
  float armorRating = 0.f;
  for (const auto& effect : enchRecord->GetData(cache).effects) {
    const auto mgef = espm::Convert<espm::MGEF>(
      browser.LookupById(ench.ToGlobalId(effect.effectId)).rec);
    if (mgef &&
        mgef->GetData(cache).data.primaryAV == espm::ActorValue::DamageResist) {
      armorRating += effect.magnitude;
    }
  }
  return armorRating;
}

float TES5DamageFormulaImpl::CalcArmorRatingComponent(
  const Inventory::Entry& opponentEquipmentEntry) const
{
  if (opponentEquipmentEntry.GetWorn() != Inventory::Worn::None &&
      espm::GetRecordType(opponentEquipmentEntry.baseId, espmProvider) ==
        espm::ARMO::kType) {
    const auto armorData =
      espm::GetData<espm::ARMO>(opponentEquipmentEntry.baseId, espmProvider);
    // TODO(#458): take other components into account
    auto ac = static_cast<float>(armorData.baseRatingX100) / 100;
    if (armorData.enchantmentFormId) {
      // TODO(#632) refactor this effect with actor effect system
      ac += CalcEnchantmentArmorRating(opponentEquipmentEntry.baseId,
                                       armorData.enchantmentFormId);
    }

    return ac;
  }
  return 0;
}

float TES5DamageFormulaImpl::CalcOpponentArmorRating() const
{
  float combinedArmorRating = 0;
  auto eq = target.GetEquipment();
  for (auto& entry : eq.inv.entries) {
    combinedArmorRating += CalcArmorRatingComponent(entry);
  }
  return combinedArmorRating;
}

float TES5DamageFormulaImpl::CalcUnarmedDamage() const
{
  const uint32_t raceId = aggressor.GetRaceId();
  return espm::GetData<espm::RACE>(raceId, espmProvider).unarmedDamage;
}

float TES5DamageFormulaImpl::DetermineDamageFromSource(uint32_t source) const
{
  return IsUnarmedAttack(source) ? CalcUnarmedDamage() : CalcWeaponRating();
}

float TES5DamageFormulaImpl::CalcArmorDamagePenalty() const
{
  // TODO(#457): weapon rating is probably not only component of incomingDamage
  // Replace this with another issue reference upon investigation
  const float maxArmorRating =
    espm::GetData<espm::GMST>(espm::GMST::kFMaxArmorRating, espmProvider)
      .value;
  const float armorScalingFactor =
    espm::GetData<espm::GMST>(espm::GMST::kFArmorScalingFactor, espmProvider)
      .value;
  return 0.01f *
    (100.f -
     std::min<float>(CalcOpponentArmorRating() * armorScalingFactor,
                     maxArmorRating));
}

float TES5DamageFormulaImpl::CalculateDamage() const
{
  const float incomingDamage = DetermineDamageFromSource(hitData.source);

  // TODO(#461): add difficulty multiplier
  // TODO(#463): add sneak modifier
  float damage = incomingDamage * CalcArmorDamagePenalty();

  if (hitData.isPowerAttack) {
    damage *= 2.f;
  }

  if (hitData.isHitBlocked) {
    // TODO(#460): implement correct block formula
    damage *= kBlockedHitDamageMult;
  }

  if (hitData.isSneakAttack) {
    // TODO(GM-613): get from GameSettings
    damage *= 1.3f;
  }

  return damage;
}

class TES5SpellDamageFormulaImpl
{
  using Effects = std::vector<espm::Effects::Effect>;

public:
  TES5SpellDamageFormulaImpl(const MpActor& aggressor_, const MpActor& target_,
                             const SpellCastData& spellCastData_);

  [[nodiscard]] float CalculateDamage() const;

private:
  const MpActor& aggressor;
  const MpActor& target;
  const SpellCastData& spellCastData;
  WorldState* espmProvider;

private:
  [[nodiscard]] float GetBaseSpellDamage() const;
  [[nodiscard]] const MpActor* GetConditionActor(const espm::CTDA& ctda) const;
  [[nodiscard]] bool ConditionHolds(const espm::CTDA& ctda,
                                    const espm::LookupResult& owner) const;
  [[nodiscard]] bool ConditionsHold(const std::vector<espm::CTDA>& ctdas,
                                    const espm::LookupResult& owner) const;
};

TES5SpellDamageFormulaImpl::TES5SpellDamageFormulaImpl(
  const MpActor& aggressor_, const MpActor& target_,
  const SpellCastData& spellCastData_)
  : aggressor(aggressor_)
  , target(target_)
  , spellCastData(spellCastData_)
  , espmProvider(aggressor.GetParent())
{
}

// Keywords of the actor's base NPC_ and race, worn items are not included
bool ActorHasKeyword(const MpActor& actor, uint32_t keywordId)
{
  WorldState* worldState = actor.GetParent();
  const auto formHasKeyword = [&](const espm::LookupResult& form) {
    if (!form.rec) {
      return false;
    }
    const auto ids = form.rec->GetKeywordIds(worldState->GetEspmCache());
    return std::any_of(ids.begin(), ids.end(), [&](uint32_t rawId) {
      return form.ToGlobalId(rawId) == keywordId;
    });
  };
  const bool npcHasKeyword =
    EvaluateTemplateNoThrow<espm::NPC_::UseKeywords>(
      worldState, actor.GetBaseId(), actor.GetTemplateChain(),
      [&](const espm::LookupResult& npc, const espm::NPC_::Data&) {
        return formHasKeyword(npc);
      },
      nullptr)
      .value_or(false);
  return npcHasKeyword ||
    formHasKeyword(
      worldState->GetEspm().GetBrowser().LookupById(actor.GetRaceId()));
}

bool CompareWithCtda(float value, const espm::CTDA& ctda)
{
  const float other = ctda.comparisonValue;
  switch (ctda.GetOperator()) {
    case espm::CTDA::Operator::EqualTo:
      return value == other;
    case espm::CTDA::Operator::NotEqualTo:
      return value != other;
    case espm::CTDA::Operator::GreaterThen:
      return value > other;
    case espm::CTDA::Operator::GreaterThenOrEqualTo:
      return value >= other;
    case espm::CTDA::Operator::LessThen:
      return value < other;
    case espm::CTDA::Operator::LessThenOrEqualTo:
      return value <= other;
  }
  return false;
}

// Magic effect conditions run Subject on the actor hit and Target on the caster, null for other run-ons or flags
const MpActor* TES5SpellDamageFormulaImpl::GetConditionActor(
  const espm::CTDA& ctda) const
{
  const bool plainFlags = (static_cast<uint8_t>(ctda.GetFlags()) &
                           ~static_cast<uint8_t>(espm::CTDA::Flags::OR)) == 0;
  if (plainFlags && ctda.runOnType == espm::CTDA::RunOnTypeFlags::Subject) {
    return &target;
  }
  if (plainFlags && ctda.runOnType == espm::CTDA::RunOnTypeFlags::Target) {
    return &aggressor;
  }
  return nullptr;
}

// Condition form ids are relative to the owner record's plugin
bool TES5SpellDamageFormulaImpl::ConditionHolds(
  const espm::CTDA& ctda, const espm::LookupResult& owner) const
{
  constexpr uint16_t kHasPerk = 448;
  constexpr uint16_t kHasKeyword = 560;
  constexpr uint16_t kGetActorValuePercent = 640;
  if (ctda.functionIndex == kHasPerk) {
    // The server holds no perk data
    return false;
  }
  const MpActor* actor = GetConditionActor(ctda);
  const uint32_t parameter = ctda.GetDefaultData().firstParameter;
  if (actor && ctda.functionIndex == kHasKeyword) {
    const bool hasKeyword =
      ActorHasKeyword(*actor, owner.ToGlobalId(parameter));
    return CompareWithCtda(hasKeyword ? 1.f : 0.f, ctda);
  }
  const auto av = static_cast<espm::ActorValue>(parameter);
  const bool trackedPercentage = av == espm::ActorValue::Health ||
    av == espm::ActorValue::Magicka || av == espm::ActorValue::Stamina;
  const auto& functions = espmProvider->conditionFunctionMap;
  if (actor && ctda.functionIndex == kGetActorValuePercent &&
      trackedPercentage && functions.GetConditionFunction(ctda.functionIndex)) {
    bool holds = false;
    ConditionsEvaluator::EvaluateConditions(
      functions, espmProvider->conditionsEvaluatorSettings,
      ConditionsEvaluatorCaller::kSpellDamage, { Condition::FromCtda(ctda) },
      target, aggressor,
      [&](bool evalRes, std::vector<std::string>&) { holds = evalRes; });
    return holds;
  }
  // IsHostileToActor holds for the actor being hit, and conditions the server cannot evaluate do not gate damage
  return true;
}

// A CTDA with the OR flag joins the next one into a group, and every group must hold
bool TES5SpellDamageFormulaImpl::ConditionsHold(
  const std::vector<espm::CTDA>& ctdas, const espm::LookupResult& owner) const
{
  bool groupHolds = false;
  for (size_t i = 0; i < ctdas.size(); ++i) {
    groupHolds = groupHolds || ConditionHolds(ctdas[i], owner);
    const bool joinsNext = static_cast<uint8_t>(ctdas[i].GetFlags()) &
      static_cast<uint8_t>(espm::CTDA::Flags::OR);
    if (!joinsNext || i + 1 == ctdas.size()) {
      if (!groupHolds) {
        return false;
      }
      groupHolds = false;
    }
  }
  return true;
}

float TES5SpellDamageFormulaImpl::GetBaseSpellDamage() const
{
  float damage = 0.f;
  const bool isSpell = ForEachSpellEffectRecord(
    espmProvider, spellCastData.spell,
    [&](const espm::LookupResult& spellLookup, const espm::SPEL::Data& spell,
        const espm::SPEL::Effect& effect, const espm::MGEF::Data& mgef,
        const espm::LookupResult& mgefLookup) {
      const bool needAddDamage =
        mgef.data.IsFlagSet(espm::MGEF::Flags::Hostile) ||
        mgef.data.IsFlagSet(espm::MGEF::Flags::Detrimental);
      if (!effect.effectItem || !needAddDamage ||
          mgef.data.primaryAV != espm::ActorValue::Health) {
        return;
      }
      // Shouts count every effect, conditional or not
      const bool isShout = spell.spellItem &&
        spell.spellItem->type == espm::SPEL::SpellType::Voice;
      if (isShout ||
          (ConditionsHold(effect.conditions, spellLookup) &&
           ConditionsHold(mgef.conditions, mgefLookup))) {
        damage += effect.effectItem->magnitude;
      }
    });
  if (!isSpell) {
    spdlog::warn("TES5SpellDamageFormula - {:#x} is not a SPEL, ignored",
                 spellCastData.spell);
  }
  return damage;
}

float TES5SpellDamageFormulaImpl::CalculateDamage() const
{
  return GetBaseSpellDamage();
}

}

float TES5DamageFormula::CalculateDamage(const MpActor& aggressor,
                                         const MpActor& target,
                                         const HitData& hitData) const
{
  return internal::TES5DamageFormulaImpl(aggressor, target, hitData)
    .CalculateDamage();
}

float TES5DamageFormula::CalculateDamage(
  const MpActor& aggressor, const MpActor& target,
  const SpellCastData& spellCastData) const
{
  return internal::TES5SpellDamageFormulaImpl(aggressor, target, spellCastData)
    .CalculateDamage();
}
