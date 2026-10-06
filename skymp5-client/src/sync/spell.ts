import { Actor, ActorBase, Game, MagicEffect, Race, Spell, Utility, printConsole } from 'skyrimPlatform';
import { refreshMovement } from './actorvalues';

// The server's blockedSpells from its last racialState, kept across reconnects
const blockedPowers = new Set<number>();

export const isBlockedPower = (spellId: number): boolean => blockedPowers.has(spellId);

export const setBlockedPowers = (spellIds: Array<number>) => {
  blockedPowers.clear();
  spellIds.forEach((id) => blockedPowers.add(id));
};

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

// A Spell, or the Enchantment a staff's cast names (the spellCast event carries either)
export interface MagicWithEffects {
  getNthEffectMagicEffect(index: number): MagicEffect | null;
}

// By the first effect's casting type
export const isConcentration = (spell: MagicWithEffects | null | undefined): boolean =>
  spell?.getNthEffectMagicEffect(0)?.getCastingType() === CASTING_CONCENTRATION;

// By the first effect's delivery
export const isSelfDelivered = (spell: MagicWithEffects | null | undefined): boolean =>
  spell?.getNthEffectMagicEffect(0)?.getDeliveryType() === DELIVERY_SELF;

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
      if (spell && !listed.has(spell.getFormID()) && (!ownRace || isBlockedPower(spell.getFormID()))) {
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

// The vanilla racial abilities (Skyrim.esm ids), cleared unless the current race's record lists them (the Argonian keeps
// RaceArgonianWaterbreathing). SkyrimPlatform's loadGame starts every character from its template save, a level 1 Nord whose player
// form still carries RaceNord as an active effect, so each character loads with that 50% frost resistance; no race record lists
// RaceNord, so the race sync's removal loop never reaches it
const VANILLA_RACE_ABILITIES: Array<[number, string]> = [
  [0x0aa020, 'RaceNord'], [0x0aa01f, 'RaceBreton'], [0x0aa021, 'RaceDarkElf'], [0x0aa023, 'RaceRedguard'], [0x0aa025, 'RaceWoodElf'],
  [0x0eb7eb, 'RaceImperial'], [0x105f16, 'AbHighElfMagicka'], [0x104acf, 'RaceArgonianResistDisease'], [0x0aa01e, 'RaceKhajiitClaws'],
  [0x0aa01b, 'RaceArgonianWaterbreathing'],
];
// RaceNord, the one ability the template save carries, so it is in every character
const TEMPLATE_ABILITY = 0x0aa020;

// A vanilla racial ability found on the actor and what cleared it
export interface LeftoverAbility {
  id: number;
  name: string;
  held: boolean;
  // removeSpell's result when held; a spell held through a race record cannot be removed
  removed: boolean;
  dispelled: boolean;
  // Added and removed again because the dispel left an effect of it running
  recast: boolean;
  // An effect of it no held spell gives still runs; read again at each race check
  active: boolean;
}

export const describeLeftover = (l: LeftoverAbility): string =>
  `${l.name} ${[l.held ? (l.removed ? 'held, removed' : 'held, not removed') : '', l.dispelled ? 'dispelled' : '', l.recast ? 'cast and removed again' : ''].filter((s) => s).join(', ') || 'not dispelled'}${l.active ? ', its effect still runs' : ''}`;

type SpellOwner = { getSpellCount(): number; getNthSpell(n: number): Spell | null };

// The effects given by the spells the actor holds (added, the base's and its race's) except the suspects, so a running effect in the
// set is not a suspect's: a vampire's or a perk's ability shares AbResistFrost or AbResistMagic with the racial abilities
const explainedEffects = (actor: Actor, suspects: Set<number>): Set<number> => {
  const out = new Set<number>();
  const base = ActorBase.from(actor.getBaseObject());
  const owners: Array<SpellOwner | null | undefined> = [actor, base, base?.getRace()];
  for (const owner of owners) {
    for (let i = 0; owner && i < owner.getSpellCount(); i++) {
      const spell = owner.getNthSpell(i);
      if (spell && !suspects.has(spell.getFormID())) {
        spellEffects(spell).forEach((effect) => out.add(effect.getFormID()));
      }
    }
  }
  return out;
};

// The spell's effects no held spell gives, so a running one is the spell's own
const foreignEffects = (spell: Spell, explained: Set<number>) => spellEffects(spell).filter((effect) => !explained.has(effect.getFormID()));

const suspectIds = (others: Spell[], own: Set<number>): Set<number> =>
  new Set([...others.map((spell) => spell.getFormID()), ...VANILLA_RACE_ABILITIES.map(([id]) => id)].filter((id) => !own.has(id)));

// Vanilla racial abilities off the current race's record: dispelled, removed when held, cast and removed again when the dispel left the effect
export const clearLeftoverRaceAbilities = (actor: Actor, keep: Set<number>, explained: Set<number>): LeftoverAbility[] => {
  const out = new Array<LeftoverAbility>();
  for (const [id, name] of VANILLA_RACE_ABILITIES) {
    if (keep.has(id)) {
      continue;
    }
    const spell = Spell.from(Game.getFormEx(id));
    if (!spell) {
      continue;
    }
    const foreign = foreignEffects(spell, explained);
    const running = () => foreign.some((effect) => actor.hasMagicEffect(effect));
    const held = actor.hasSpell(spell);
    const removed = held && actor.removeSpell(spell);
    const dispelled = actor.dispelSpell(spell);
    let recast = false;
    if (!dispelled && running()) {
      recast = true;
      actor.addSpell(spell, false);
      actor.removeSpell(spell);
    }
    // Read in the sync's frame, before the engine drops a dispelled effect; the race check reads it again
    const active = running();
    // The template's ability is reported whatever was seen: a Nord's own AldRacial_Nord gives its effect, so only the dispel's result tells
    if (held || dispelled || recast || active || (id === TEMPLATE_ABILITY && !foreign.length)) {
      out.push({ id, name, held, removed, dispelled, recast, active });
      printConsole(`leftoverRaceAbility: ${describeLeftover(out[out.length - 1])}`);
    }
  }
  return out;
};

// A race set on the base never runs SwitchRace, so other races' abilities are dispelled and the current race's are added; previous is a race just left, such as a polymorph's creature form; returns the vanilla leftovers cleared
export const syncRaceAbilities = (actor: Actor, keep: Array<number>, previous: Race | null = null): LeftoverAbility[] => {
  const current = ActorBase.from(actor.getBaseObject())?.getRace();
  if (!current) {
    return [];
  }
  const currentSpells = raceSpells(current);
  const kept = new Set([...keep, ...currentSpells.map((spell) => spell.getFormID())]);

  const others = playableRaces();
  for (const race of [actor.getRace(), previous]) {
    if (race && !others.some((other) => other.getFormID() === race.getFormID())) {
      others.push(race);
    }
  }

  const otherSpells = new Array<Spell>();
  for (const race of others) {
    if (race.getFormID() === current.getFormID()) {
      continue;
    }
    for (const spell of raceSpells(race)) {
      if (kept.has(spell.getFormID())) {
        continue;
      }
      otherSpells.push(spell);
      actor.removeSpell(spell);
      if (actor.dispelSpell(spell)) {
        printConsole(`dispelledRaceSpell: ${spell.getFormID().toString(16)}, from: ${race.getFormID().toString(16)}`);
      }
    }
  }

  const leftovers = clearLeftoverRaceAbilities(actor, kept, explainedEffects(actor, suspectIds(otherSpells, kept)));

  learnSpells(
    actor,
    currentSpells.map((spell) => spell.getFormID()).filter((id) => !isBlockedPower(id)),
  );

  // The race speed ability's SpeedMult counts only once its effects have started and the movement speed is re-read
  const actorId = actor.getFormID();
  Utility.wait(2).then(() => {
    const ac = Actor.from(Game.getFormEx(actorId));
    if (ac) {
      refreshMovement(ac);
    }
  });
  return leftovers;
};

// The server's racialResync: the race sync runs again with its spells kept, and those the client's race record lacks are added to the actor; returns the added ones
export const resyncRaceAbilities = (actor: Actor, keep: Array<number>, expected: Array<number>): number[] => {
  const race = ActorBase.from(actor.getBaseObject())?.getRace();
  const onRecord = new Set(race ? raceSpells(race).map((spell) => spell.getFormID()) : []);
  const lacking = expected.filter((id) => !onRecord.has(id) && !isBlockedPower(id));
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
  // Other races' spells the actor holds
  stray: number[];
  // Effects of other races' spells running while neither the spell nor another held spell gives them
  sharedEffects: Array<{ spell: number; effect: number }>;
  // Vanilla racial abilities found this spawn and what cleared them; active as read at this check
  leftovers: Array<Omit<LeftoverAbility, 'name'>>;
  base: { health: number; magicka: number; stamina: number };
}

export interface RaceAbilityReport {
  text: string;
  // What the own race lacks and what other races still give, empty when all is in place
  problems: string[];
  data: RaceAbilityData;
}

// Each spell of the base race (on, off or a power; held per HasSpell, which the Magic menu reads; listed by the server or not), SpeedMult against the race's speed spell, other races' spells held, their effects running from no held spell, the leftovers cleared and the attribute passives, for the platform log
export const describeRaceAbilities = (actor: Actor, listed: Array<number>, found: LeftoverAbility[] = []): RaceAbilityReport => {
  const base = ActorBase.from(actor.getBaseObject());
  const race = base?.getRace();
  const speedEffectId = Game.getFormFromFile(RACE_SPEED_EFFECT_ID, RACE_SPEED_EFFECT_PLUGIN)?.getFormID() ?? 0;
  const speedMult = actor.getActorValue('SpeedMult');
  const hex = (spell: Spell) => spell.getFormID().toString(16);
  const problems = new Array<string>();
  const ownIds = new Set<number>();
  let ownSpeed = false;
  const reported = new Array<RaceAbilityData['spells'][number]>();
  const spells = (race ? raceSpells(race) : []).map((spell) => {
    ownIds.add(spell.getFormID());
    const effects = spellEffects(spell);
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
    if (!held && !isBlockedPower(spell.getFormID())) problems.push(`${hex(spell)} not held`);
    reported.push({ id: spell.getFormID(), held, state: on });
    return `${hex(spell)} ${spell.getName()} ${state}, ${held ? 'held' : 'not held'}${listed.indexOf(spell.getFormID()) === -1 ? ', unlisted' : ''}`;
  });
  // A spell is only a stray when held; an effect running that no held spell gives comes from a spell that is gone or never was held (the
  // template save's RaceNord gives every character AbResistFrost, which AldRacial_Nord also uses), so it is reported as that effect
  const strayIds = new Array<number>();
  const stray = new Array<string>();
  const sharedEffects = new Array<RaceAbilityData['sharedEffects'][number]>();
  const shared = new Array<string>();
  const otherSpells = playableRaces().filter((other) => other.getFormID() !== race?.getFormID()).flatMap(raceSpells).filter((spell) => !ownIds.has(spell.getFormID()));
  const explained = explainedEffects(actor, suspectIds(otherSpells, ownIds));
  otherSpells.forEach((spell) => {
    const running = foreignEffects(spell, explained).filter((effect) => actor.hasMagicEffect(effect));
    if (actor.hasSpell(spell)) {
      strayIds.push(spell.getFormID());
      stray.push(`${hex(spell)} ${spell.getName()}${running.length ? ' running' : ''}`);
      return;
    }
    for (const effect of running) {
      if (sharedEffects.some((s) => s.effect === effect.getFormID())) continue;
      sharedEffects.push({ spell: spell.getFormID(), effect: effect.getFormID() });
      shared.push(`${effect.getFormID().toString(16)} ${effect.getName()} (${spell.getName()}'s)`);
    }
  });
  if (stray.length) problems.push(`other races' ${stray.join(', ')} held`);
  if (shared.length) problems.push(`running without the spell: ${shared.join(', ')}`);
  // The sync read active in its own frame; whether the effect still runs is read now
  const leftovers = found.map((l) => {
    const spell = Spell.from(Game.getFormEx(l.id));
    return { ...l, active: !!spell && foreignEffects(spell, explained).some((effect) => actor.hasMagicEffect(effect)) };
  });
  const stillActive = leftovers.filter((l) => l.active);
  if (stillActive.length) problems.push(`leftover ${stillActive.map((l) => l.name).join(', ')} still running`);
  const speed = speedEffectId ? (ownSpeed ? '' : `, SpeedMult ${speedMult.toFixed(1)} with no speed spell of the race`) : ', AldRaceSpeedEffect not found';
  const av = (name: string) => Math.round(actor.getBaseActorValue(name));
  return {
    problems,
    data: {
      baseRace: race?.getFormID() ?? 0,
      engineRace: actor.getRace()?.getFormID() ?? 0,
      spells: reported,
      stray: strayIds,
      sharedEffects,
      leftovers: leftovers.map(({ id, held, removed, dispelled, recast, active }) => ({ id, held, removed, dispelled, recast, active })),
      base: { health: actor.getBaseActorValue('Health'), magicka: actor.getBaseActorValue('Magicka'), stamina: actor.getBaseActorValue('Stamina') },
    },
    text: `race ${race ? race.getFormID().toString(16) : 'none'} (actor race ${actor.getRace()?.getFormID().toString(16) ?? 'none'}, sex ${base?.getSex() ?? '?'}): ` +
      `${spells.join('; ') || 'no spells'}${speed}; other races' spells held: ${stray.join(', ') || 'none'}; ` +
      `their effects running without the spell: ${shared.join(', ') || 'none'}; vanilla leftovers: ${leftovers.map(describeLeftover).join(', ') || 'none'}; ` +
      `base health ${av('Health')} magicka ${av('Magicka')} stamina ${av('Stamina')}, unarmed ${Math.round(actor.getActorValue('UnarmedDamage'))}, ` +
      `waterBreathing ${actor.getActorValue('WaterBreathing')}, added ${actor.getSpellCount()}; ${problems.length ? `amiss: ${problems.join(', ')}` : 'all in place'}`,
  };
};
