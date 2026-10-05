#include "CropRegeneration.h"
#include "GetBaseActorValues.h"
#include "MathUtils.h"
#include "MpActor.h"
#include "MpChangeForms.h"
#include "WorldState.h"

namespace {

float GetServerRegenMultiplier(MpActor* actor)
{
  auto worldState = actor->GetParent();
  return worldState ? worldState->regenerationMultiplier : 1.f;
}

float GetServerHealthRegenMultiplier(MpActor* actor)
{
  auto worldState = actor->GetParent();
  return worldState && worldState->healthRegenerationMultiplier
    ? *worldState->healthRegenerationMultiplier
    : GetServerRegenMultiplier(actor);
}

}

float CropRegeneration(float newAttributeValue, float secondsAfterLastRegen,
                       float attributeRate, float attributeRateMult,
                       float oldAttributeValue)
{
  spdlog::trace(
    "[crop]: args=(newAttributeValue={}, secondsAfterLastRegen={}, "
    "attributerate={}, attributeRateMult={}, oldAttributeValue={})",
    newAttributeValue, secondsAfterLastRegen, attributeRate, attributeRateMult,
    oldAttributeValue);

  float validRegenerationPercentage =
    MathUtils::PercentToFloat(attributeRate) *
    MathUtils::PercentToFloat(attributeRateMult) * secondsAfterLastRegen;

  spdlog::trace("[crop]: validRegenerationPercentage={}",
                validRegenerationPercentage);

  validRegenerationPercentage =
    validRegenerationPercentage < 0.0f ? 0.0f : validRegenerationPercentage;
  float validAttributePercentage =
    oldAttributeValue + validRegenerationPercentage;

  spdlog::trace("[crop]: validAttributePercentage={}",
                validAttributePercentage);

  validAttributePercentage =
    validAttributePercentage > 1.0f ? 1.0f : validAttributePercentage;

  spdlog::trace("[crop]: comparing received attribute value and valid one: "
                "newAttributeValue={}, validAttributePercentage={}",
                newAttributeValue, validAttributePercentage);

  if (newAttributeValue > validAttributePercentage) {
    return validAttributePercentage;
  }
  if (newAttributeValue < 0.0f) {
    return 0.0f;
  }
  return newAttributeValue;
}

float CropHealthRegeneration(float newAttributeValue,
                             float secondsAfterLastRegen, MpActor* actor,
                             const BaseActorValues& baseValues)
{
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate = std::max(baseValues.healRate, actorValues.healRate) *
    GetServerHealthRegenMultiplier(actor);
  const float rateMult =
    std::max(baseValues.healRateMult, actorValues.healRateMult);
  const float oldPercentage = actorValues.healthPercentage;
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage);
}

float CropMagickaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor,
                              const BaseActorValues& baseValues)
{
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate =
    std::max(baseValues.magickaRate, actorValues.magickaRate) *
    GetServerRegenMultiplier(actor);
  const float rateMult =
    std::max(baseValues.magickaRateMult, actorValues.magickaRateMult);
  const float oldPercentage = actorValues.magickaPercentage;
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage);
}

float CropStaminaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor,
                              const BaseActorValues& baseValues)
{
  const ActorValues& actorValues = actor->GetActorValues();
  const float rate = (actor->IsBlockActive()
    ? actorValues.staminaRate
    : std::max(baseValues.staminaRate, actorValues.staminaRate)) *
    GetServerRegenMultiplier(actor);
  const float rateMult =
    std::max(baseValues.staminaRateMult, actorValues.staminaRateMult);
  const float oldPercentage = actorValues.staminaPercentage;
  return CropRegeneration(newAttributeValue, secondsAfterLastRegen, rate,
                          rateMult, oldPercentage);
}

float CropPeriodAfterLastRegen(float secondsAfterLastRegen,
                               float maxValidPeriod, float defaultPeriod)
{
  if (secondsAfterLastRegen < 0.0f) {
    return 0.0f;
  }
  if (secondsAfterLastRegen > maxValidPeriod) {
    return defaultPeriod;
  }
  return secondsAfterLastRegen;
}

float CropValue(float value, float min, float max)
{
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
