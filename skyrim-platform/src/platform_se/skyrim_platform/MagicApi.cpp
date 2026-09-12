#include "MagicApi.h"
#include "CallNativeApi.h"
#include "JsUtils.h"
#include "SkyrimPlatform.h"

#include "Magic/AnimationGraphMasterBehaviourDescriptor.h"

extern CallNativeApi::NativeCallRequirements g_nativeCallRequirements;

namespace skymp::magic::details {

AnimationGraphMasterBehaviourDescriptor::AnimationVariables
GetAnimationVariablesFromJSArg(const Napi::Object& argObj)
{
  using AnimVarInitializer =
    AnimationGraphMasterBehaviourDescriptor::AnimationVariables::InitData;

  auto booleanVarsValue = NapiHelper::ExtractUInt8Array(
    argObj.Get("booleans"), "animationVariables.booleans");

  const auto booleanVars =
    AnimVarInitializer{ static_cast<uint8_t*>(booleanVarsValue.Data()),
                        booleanVarsValue.ByteLength() };

  auto floatsVarsValue = NapiHelper::ExtractUInt8Array(
    argObj.Get("floats"), "animationVariables.floats");

  const auto floatsVars =
    AnimVarInitializer{ static_cast<uint8_t*>(floatsVarsValue.Data()),
                        floatsVarsValue.ByteLength() };

  auto integersVarsValue = NapiHelper::ExtractUInt8Array(
    argObj.Get("integers"), "animationVariables.integers");

  const auto integersVars =
    AnimVarInitializer{ static_cast<uint8_t*>(integersVarsValue.Data()),
                        integersVarsValue.ByteLength() };

  const auto variables =
    AnimationGraphMasterBehaviourDescriptor::AnimationVariables{
      booleanVars, floatsVars, integersVars
    };

  return variables;
}

// Self buffs safe on a clone (Candlelight, Invisibility, Muffle): nothing hostile, spawned, equipped or area
bool IsReplayableSelfBuff(const RE::SpellItem& spell)
{
  using Archetype = RE::EffectArchetypes::ArchetypeID;

  if (spell.effects.empty()) {
    return false;
  }

  for (auto* effect : spell.effects) {
    auto* baseEffect = effect ? effect->baseEffect : nullptr;
    if (!baseEffect || baseEffect->IsHostile() ||
        baseEffect->IsDetrimental() || effect->effectItem.area > 0) {
      return false;
    }
    switch (baseEffect->GetArchetype()) {
      case Archetype::kValueModifier:
      case Archetype::kPeakValueModifier:
      case Archetype::kDualValueModifier:
      case Archetype::kLight:
      case Archetype::kInvisibility:
        break;
      default:
        return false;
    }
  }

  return true;
}

// Self area destruction spells (Fire Storm, Blizzard) whose clone cast is only visual once the client guards the observer
bool IsReplayableSelfArea(const RE::SpellItem& spell)
{
  using Archetype = RE::EffectArchetypes::ArchetypeID;

  if (spell.data.delivery != RE::MagicSystem::Delivery::kSelf ||
      spell.GetCastingType() ==
        RE::MagicSystem::CastingType::kConcentration) {
    return false;
  }

  bool hasHarmfulArea = false;

  for (auto* effect : spell.effects) {
    auto* baseEffect = effect ? effect->baseEffect : nullptr;
    if (!baseEffect) {
      return false;
    }
    const auto archetype = baseEffect->GetArchetype();
    switch (archetype) {
      case Archetype::kValueModifier:
      case Archetype::kDualValueModifier:
      case Archetype::kPeakValueModifier:
      case Archetype::kSpawnHazard:
        if (baseEffect->GetMagickSkill() != RE::ActorValue::kDestruction) {
          return false;
        }
        break;
      // Perk riders are conditioned on the caster's perks, which a clone never has
      case Archetype::kParalysis:
      case Archetype::kDemoralize:
        if (!baseEffect->conditions.head) {
          return false;
        }
        break;
      default:
        return false;
    }
    const bool harmful = baseEffect->IsHostile() || baseEffect->IsDetrimental();
    if ((harmful && effect->effectItem.area > 0) ||
        archetype == Archetype::kSpawnHazard) {
      hasHarmfulArea = true;
    }
  }

  return hasHarmfulArea;
}

} // namespace skymp::magic::details

Napi::Value MagicApi::CastSpellImmediate(const Napi::CallbackInfo& info)
{
  const auto actorFormId =
    NapiHelper::ExtractUInt32(info[0], "actorCasterFormId");

  const auto castingSource = static_cast<RE::MagicSystem::CastingSource>(
    NapiHelper::ExtractInt32(info[1], "castingSource"));

  const auto spellFormId = NapiHelper::ExtractUInt32(info[2], "formIdSpell");

  const auto magicTargetFormId =
    NapiHelper::ExtractUInt32(info[3], "formIdTarget");

  const auto aimAngle = NapiHelper::ExtractFloat(info[4], "aimAngle");
  const auto aimHeading = NapiHelper::ExtractFloat(info[5], "aimHeading");
  const RE::Projectile::ProjectileRot projectileAngles{ aimAngle, aimHeading };

  // Only clients that guard the observer opt in, older ones never pass the flag
  const bool allowHostileSelf =
    info[7].IsBoolean() && static_cast<bool>(info[7].As<Napi::Boolean>());
  const auto* spellToReplay =
    RE::TESForm::LookupByID<RE::SpellItem>(spellFormId);
  const bool replayHostileSelf = allowHostileSelf && spellToReplay &&
    skymp::magic::details::IsReplayableSelfArea(*spellToReplay);

  g_nativeCallRequirements.gameThrQ->AddTask(
    [spellFormId, actorFormId, castingSource, magicTargetFormId,
     projectileAngles, replayHostileSelf,

     animVars = skymp::magic::details::GetAnimationVariablesFromJSArg(
       NapiHelper::ExtractObject(info[6], "animationVariables"))](Viet::Void) {
      auto* pSpell = RE::TESForm::LookupByID<RE::SpellItem>(spellFormId);

      auto* pActor = RE::TESForm::LookupByID<RE::Actor>(actorFormId);

      if (!pSpell || !pActor) {
        return;
      }

      const auto t = pSpell->GetFormType();

      const bool isValidSpellType = t == RE::FormType::Spell ||
        t == RE::FormType::Scroll || t == RE::FormType::Ingredient ||
        t == RE::FormType::AlchemyItem || t == RE::FormType::Enchantment;

      if (!isValidSpellType) {
        return;
      }

      const bool isAnimationVariablesApplied =
        AnimationGraphMasterBehaviourDescriptor{ std::move(animVars) }
          .ApplyVariablesToActor(*pActor);

      if (!isAnimationVariablesApplied) {
        return;
      }

      const auto magicCaster = pActor->GetMagicCaster(castingSource);

      if (!magicCaster) {
        return;
      }

      auto* magicTarget =
        RE::TESForm::LookupByID<RE::TESObjectREFR>(magicTargetFormId);

      if (pSpell->GetCastingType() ==
          RE::MagicSystem::CastingType::kConcentration) {

        magicCaster->CastSpellImmediate(pSpell, false, magicTarget, 1.0f,
                                        false, 0.0f, pActor);

        return;
      }

      // Self spells launch no projectile, so buffs and guarded area spells are cast on the clone
      if (pSpell->data.delivery == RE::MagicSystem::Delivery::kSelf &&
          (replayHostileSelf ||
           skymp::magic::details::IsReplayableSelfBuff(*pSpell))) {
        magicCaster->CastSpellImmediate(pSpell, false, pActor, 1.0f, false,
                                        0.0f, pActor);
        return;
      }

      RE::ProjectileHandle pProjectile{};

      const auto magicNode = magicCaster->GetMagicNode();

      RE::NiPoint3 origin =
        magicNode ? magicNode->world.translate : pActor->GetPosition();

      if (!magicNode) {
        const auto boundMax = pActor->GetBoundMax();
        const auto boundMin = pActor->GetBoundMin();
        origin.z += (boundMax.z - boundMin.z) * 0.7f;
      }

      if (pSpell->data.delivery ==
          RE::MagicSystem::Delivery::kTargetLocation) {
        // TODO we need recalculate origin, cast ray from head to crosshair
        auto rotation = pActor->Get3D2()->world.rotate.entry;
        auto viewDirection =
          NiPoint3{ rotation[0][1], rotation[1][1], rotation[2][1] };
        viewDirection.Unitize();

        auto offset = viewDirection * 200.f;

        origin.x += offset.x;
        origin.y += offset.y;
        origin.z = pActor->GetPositionZ() + 10.f;
      }

      RE::Projectile::LaunchData launchData(pActor, origin, projectileAngles,
                                            pSpell);

      launchData.castingSource = castingSource;
      launchData.desiredTarget = magicTarget;
      launchData.contactNormal = RE::NiPoint3{ 0.f, 0.f, 1.0f };

      RE::Projectile::Launch(&pProjectile, launchData);
    });

  return Napi::Boolean::New(info.Env(), replayHostileSelf);
}

Napi::Value MagicApi::InterruptCast(const Napi::CallbackInfo& info)
{
  const auto actorFormId = NapiHelper::ExtractUInt32(info[0], "actorFormId");

  const auto castingSource = static_cast<RE::MagicSystem::CastingSource>(
    NapiHelper::ExtractInt32(info[1], "castingSource"));

  g_nativeCallRequirements.gameThrQ->AddTask(
    [actorFormId, castingSource,
     animVars = skymp::magic::details::GetAnimationVariablesFromJSArg(
       NapiHelper::ExtractObject(info[2], "animationVariables"))](Viet::Void) {
      const auto pActor = RE::TESForm::LookupByID<RE::Actor>(actorFormId);
      if (!pActor) {
        return;
      }

      // Anim vars are best-effort: the cast must stop even when they fail,
      // or a lost stop leaves the clone channeling forever
      const bool isAnimationVariablesApplied =
        AnimationGraphMasterBehaviourDescriptor{ std::move(animVars) }
          .ApplyVariablesToActor(*pActor);

      if (!isAnimationVariablesApplied) {
        logger::warn("InterruptCast - failed to apply animation variables to "
                     "actor {:x}, stopping the cast anyway",
                     actorFormId);
      }

      if (auto* caster = pActor->GetMagicCaster(castingSource)) {
        caster->FinishCast();
      } else {
        pActor->InterruptCast(false);
      }
    });

  return info.Env().Undefined();
}

Napi::Value MagicApi::GetAnimationVariablesFromActor(
  const Napi::CallbackInfo& info)
{
  const auto actorFormId = NapiHelper::ExtractUInt32(info[0], "actorFormId");

  const auto pActor = RE::TESForm::LookupByID<RE::Actor>(actorFormId);

  if (!pActor) {
    return info.Env().Undefined();
  }

  const auto animVariables =
    AnimationGraphMasterBehaviourDescriptor{ *pActor }.GetVariables();

  auto obj = Napi::Object::New(info.Env());

  AddObjProperty(
    &obj, "booleans",
    reinterpret_cast<const uint8_t*>(animVariables.booleans.data()),
    animVariables.SizeBooleansInBytes());

  AddObjProperty(&obj, "floats",
                 reinterpret_cast<const uint8_t*>(animVariables.floats.data()),
                 animVariables.SizeFloatsInBytes());

  AddObjProperty(
    &obj, "integers",
    reinterpret_cast<const uint8_t*>(animVariables.integers.data()),
    animVariables.SizeIntegersInBytes());

  return obj;
}

Napi::Value MagicApi::ApplyAnimationVariablesToActor(
  const Napi::CallbackInfo& info)
{
  const auto actorFormId = NapiHelper::ExtractUInt32(info[0], "actorFormId");

  const auto pActor = RE::TESForm::LookupByID<RE::Actor>(actorFormId);

  if (!pActor) {
    return Napi::Boolean::New(info.Env(), false);
  }

  const bool isAnimationVariablesApplied =
    AnimationGraphMasterBehaviourDescriptor{
      skymp::magic::details::GetAnimationVariablesFromJSArg(
        NapiHelper::ExtractObject(info[1], "animationVariables"))
    }
      .ApplyVariablesToActor(*pActor);

  return Napi::Boolean::New(info.Env(), isAnimationVariablesApplied);
}

namespace {
// Collected into a vector because dispelling can unlink list nodes
std::vector<RE::ActiveEffect*> GetPotionEffects(uint32_t actorFormId,
                                                uint32_t potionFormId)
{
  std::vector<RE::ActiveEffect*> res;
  auto* pActor = RE::TESForm::LookupByID<RE::Actor>(actorFormId);
  auto* pPotion = RE::TESForm::LookupByID<RE::AlchemyItem>(potionFormId);
  if (!pActor || !pPotion) {
    return res;
  }

  auto* activeEffects = pActor->AsMagicTarget()->GetActiveEffectList();
  if (!activeEffects) {
    return res;
  }

  for (auto* activeEffect : *activeEffects) {
    if (activeEffect && activeEffect->spell == pPotion &&
        activeEffect->flags.none(RE::ActiveEffect::Flag::kDispelled)) {
      res.push_back(activeEffect);
    }
  }
  return res;
}
}

Napi::Value MagicApi::DispelPotionEffects(const Napi::CallbackInfo& info)
{
  const auto actorFormId = NapiHelper::ExtractUInt32(info[0], "actorFormId");
  const auto potionFormId = NapiHelper::ExtractUInt32(info[1], "potionFormId");

  g_nativeCallRequirements.gameThrQ->AddTask(
    [actorFormId, potionFormId](Viet::Void) {
      for (auto* activeEffect : GetPotionEffects(actorFormId, potionFormId)) {
        activeEffect->Dispel(true);
      }
    });

  return info.Env().Undefined();
}

Napi::Value MagicApi::AgePotionEffects(const Napi::CallbackInfo& info)
{
  const auto actorFormId = NapiHelper::ExtractUInt32(info[0], "actorFormId");
  const auto potionFormId = NapiHelper::ExtractUInt32(info[1], "potionFormId");
  const auto seconds = NapiHelper::ExtractFloat(info[2], "seconds");

  g_nativeCallRequirements.gameThrQ->AddTask(
    [actorFormId, potionFormId, seconds](Viet::Void) {
      const auto effects = GetPotionEffects(actorFormId, potionFormId);
      if (effects.empty()) {
        return;
      }

      // Expire every copy as if started `seconds` before the newest one
      float newest = effects.front()->elapsedSeconds;
      for (auto* activeEffect : effects) {
        newest = std::min(newest, activeEffect->elapsedSeconds);
      }
      for (auto* activeEffect : effects) {
        activeEffect->elapsedSeconds =
          std::max(activeEffect->elapsedSeconds, newest + seconds);
      }
    });

  return info.Env().Undefined();
}

void MagicApi::Register(Napi::Env env, Napi::Object& exports)
{
  exports.Set("dispelPotionEffects",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(DispelPotionEffects)));
  exports.Set("agePotionEffects",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(AgePotionEffects)));

  exports.Set("castSpellImmediate",
              Napi::Function::New(
                env, NapiHelper::WrapCppExceptions(CastSpellImmediate)));
  exports.Set(
    "interruptCast",
    Napi::Function::New(env, NapiHelper::WrapCppExceptions(InterruptCast)));

  exports.Set(
    "getAnimationVariablesFromActor",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(GetAnimationVariablesFromActor)));

  exports.Set(
    "applyAnimationVariablesToActor",
    Napi::Function::New(
      env, NapiHelper::WrapCppExceptions(ApplyAnimationVariablesToActor)));
}
