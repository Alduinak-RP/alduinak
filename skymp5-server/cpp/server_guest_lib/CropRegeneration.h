#pragma once
#include "WorldState.h"

struct BaseActorValues;

float CropRegeneration(float newAttributeValue, float secondsAfterLastRegen,
                       float attributeRate, float attributeRateMult,
                       float oldAttributeValue);

float CropHealthRegeneration(float newAttributeValue,
                             float secondsAfterLastRegen, MpActor* actor,
                             const BaseActorValues& baseValues);

float CropMagickaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor,
                              const BaseActorValues& baseValues);

float CropStaminaRegeneration(float newAttributeValue,
                              float secondsAfterLastRegen, MpActor* actor,
                              const BaseActorValues& baseValues);

float CropPeriodAfterLastRegen(float secondsAfterLastRegen,
                               float maxValidPeriod = 2.0f,
                               float defaultPeriod = 1.0f);

float CropValue(float value, float min = 0.f, float max = 1.0f);
