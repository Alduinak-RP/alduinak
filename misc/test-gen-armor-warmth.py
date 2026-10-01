"""Rule tests of the warmth table generator: python misc/test-gen-armor-warmth.py"""
import importlib.util
import os
import sys
import unittest

sys.dont_write_bytecode = True
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('gen_armor_warmth', os.path.join(HERE, 'gen-armor-warmth.py'))
G = importlib.util.module_from_spec(spec)
spec.loader.exec_module(G)

_next = iter(range(0x800, 0x900))


def rec(name, slots, plugin='Mod.esp', edid='', keywords='', template=None, non_playable=0):
    n = next(_next)
    return dict(key=(plugin.lower(), n), desc=f'{n:x}:{plugin}', name=name, edid=edid or name.replace(' ', ''),
                keywords=keywords, biped_slots=slots, template_key=template and template['key'], armor_type='Light',
                non_playable=non_playable)


class Rules(unittest.TestCase):
    def rate(self, *armors):
        return {a['desc']: (kind, value, why) for a, kind, value, why in G.classify(list(armors))}

    def test_rated_slots(self):
        fur = rec('Fur Armor', '32:Body', 'Skyrim.esm', keywords='ArmorLight Survival_ArmorWarm')
        iron = rec('Iron Armor', '32:Body', 'Skyrim.esm')
        ench = rec('Fur Armor of Health', '32:Body', 'Skyrim.esm', template=fur)
        same = rec('Iron Armor', '32:Body', edid='ModFurIronArmor')
        robe = rec('Tribunal Robe', '32:Body', edid='ModTribunalRobeNoCloak')
        quilted = rec('Quilted Robe', '32:Body')
        hooded = rec('Hooded Tribunal Robe', '32:Body 31:Hair')
        cowl = rec('Ranger Hood', '31:Hair')
        mage = rec('Battlemage Mage Hood', '31:Hair')
        named = rec('Nordic Vanguard Armor', '32:Body')
        hood = rec('Outfit', '32:Body', edid='ModOutfitBlueNoHood')
        rags = rec('Ragged Fur Robes', '32:Body')
        plate = rec('Vanguard Plate Armor', '32:Body')
        nordic = rec('Carved Armor', '32:Body', keywords='DLC2ArmorMaterialNordicHeavy')
        hidden = rec('Skin', '32:Body', non_playable=1)
        out = self.rate(fur, iron, ench, same, robe, quilted, hooded, cowl, mage, named, hood, rags, plate, nordic, hidden)
        self.assertEqual(out[fur['desc']], ('rated', 'warm', 'keyword'))
        self.assertEqual(out[iron['desc']], ('rated', 'normal', 'vanilla'))
        self.assertEqual(out[ench['desc']], ('rated', 'warm', 'template'))
        self.assertEqual(out[same['desc']], ('rated', 'normal', 'vanilla name'))
        self.assertEqual(out[robe['desc']], ('rated', 'normal', 'words'))
        self.assertEqual(out[quilted['desc']], ('rated', 'warm', 'words'))
        self.assertEqual(out[hooded['desc']], ('rated', 'warm', 'words'))
        self.assertEqual(out[cowl['desc']], ('rated', 'normal', 'words'))
        self.assertEqual(out[mage['desc']], ('rated', 'warm', 'words'))
        self.assertEqual(out[named['desc']], ('rated', 'normal', 'words'))
        self.assertEqual(out[hood['desc']], ('rated', 'normal', 'words'))
        self.assertEqual(out[rags['desc']], ('rated', 'cold', 'words'))
        self.assertEqual(out[plate['desc']], ('rated', 'normal', 'words'))
        self.assertEqual(out[nordic['desc']], ('rated', 'warm', 'words'))
        self.assertNotIn(hidden['desc'], out)

    def test_namesake_by_covered_parts(self):
        vanilla = rec('Vampire Hood', '31:Hair 42:Circlet', 'Dawnguard.esm')
        warm = rec('Mage Hood', '31:Hair', 'Skyrim.esm', keywords='Survival_ArmorWarm')
        mod = rec('Vampire Hood', '31:Hair', edid='ModFurHoodVampire')
        other = rec('Mage Hood', '30:Head 31:Hair 42:Circlet')
        boots = rec('Vampire Hood', '37:Feet', edid='ModFurBoots')
        out = self.rate(vanilla, warm, mod, other, boots)
        self.assertEqual(out[mod['desc']], ('rated', 'normal', 'vanilla name'))
        self.assertEqual(out[other['desc']], ('rated', 'warm', 'vanilla name'))
        self.assertEqual(out[boots['desc']], ('rated', 'warm', 'words'))

    def test_mod_rated_by_its_author(self):
        rated = rec('Wolf Fur Armor', '32:Body', 'Aware.esp', keywords='Survival_ArmorWarm')
        left = rec('Fur Lined Scaled Armor', '32:Body', 'Aware.esp')
        ench = rec('Fur Lined Scaled Armor of Health', '32:Body', 'Aware.esp', template=left)
        cloak = rec('Fur Cloak', '46', 'Aware.esp')
        unrated = rec('Fur Lined Boots', '37:Feet', 'Plain.esp')
        out = self.rate(rated, left, ench, cloak, unrated)
        self.assertEqual(out[left['desc']], ('rated', 'normal', 'rated mod'))
        self.assertEqual(out[ench['desc']], ('rated', 'normal', 'template'))
        self.assertEqual(out[cloak['desc']][:2], ('extra', 20))
        self.assertEqual(out[unrated['desc']], ('rated', 'warm', 'words'))

    def test_other_slots(self):
        rows = [(rec('Fur Cloak (Black)', '40:Tail 46'), 20), (rec('Linen Cape (Red)', '40:Tail 46'), 12),
                (rec('Bosmer Shoulder Cape', '40:Tail 46'), 6), (rec('Large Fur Collar', '46'), 8),
                (rec('Gathered Scarf', '45'), 5), (rec('Woven Scarf', '45', keywords='Survival_ArmorWarm'), 8),
                (rec('Rugged Mask', '44'), 3), (rec('Reinforced Backpack', '47'), 0), (rec('Fur Backpack', '46'), 0),
                (rec('Hide Shield', '39:Shield'), 0), (rec('Gold Ring', '36:Ring'), 0)]
        out = self.rate(*[a for a, _ in rows])
        for a, points in rows:
            self.assertEqual(out[a['desc']][:2], ('extra', points), a['name'])

    def test_table(self):
        cloak = rec('Fur Cloak', '46')
        ench = rec('Fur Cloak of Warding', '46', template=cloak)
        warm = rec('Snow Bear Armor', '32:Body')
        kept = rec('Fur Armor', '32:Body', 'Skyrim.esm', keywords='Survival_ArmorWarm')
        table = G.table_of(G.classify([cloak, ench, warm, kept, rec('Plate Armor', '32:Body'), rec('Ring', '36:Ring')]))
        self.assertEqual(table, {'Mod.esp': {'warm': [warm['key'][1]], 'extra': [[cloak['key'][1], 20], [ench['key'][1], 20]]}})


if __name__ == '__main__':
    unittest.main()
