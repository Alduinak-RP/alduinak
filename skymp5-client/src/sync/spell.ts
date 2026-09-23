import { Actor, ActorBase, Game, Race, Spell, printConsole } from 'skyrimPlatform';
import { BLOCKED_POWER_IDS } from '../services/services/magicSyncService';

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

  for (const owner of [ActorBase.from(actor.getBaseObject()), actor.getRace()]) {
    if (!owner) {
      continue;
    }
    const unlisted = new Array<Spell>();
    for (let i = 0; i < owner.getSpellCount(); i++) {
      const spell = owner.getNthSpell(i);
      if (spell && !listed.has(spell.getFormID())) {
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

// A race set on the base never runs SwitchRace, so other races' abilities are dispelled and the current race's are added
export const syncRaceAbilities = (actor: Actor, keep: Array<number>) => {
  const current = ActorBase.from(actor.getBaseObject())?.getRace();
  if (!current) {
    return;
  }
  const currentSpells = raceSpells(current);
  const kept = new Set([...keep, ...currentSpells.map((spell) => spell.getFormID())]);

  const others = new Array<Race>();
  for (let id = PLAYABLE_RACE_FIRST; id <= PLAYABLE_RACE_LAST; id++) {
    const race = Race.from(Game.getFormEx(id));
    if (race) {
      others.push(race);
    }
  }
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
};

// Base race with whether each of its spells' first effect is active, the added spell count and WaterBreathing, for the platform log
export const describeRaceAbilities = (actor: Actor) => {
  const race = ActorBase.from(actor.getBaseObject())?.getRace();
  const spells = race
    ? raceSpells(race).map((spell) => `${spell.getFormID().toString(16)}:${actor.hasMagicEffect(spell.getNthEffectMagicEffect(0))}`)
    : [];
  return `${race ? race.getFormID().toString(16) : 'none'} [${spells.join(' ')}] added ${actor.getSpellCount()} waterBreathing ${actor.getActorValue('WaterBreathing')}`;
};
