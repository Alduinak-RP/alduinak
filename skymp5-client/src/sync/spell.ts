import { Actor, ActorBase, Game, Spell, printConsole } from 'skyrimPlatform';

export const removeAllSpells = (actor: Actor) => {
  let spellToRemove = new Array<Spell>();

  for (let i = 0; i < actor.getSpellCount(); i++) {
    const spell = actor.getNthSpell(i);

    if (spell) {
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
