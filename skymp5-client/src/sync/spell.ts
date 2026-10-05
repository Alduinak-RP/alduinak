import { Actor, ActorBase, Game, MagicEffect, Race, Spell, Utility, printConsole } from 'skyrimPlatform';
import { BLOCKED_POWER_IDS } from '../services/services/magicSyncService';
import { refreshMovement } from './actorvalues';

// MagicEffect flags, delivery types and casting types as the engine numbers them
export const EFFECT_FLAG_HOSTILE = 0x1;
export const EFFECT_FLAG_RECOVER = 0x2;
export const EFFECT_FLAG_DETRIMENTAL = 0x4;
export const DELIVERY_SELF = 0;
export const DELIVERY_CONTACT = 1;
export const CASTING_CONSTANT_EFFECT = 0;
export const CASTING_FIRE_AND_FORGET = 1;
export const CASTING_CONCENTRATION = 2;

// Hostile or detrimental
export const isHarmfulEffect = (effect: MagicEffect): boolean =>
  effect.isEffectFlagSet(EFFECT_FLAG_HOSTILE) || effect.isEffectFlagSet(EFFECT_FLAG_DETRIMENTAL);

// Listed spells stay, removing and re-adding one in the same frame would dispel and recast it
export const removeUnlistedSpells = (actor: Actor, spellsIds: Array<number>) => {
  let spellToRemove = new Array<Spell>();
  const listed = new Set(spellsIds);

  for (let i = 0; i < actor.getSpellCount(); i++) {
    const spell = actor.getNthSpell(i);

    if (spell && !listed.has(spell.getFormID())) {
      spellToRemove.push(spell);
    }
  }

  for (let spell of spellToRemove) {
    const removeResult = actor.removeSpell(spell);
    printConsole(
      `removeResult: ${removeResult}, spellIdToRemove: ${spell
        .getFormID()
        .toString(16)}, spellName: ${spell.getName()}`,
    );
  }
};

export type SpellListNatives = {
  removeSpellFromList?: (ownerFormId: number, spellFormId: number) => void;
};

// Papyrus RemoveSpell cannot reach NPC_ or RACE spells, so the ones the server does not list are cut from those records
export const dropUnlistedBaseSpells = (natives: SpellListNatives, actor: Actor, spellsIds: Array<number>) => {
  if (!spellsIds.length) {
    return;
  }
  if (!natives.removeSpellFromList) {
    printConsole('dropUnlistedBaseSpells: removeSpellFromList is missing, SkyrimPlatform is outdated');
  }
  const listed = new Set(spellsIds);
  const ownRaceId = ActorBase.from(actor.getBaseObject())?.getRace()?.getFormID();

  for (const owner of [ActorBase.from(actor.getBaseObject()), actor.getRace()]) {
    if (!owner) {
      continue;
    }
    // A cut lasts the whole game session, so the character's own race only ever loses the withheld greater powers
    const ownRace = owner.getFormID() === ownRaceId;
    const unlisted = new Array<Spell>();
    for (let i = 0; i < owner.getSpellCount(); i++) {
      const spell = owner.getNthSpell(i);
      if (spell && !listed.has(spell.getFormID()) && (!ownRace || BLOCKED_POWER_IDS.has(spell.getFormID()))) {
        unlisted.push(spell);
      }
    }
    for (const spell of unlisted) {
      natives.removeSpellFromList?.(owner.getFormID(), spell.getFormID());
      actor.removeSpell(spell);
      for (const source of [0, 1, 2]) {
        actor.unequipSpell(spell, source);
      }
      printConsole(
        `droppedSpell: ${spell.getFormID().toString(16)}, spellName: ${spell.getName()}, from: ${owner
          .getFormID()
          .toString(16)}`,
      );
    }
  }
};

export const learnSpells = (actor: Actor, spellsIds: Array<number>) => {
  for (let spellId of spellsIds) {
    const spell = Spell.from(Game.getFormEx(spellId));

    if (spell) {
      const addResult = actor.addSpell(spell, false);
      printConsole(
        `addResult: ${addResult}, spellIdToLearn: ${spell
          .getFormID()
          .toString(16)}, spellName: ${spell.getName()}`,
      );
    }
  }
};

const PLAYABLE_RACE_FIRST = 0x13740;
const PLAYABLE_RACE_LAST = 0x13749;

const raceSpells = (race: Race) => {
  const spells = new Array<Spell>();
  for (let i = 0; i < race.getSpellCount(); i++) {
    const spell = race.getNthSpell(i);
    if (spell) {
      spells.push(spell);
    }
  }
  return spells;
};

const playableRaces = () => {
  const races = new Array<Race>();
  for (let id = PLAYABLE_RACE_FIRST; id <= PLAYABLE_RACE_LAST; id++) {
    const race = Race.from(Game.getFormEx(id));
    if (race) {
      races.push(race);
    }
  }
  return races;
};

const spellEffects = (spell: Spell) => {
  const effects = new Array<MagicEffect>();
  for (let i = 0; i < spell.getNumEffects(); i++) {
    const effect = spell.getNthEffectMagicEffect(i);
    if (effect) {
      effects.push(effect);
    }
  }
  return effects;
};

// A race set on the base never runs SwitchRace, so other races' abilities are dispelled and the current race's are added; previous is a race just left, such as a polymorph's creature form
export const syncRaceAbilities = (actor: Actor, keep: Array<number>, previous: Race | null = null) => {
  const current = ActorBase.from(actor.getBaseObject())?.getRace();
  if (!current) {
    return;
  }
  const currentSpells = raceSpells(current);
  const kept = new Set([...keep, ...currentSpells.map((spell) => spell.getFormID())]);

  const others = playableRaces();
  for (const race of [actor.getRace(), previous]) {
    if (race && !others.some((other) => other.getFormID() === race.getFormID())) {
      others.push(race);
    }
  }

  for (const race of others) {
    if (race.getFormID() === current.getFormID()) {
      continue;
    }
    for (const spell of raceSpells(race)) {
      if (kept.has(spell.getFormID())) {
        continue;
      }
      actor.removeSpell(spell);
      if (actor.dispelSpell(spell)) {
        printConsole(`dispelledRaceSpell: ${spell.getFormID().toString(16)}, from: ${race.getFormID().toString(16)}`);
      }
    }
  }

  learnSpells(
    actor,
    currentSpells.map((spell) => spell.getFormID()).filter((id) => !BLOCKED_POWER_IDS.has(id)),
  );

  // The race speed ability's SpeedMult counts only once its effects have started and the movement speed is re-read
  const actorId = actor.getFormID();
  Utility.wait(2).then(() => {
    const ac = Actor.from(Game.getFormEx(actorId));
    if (ac) {
      refreshMovement(ac);
    }
  });
};

// The server's racialResync: the race sync runs again with its spells kept, and those the client's race record lacks are added to the actor; returns the added ones
export const resyncRaceAbilities = (actor: Actor, keep: Array<number>, expected: Array<number>): number[] => {
  const race = ActorBase.from(actor.getBaseObject())?.getRace();
  const onRecord = new Set(race ? raceSpells(race).map((spell) => spell.getFormID()) : []);
  const lacking = expected.filter((id) => !onRecord.has(id) && !BLOCKED_POWER_IDS.has(id));
  syncRaceAbilities(actor, [...keep, ...expected]);
  learnSpells(actor, lacking);
  return lacking;
};

// AldRaceSpeedEffect, the one SpeedMult effect all AldRaceSpeed_* spells share
const RACE_SPEED_EFFECT_ID = 0x041324;
const RACE_SPEED_EFFECT_PLUGIN = 'AlduinakAdditions.esp';
// SpeedMult may sit this far from base plus the speed spell's value before the log notes other speed effects
const SPEED_MULT_TOLERANCE = 0.5;

// The racialReport fields the server compares (racialSystem.ts); a speed spell reads on while its effect runs
export interface RaceAbilityData {
  baseRace: number;
  engineRace: number;
  spells: Array<{ id: number; held: boolean; state: 'on' | 'off' | 'power' }>;
  stray: number[];
  base: { health: number; magicka: number; stamina: number };
}

export interface RaceAbilityReport {
  text: string;
  // What the own race lacks and what other races still give, empty when all is in place
  problems: string[];
  data: RaceAbilityData;
}

// Each spell of the base race (on, off or a power; held per HasSpell, which the Magic menu reads; listed by the server or not), SpeedMult against the race's speed spell, other races' spells running or held and the attribute passives, for the platform log
export const describeRaceAbilities = (actor: Actor, listed: Array<number>): RaceAbilityReport => {
  const base = ActorBase.from(actor.getBaseObject());
  const race = base?.getRace();
  const speedEffectId = Game.getFormFromFile(RACE_SPEED_EFFECT_ID, RACE_SPEED_EFFECT_PLUGIN)?.getFormID() ?? 0;
  const speedMult = actor.getActorValue('SpeedMult');
  const hex = (spell: Spell) => spell.getFormID().toString(16);
  const problems = new Array<string>();
  const ownIds = new Set<number>();
  const ownEffects = new Set<number>();
  let ownSpeed = false;
  const reported = new Array<RaceAbilityData['spells'][number]>();
  const spells = (race ? raceSpells(race) : []).map((spell) => {
    ownIds.add(spell.getFormID());
    const effects = spellEffects(spell);
    effects.forEach((effect) => ownEffects.add(effect.getFormID()));
    const held = actor.hasSpell(spell);
    let state: string;
    let on: 'on' | 'off' | 'power';
    const speedEffect = speedEffectId ? effects.find((effect) => effect.getFormID() === speedEffectId) : undefined;
    if (speedEffect) {
      // One effect for both sexes, else the male one first; cold stages, diseases and other speed effects move SpeedMult too
      ownSpeed = true;
      const expected = actor.getBaseActorValue('SpeedMult') + spell.getNthEffectMagnitude(spell.getNumEffects() > 1 ? base?.getSex() ?? 0 : 0);
      on = held && actor.hasMagicEffect(speedEffect) ? 'on' : 'off';
      const others = Math.abs(speedMult - expected) > SPEED_MULT_TOLERANCE ? ', other speed effects count' : '';
      state = `${on}, SpeedMult ${speedMult.toFixed(1)} of ${expected.toFixed(1)}${others}`;
      if (on === 'off') problems.push(`${hex(spell)} speed effect off`);
    } else if (effects[0]?.getCastingType() !== CASTING_CONSTANT_EFFECT) {
      state = on = 'power';
    } else {
      state = on = effects.some((effect) => actor.hasMagicEffect(effect)) ? 'on' : 'off';
      if (state === 'off') problems.push(`${hex(spell)} off`);
    }
    if (!held && !BLOCKED_POWER_IDS.has(spell.getFormID())) problems.push(`${hex(spell)} not held`);
    reported.push({ id: spell.getFormID(), held, state: on });
    return `${hex(spell)} ${spell.getName()} ${state}, ${held ? 'held' : 'not held'}${listed.indexOf(spell.getFormID()) === -1 ? ', unlisted' : ''}`;
  });
  const strayIds = new Array<number>();
  const stray = new Array<string>();
  playableRaces().forEach((other) => {
    if (other.getFormID() === race?.getFormID()) {
      return;
    }
    raceSpells(other).forEach((spell) => {
      if (ownIds.has(spell.getFormID())) {
        return;
      }
      const running = spellEffects(spell).some((effect) => !ownEffects.has(effect.getFormID()) && actor.hasMagicEffect(effect));
      const held = actor.hasSpell(spell);
      if (running || held) {
        strayIds.push(spell.getFormID());
        stray.push(`${hex(spell)} ${spell.getName()} ${running && held ? 'running and held' : running ? 'running' : 'held'}`);
      }
    });
  });
  if (stray.length) problems.push(`other races' ${stray.join(', ')}`);
  const speed = speedEffectId ? (ownSpeed ? '' : `, SpeedMult ${speedMult.toFixed(1)} with no speed spell of the race`) : ', AldRaceSpeedEffect not found';
  const av = (name: string) => Math.round(actor.getBaseActorValue(name));
  return {
    problems,
    data: {
      baseRace: race?.getFormID() ?? 0,
      engineRace: actor.getRace()?.getFormID() ?? 0,
      spells: reported,
      stray: strayIds,
      base: { health: actor.getBaseActorValue('Health'), magicka: actor.getBaseActorValue('Magicka'), stamina: actor.getBaseActorValue('Stamina') },
    },
    text: `race ${race ? race.getFormID().toString(16) : 'none'} (actor race ${actor.getRace()?.getFormID().toString(16) ?? 'none'}, sex ${base?.getSex() ?? '?'}): ` +
      `${spells.join('; ') || 'no spells'}${speed}; other races running or held: ${stray.join(', ') || 'none'}; ` +
      `base health ${av('Health')} magicka ${av('Magicka')} stamina ${av('Stamina')}, unarmed ${Math.round(actor.getActorValue('UnarmedDamage'))}, ` +
      `waterBreathing ${actor.getActorValue('WaterBreathing')}, added ${actor.getSpellCount()}; ${problems.length ? `amiss: ${problems.join(', ')}` : 'all in place'}`,
  };
};
