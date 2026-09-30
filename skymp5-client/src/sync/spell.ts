import { Actor, ActorBase, Game, MagicEffect, Race, Spell, Utility, printConsole } from 'skyrimPlatform';
import { BLOCKED_POWER_IDS } from '../services/services/magicSyncService';
import { refreshMovement } from './actorvalues';

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
const CASTING_CONSTANT_EFFECT = 0;

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

// A race set on the base never runs SwitchRace, so other races' abilities are dispelled and the current race's are added
export const syncRaceAbilities = (actor: Actor, keep: Array<number>) => {
  const current = ActorBase.from(actor.getBaseObject())?.getRace();
  if (!current) {
    return;
  }
  const currentSpells = raceSpells(current);
  const kept = new Set([...keep, ...currentSpells.map((spell) => spell.getFormID())]);

  const others = playableRaces();
  const actorRace = actor.getRace();
  if (actorRace && !others.some((race) => race.getFormID() === actorRace.getFormID())) {
    others.push(actorRace);
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

// Each spell of the base race (on, off, or a power cast on demand, and whether the server listed it), other races' abilities still running and the attribute passives, for the platform log
export const describeRaceAbilities = (actor: Actor, listed: Array<number>) => {
  const race = ActorBase.from(actor.getBaseObject())?.getRace();
  const ownSpells = race ? raceSpells(race) : [];
  const ownEffects = new Array<number>();
  const spells = ownSpells.map((spell) => {
    const effects = spellEffects(spell);
    effects.forEach((effect) => ownEffects.push(effect.getFormID()));
    const state = effects[0]?.getCastingType() !== CASTING_CONSTANT_EFFECT ? 'power' : effects.some((effect) => actor.hasMagicEffect(effect)) ? 'on' : 'off';
    return `${spell.getFormID().toString(16)} ${spell.getName()} ${state}${listed.indexOf(spell.getFormID()) === -1 ? ' unlisted' : ''}`;
  });
  const stray = new Array<string>();
  playableRaces().forEach((other) => {
    if (other.getFormID() === race?.getFormID()) {
      return;
    }
    raceSpells(other).forEach((spell) => {
      if (spellEffects(spell).some((effect) => ownEffects.indexOf(effect.getFormID()) === -1 && actor.hasMagicEffect(effect))) {
        stray.push(`${spell.getFormID().toString(16)} ${spell.getName()}`);
      }
    });
  });
  const av = (name: string) => Math.round(actor.getBaseActorValue(name));
  return `race ${race ? race.getFormID().toString(16) : 'none'} (actor race ${actor.getRace()?.getFormID().toString(16) ?? 'none'}): ${spells.join(', ') || 'no spells'}; other races running: ${stray.join(', ') || 'none'}; base health ${av('Health')} magicka ${av('Magicka')} stamina ${av('Stamina')}, unarmed ${Math.round(actor.getActorValue('UnarmedDamage'))}, waterBreathing ${actor.getActorValue('WaterBreathing')}, added ${actor.getSpellCount()}`;
};
