import { loc } from '../../loc';

// Rank names by the contract's rank index; Legendary is listed only once reached.
export const RANK_NAMES = [
  loc('mastery.rank.free'),
  loc('mastery.rank.novice'),
  loc('mastery.rank.adept'),
  loc('mastery.rank.expert'),
  loc('mastery.rank.master'),
  loc('mastery.rank.legendary')
];

export const DEFAULT_RANK_HOURS = [0, 0, 40, 100, 180, 6000];

// Craft slot names by slot index, used when the server sends none
export const SLOT_NAMES = [loc('mastery.slot.primary'), loc('mastery.slot.secondary'), loc('mastery.slot.tertiary')];

// Profession list tag of the slot that holds the craft
export const SLOT_TAGS = [loc('mastery.slot.tag1'), loc('mastery.slot.tag2'), loc('mastery.slot.tag3')];

const PROFESSION_IDS = ['blacksmith', 'tailor', 'woodworker', 'alchemist', 'cook', 'miner', 'farmer', 'hunter', 'warrior', 'mage'];

const byProfession = <T>(value: (id: string) => T): Record<string, T> => {
  const out: Record<string, T> = {};
  for (const id of PROFESSION_IDS) out[id] = value(id);
  return out;
};

// The free work that earns a secondary or tertiary craft its hours toward Novice
export const FREE_WORK: Record<string, string> = byProfession((id) => loc(`masteryFreeWork.${id}`));

export const PROFESSION_TYPES: Record<string, string> = {
  blacksmith: loc('mastery.type.crafter'),
  tailor: loc('mastery.type.crafter'),
  woodworker: loc('mastery.type.crafterGatherer'),
  alchemist: loc('mastery.type.crafterGatherer'),
  cook: loc('mastery.type.crafter'),
  miner: loc('mastery.type.gatherer'),
  farmer: loc('mastery.type.gatherer'),
  hunter: loc('mastery.type.gathererFighter'),
  warrior: loc('mastery.type.fighter'),
  mage: loc('mastery.type.fighter')
};

// Short description per rank index, Free to Legendary.
export const SHORT_DESC: Record<string, string[]> = byProfession((id) =>
  [0, 1, 2, 3, 4, 5].map((i) => loc(`masteryDesc.${id}.r${i}`)));
