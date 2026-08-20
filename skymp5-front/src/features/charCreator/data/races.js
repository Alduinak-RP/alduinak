// Species and race catalog for the character creator.
// Form ids were extracted from the live server load order (Skyrim.esm + DLC).
// `placeholder: true` marks races that reuse a vanilla race until a custom esp
// lands in AlduinakPatchMerged; swap `raceId` there when the esp is ready.
// Lore blurbs are placeholders for the server's own descriptions.

const NORD = 0x13746;
const IMPERIAL = 0x13744;
const REDGUARD = 0x13748;
const BRETON = 0x13741;
const HIGHELF = 0x13743;
const DARKELF = 0x13742;
const WOODELF = 0x13749;
const ORC = 0x13747;
const KHAJIIT = 0x13745;
const ARGONIAN = 0x13740;
const DREMORA = 0x131f0;
const FALMER = 0x131f4;
const GIANT = 0x131f9;
const RIEKLING = 0x04017f44; // DLC2RieklingRace (Dragonborn.esm at load index 4)

export const AGES = [
  { id: 'child', name: 'Child' },
  { id: 'adolescent', name: 'Adolescent' },
  { id: 'adult', name: 'Adult' },
  { id: 'midlife', name: 'Midlife' },
  { id: 'elder', name: 'Elder' }
];

export const SPECIES = [
  {
    id: 'human',
    name: 'Human',
    blurb: 'The young races of Men: adaptable, ambitious, and short-lived.',
    races: [
      {
        id: 'nord',
        name: 'Nord',
        raceId: NORD,
        raceEditorId: 'NordRace',
        childRaceId: 0x2c65b,
        faceGen: true,
        lore: 'Hardy warrior-folk of Skyrim, born to the cold. Strong, proud, and resistant to frost.'
      },
      {
        id: 'nibenese',
        name: 'Nibenese',
        raceId: IMPERIAL,
        raceEditorId: 'ImperialRace',
        childRaceId: 0x2c659,
        faceGen: true,
        lore: 'Imperials of the eastern heartland of Cyrodiil: merchants, diplomats, and devout followers of the Divines.'
      },
      {
        id: 'colovian',
        name: 'Colovian',
        raceId: IMPERIAL,
        raceEditorId: 'ImperialRace',
        childRaceId: 0x2c659,
        faceGen: true,
        placeholder: true,
        lore: 'Western Imperials of the Colovian highlands: pragmatic soldiers and frontiersmen of Cyrodiil.'
      },
      {
        id: 'redguard',
        name: 'Redguard',
        raceId: REDGUARD,
        raceEditorId: 'RedguardRace',
        childRaceId: 0x2c658,
        faceGen: true,
        lore: 'Sword-singers of Hammerfell, among the finest warriors of Tamriel, descended from lost Yokuda.'
      },
      {
        id: 'breton',
        name: 'Breton',
        raceId: BRETON,
        raceEditorId: 'BretonRace',
        childRaceId: 0x2c65c,
        faceGen: true,
        lore: 'Manmer of High Rock: gifted mages with elven blood and a natural knack for resisting magic.'
      },
      {
        id: 'reachfolk',
        name: 'Reachfolk',
        raceId: BRETON,
        raceEditorId: 'BretonRace',
        childRaceId: 0x2c65c,
        faceGen: true,
        placeholder: true,
        lore: 'Clans of the Reach: hedge-witches and hunters who keep the old gods, scorned by outsiders as Forsworn.'
      },
      {
        id: 'akaviri',
        name: 'Akaviri',
        raceId: IMPERIAL,
        raceEditorId: 'ImperialRace',
        childRaceId: 0x2c659,
        faceGen: true,
        placeholder: true,
        lore: 'Descendants of invaders from the eastern continent of Akavir, rare blademasters in Tamriel.'
      },
      {
        id: 'giant',
        name: 'Giant',
        raceId: GIANT,
        raceEditorId: 'GiantRace',
        faceGen: false,
        lore: 'Towering mammoth-herders of the tundra, an ancient folk. Few ever walk among the small races.'
      }
    ]
  },
  {
    id: 'mer',
    name: 'Mer',
    blurb: 'The elder races of Elves: long-lived heirs of the Aldmer.',
    races: [
      {
        id: 'altmer',
        name: 'Altmer',
        raceId: HIGHELF,
        raceEditorId: 'HighElfRace',
        faceGen: true,
        lore: 'High Elves of the Summerset Isles: proud, long-lived, and the most magically gifted of mer.'
      },
      {
        id: 'dunmer',
        name: 'Dunmer',
        raceId: DARKELF,
        raceEditorId: 'DarkElfRace',
        faceGen: true,
        lore: 'Dark Elves of Morrowind: ash-born survivors who balance ancestor worship and Daedric faith.'
      },
      {
        id: 'bosmer',
        name: 'Bosmer',
        raceId: WOODELF,
        raceEditorId: 'WoodElfRace',
        faceGen: true,
        lore: 'Wood Elves of Valenwood: unmatched archers bound by the Green Pact never to harm the forest.'
      },
      {
        id: 'orsimer',
        name: 'Orsimer',
        raceId: ORC,
        raceEditorId: 'OrcRace',
        faceGen: true,
        lore: 'Orcs of the strongholds: outcast mer forged by Malacath into peerless smiths and warriors.'
      },
      {
        id: 'maormer',
        name: 'Maormer',
        raceId: HIGHELF,
        raceEditorId: 'HighElfRace',
        faceGen: true,
        placeholder: true,
        lore: 'Sea Elves of Pyandonea: serpent-charming raiders with chameleon skin, ancient foes of the Altmer.'
      },
      {
        id: 'falmer',
        name: 'Falmer',
        raceId: FALMER,
        raceEditorId: 'FalmerRace',
        faceGen: false,
        lore: 'The betrayed Snow Elves: twisted, blinded dwellers of the deep dark beneath Skyrim.'
      }
    ]
  },
  {
    id: 'daedra',
    name: 'Daedra',
    blurb: 'Immortal spirits of Oblivion, clad in mortal-seeming flesh.',
    // All daedra reuse DremoraRace until dedicated races exist.
    races: [
      { id: 'dremora', name: 'Dremora', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, lore: 'Warrior-caste Daedra sworn to clan and Prince, bound by rigid codes of honor and hierarchy.' },
      { id: 'aureal', name: 'Aureal', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Golden Saints of the Shivering Isles, Sheogorath\'s proud and lawful soldiers.' },
      { id: 'mazken', name: 'Mazken', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Dark Seducers of the Shivering Isles: disciplined, shadow-loyal warriors of Dementia.' },
      { id: 'xivkyn', name: 'Xivkyn', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Hybrid Daedra of Coldharbour, vat-bred from Dremora and Xivilai by Molag Bal.' },
      { id: 'xivilai', name: 'Xivilai', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Towering, prideful Daedra of raw strength and magic who chafe under any master.' },
      { id: 'huntsman', name: 'Huntsman', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Hircine\'s stalkers: horned hunters that run down their prey across the Hunting Grounds.' },
      { id: 'shrike', name: 'Shrike', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Swift, cruel skirmishers woven from the webs of Mephala\'s court.' },
      { id: 'auroran', name: 'Auroran', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Meridia\'s knightly host, radiant in beaten gold and burning light.' },
      { id: 'heme', name: 'Heme', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Lesser Daedra of blood and hunger, rarely seen outside their Prince\'s realm.' },
      { id: 'skaafin', name: 'Skaafin', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Horned schemers of the Fields of Regret, brokers of Clavicus Vile\'s bargains.' },
      { id: 'spiderkith', name: 'Spiderkith', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Spider-blessed weavers of Mephala, half-kin to the swarming broods they tend.' },
      { id: 'havocrel', name: 'Havocrel', raceId: DREMORA, raceEditorId: 'DremoraRace', faceGen: true, placeholder: true, lore: 'Giant swordbearers of the planes, rare and terribly destructive.' }
    ]
  },
  {
    id: 'khajiit',
    name: 'Khajiit',
    blurb: 'Cat-folk of Elsweyr, whose form is written by the moons at birth.',
    // All furstocks reuse KhajiitRace until furstock mods land.
    races: [
      { id: 'cathay', name: 'Cathay', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, lore: 'The most common furstock seen abroad: plantigrade, man-sized cat-folk, versatile and strong.' },
      { id: 'suthay', name: 'Suthay', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, placeholder: true, lore: 'Slender, digitigrade furstock, quick of finger and quicker of wit.' },
      { id: 'tojay', name: 'Tojay', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, placeholder: true, lore: 'Mysterious furstock of the southern marshes and the Tenmar forest.' },
      { id: 'pahmar', name: 'Pahmar', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, placeholder: true, lore: 'Tiger-sized furstock that walks on four paws; fierce and fearless in battle.' },
      { id: 'senche', name: 'Senche', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, placeholder: true, lore: 'Great mount-sized furstock, often serving their kin as steed and battle-companion.' },
      { id: 'alfiq', name: 'Alfiq', raceId: KHAJIIT, raceEditorId: 'KhajiitRace', faceGen: true, placeholder: true, lore: 'House-cat-sized furstock, fully able to understand speech, and to cast spells.' }
    ]
  },
  {
    id: 'argonian',
    name: 'Argonian',
    blurb: 'Reptilian people of Black Marsh, shaped by the Hist.',
    // All lineages reuse ArgonianRace until dedicated races land.
    races: [
      { id: 'saxhleel', name: 'Saxhleel', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, lore: 'The People of the Root, as Argonians name themselves: the common folk of Black Marsh.' },
      { id: 'agaceph', name: 'Agaceph', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Needle-faced Argonians of the deep swamps, rarely seen by outsiders.' },
      { id: 'hapsleet', name: 'Hapsleet', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Stocky, broad Argonian stock of the settled river-villages.' },
      { id: 'mihuitleel', name: 'Mihuitleel', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'A rare, Hist-blessed lineage of the inner marsh.' },
      { id: 'naga', name: 'Naga', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Towering serpent-folk of the inner swamps, with crocodile jaws and puff-adder hoods.' },
      { id: 'nakadesh', name: 'Naka-Desh', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Eel-like Argonians said to swim the deepest waterways of Black Marsh.' },
      { id: 'paatru', name: 'Paatru', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Toad-like Argonians of the deep marsh: slow on land, deadly in the water.' },
      { id: 'sarpa', name: 'Sarpa', raceId: ARGONIAN, raceEditorId: 'ArgonianRace', faceGen: true, placeholder: true, lore: 'Winged Argonians of legend, rarely if ever seen by outsiders.' }
    ]
  },
  {
    id: 'other',
    name: 'Other',
    blurb: 'The beast-folk and wild peoples of Tamriel\'s fringes.',
    races: [
      {
        id: 'goblin',
        name: 'Goblin',
        raceId: RIEKLING,
        raceEditorId: 'DLC2RieklingRace',
        faceGen: false,
        placeholder: true,
        lore: 'Tribal green-skinned raiders found in caves and ruins across Tamriel, stronger than they look.'
      },
      {
        id: 'riekling',
        name: 'Riekling',
        raceId: RIEKLING,
        raceEditorId: 'DLC2RieklingRace',
        faceGen: false,
        lore: 'Small blue tribesfolk of Solstheim, riding boars and hurling crude spears.'
      }
    ]
  }
];

export function findSpecies(speciesId) {
  return SPECIES.find(s => s.id === speciesId) || null;
}

export function findRace(raceSlug) {
  for (const species of SPECIES) {
    const race = species.races.find(r => r.id === raceSlug);
    if (race) return { species, race };
  }
  return null;
}

// The race form id to apply for a given age; children use vanilla child races
// where they exist, everyone else keeps the base race.
export function raceIdFor(race, age) {
  if (age === 'child' && race.childRaceId) return race.childRaceId;
  return race.raceId;
}
