// Rank names by the contract's rank index; Legendary is listed only once reached.
export const RANK_NAMES = ['Free', 'Novice', 'Adept', 'Expert', 'Master', 'Legendary'];

export const DEFAULT_RANK_HOURS = [0, 0, 40, 100, 180, 6000];

// Craft slot names by slot index, used when the server sends none
export const SLOT_NAMES = ['Primary', 'Secondary', 'Tertiary'];

// Profession list tag of the slot that holds the craft
export const SLOT_TAGS = ['1st', '2nd', '3rd'];

// The free work that earns a secondary or tertiary craft its hours toward Novice
export const FREE_WORK: Record<string, string> = {
  blacksmith: 'nails, iron fittings, locks and hinges at the forge, the Bandit armour tempers, and sea salt and charcoal at the smelter.',
  tailor: 'leather strips, fur armour and blank parchment, journals and books at the tanning rack, thread and the roughspun tunic at the loom, and the Bandit armour tempers.',
  woodworker: 'the blank parchment, journal and book at the woodcrafting bench, charcoal, and chopping wood at a chopping block.',
  alchemist: 'honey at the alchemy lab, any drink at a meadery boiler, and picking plants and trees.',
  cook: 'salmon steak, rabbit haunch, pheasant roast, chicken breast and honey at the cooking pot, and any drink at a meadery boiler.',
  miner: 'mining iron veins and sea salt deposits, and sea salt and charcoal at the smelter.',
  farmer: 'picking plants and trees, and crops with a hoe.',
  hunter: 'killing animals, and the free recipes of the tanning rack.',
  warrior: 'any kill of a person or creature.',
  mage: 'casting any spell; learn one from a tome first.'
};

export const PROFESSION_TYPES: Record<string, string> = {
  blacksmith: 'Crafter',
  tailor: 'Crafter',
  woodworker: 'Crafter/Gatherer',
  alchemist: 'Crafter/Gatherer',
  cook: 'Crafter',
  miner: 'Gatherer',
  farmer: 'Gatherer',
  hunter: 'Gatherer/Fighter',
  warrior: 'Fighter',
  mage: 'Fighter'
};

// Short description per rank index, Free to Legendary.
export const SHORT_DESC: Record<string, string[]> = {
  blacksmith: [
    'Basic Crude Items',
    'Iron & Corundum Equipment',
    'Steel, Gold, and Silver Equipment',
    'Dwarven and Racial Equipment',
    'Glass, Ebony, and Master Racial Equipment',
    'Daedric and Dragon Equipment'
  ],
  tailor: [
    'Roughspun and Fur Clothing',
    'Hide Armor and Basic Clothes',
    'Studded Armor and Fine Clothing',
    'Leather Armor and Bags',
    'Scaled Armor and Noble Clothing',
    'Daedric Clothing'
  ],
  woodworker: [
    'Chop Wood and Burn Charcoal',
    'Simple Bows, Arrows, and Shields',
    'Steel, Silver, and Racial Equipment',
    'Dwarven and Racial Equipment',
    'Glass, Ebony, and Master Racial Equipment',
    'Daedric and Dragon Equipment'
  ],
  miner: [
    'Mine Iron',
    'Corundum; Smelt Iron and Corundum',
    'Smelt Gold, Silver, and Steel',
    'Orichalcum and Moonstone',
    'Malachite, Quicksilver, Ebony, and Stalhrim',
    'Amber and Madness'
  ],
  farmer: [
    'Pick Plants (5 s)',
    'Pick in 3 s',
    'Pick in 1 s',
    'Pick Instantly',
    'Double Harvest',
    'Quadruple Harvest'
  ],
  mage: ['100 Magicka', '125 Magicka', '150 Magicka', '175 Magicka', '200 Magicka', '500 Magicka'],
  alchemist: [
    'Gather Ingredients',
    'Minor potions of healing, magicka and stamina.',
    'Weak poisons, and the weak aversions.',
    'The plain potions of every school, attribute and resistance.',
    'Draughts, philters and elixirs: the strongest work of the lab.',
    'The Masterwork of the Lab'
  ],
  cook: [
    'Simple Fare',
    'Steaks, roasts and grilled fish.',
    'Soups and stews.',
    'Baking: bread, sweet rolls and dumplings.',
    'Gourmet dishes, pies and crostatas.',
    'A Feast Fit for a Jarl'
  ],
  hunter: [
    'Common Hunting',
    'The pelts and hides only a hunter can take whole.',
    'A faster draw and a steadier aim afield.',
    'A longer hold on a drawn bow.',
    'The full craft of the chase.',
    'Legend of the Hunt'
  ],
  warrior: [
    'Basic Combat',
    'Lighter power attacks with one hand or two, and deeper wind.',
    'A faster off hand, the power bash, a shield carried at speed, and light armour that weighs nothing.',
    'The charge, and heavy armour that weighs nothing.',
    "The sweeping blow, a warmaster's reach, and a heavier pack.",
    'Legend of the Field'
  ]
};
