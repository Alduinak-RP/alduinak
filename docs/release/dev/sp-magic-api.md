## Added API for Magic functions

### Spell Casting and Interrupting
```ts
function castSpellImmediate(
  actorCasterFormId: number, 
  castingSource: SpellType, 
  formIdSpell: number, 
  formIdTarget: number, 
  aimAngle: number,
  aimHeading: number,
  animationVariables: ActorAnimationVariables,
  replayHostileSelf?: boolean
): boolean;
// replayHostileSelf lets a Self area Destruction spell (Fire Storm, Blizzard) be cast on the caster's clone.
// Returns true when such a replay was queued, so the caller can guard its own player against the clone's hits.

function interruptCast(
  actorCasterFormId: number, 
  castingSource: SpellType, 
  animationVariables: ActorAnimationVariables
): void;
```

### Handling Animation Variables
```ts
function getAnimationVariablesFromActor(actorFormId: number): ActorAnimationVariables;
function applyAnimationVariablesToActor(actorFormId: number, animationVariables: ActorAnimationVariables): boolean;
```

### Potion Effects
```ts
function dispelPotionEffects(actorFormId: number, potionFormId: number): void;
// Dispels every live active effect of that potion on the actor (a drink the server refused).

function agePotionEffects(actorFormId: number, potionFormId: number, seconds: number): void;
// Ages that potion's live effects so they end as if drunk `seconds` before the newest one (a refused repeat drink).
```
Both run on the game thread and do nothing when the actor or potion is not found.

### SpellCast event handling improvments
- The `RE::TESSpellCastEvent` now triggers and handles the `spellCast` event consistently, regardless of the presence of a `MagicCaster` in the slot where the spell is located.
