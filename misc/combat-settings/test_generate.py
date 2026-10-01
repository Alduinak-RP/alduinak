"""Rule tests for the rebalance settings generator: python misc/combat-settings/test_generate.py

The dump test replays the 2026-09-29 research dump (COMBAT_ITEMS, default the combat plan's items folder) and expects
the coverage sim.py published, less the 32 audit records whose only recipe the patcher parks (sim.py counted them) and
with the 28 light hold uniforms on their override; it is skipped when the dump is absent.
"""
import itertools
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import classify as C  # noqa: E402
import generate as G  # noqa: E402

DESIGN = G.read_json(os.path.join(HERE, 'design.json'))
DUMP = os.environ.get('COMBAT_ITEMS', 'C:/Users/Administrator/Desktop/alduinak-combat-2026-09-29/items')
INGREDIENTS = {'IngotIron': '5ace4:Skyrim.esm', 'IngotSteel': '5ace5:Skyrim.esm', 'Leather01': 'db5d2:Skyrim.esm',
               'ChaurusChitin': '3ad57:Skyrim.esm', 'IngotQuicksilver': '5ada0:Skyrim.esm', 'IngotOrichalcum': '5ad99:Skyrim.esm'}
_ids = itertools.count(0x800)


def rec(edid, **kw):
    n = next(_ids)
    return dict(formid=f'{n:08X}', desc=f'{n:x}:Test.esp', form_key=f'{n:06X}:Test.esp', winning_plugin='Test.esp',
                plugins=['Test.esp'], edid=edid, name=kw.pop('name', edid), non_playable=kw.pop('non_playable', 0),
                template=kw.pop('template', ''), keywords=kw.pop('keywords', ''), **kw)


def weap(edid, anim='OneHandSword', speed=1.0, damage=10, **kw):
    return rec(edid, anim_type=anim, speed=speed, damage=damage, weight=5.0, **kw)


def armo(edid, slots='32:Body', atype='Heavy', ar=10.0, weight=10.0, **kw):
    return rec(edid, biped_slots=slots, armor_type=atype, ar=ar, weight=weight, **kw)


def cobj(created, gates=('Blacksmith Novice',), bench='CraftingSmithingForge', ingredients=()):
    c = rec('Recipe' + created, created_edid=created, bench=bench, conditions=[f'HasSpell(AldProf_{g.replace(" ", "_")}) == 1' for g in gates],
            ingredients=[dict(edid=e, name=e, desc=INGREDIENTS[e], count=1) for e in ingredients])
    return c


def run(weapons=(), armors=(), cobjs=(), retier=False):
    return C.Classifier(DESIGN, list(weapons), list(armors), list(cobjs), retier).run()


class Resolution(unittest.TestCase):
    def test_specific_keyword_before_generic(self):
        w = weap('HonedSword', keywords='WeapMaterialDraugr WeapMaterialDraugrHoned')
        self.assertEqual(run([w]).W[C.rid(w)]['row'], 'DraugrHoned')

    def test_three_ia_materials_fall_back(self):
        a = armo('IAMixed', keywords='IAKMaterialSteel IAKMaterialLeather IAKMaterialIron', atype='Light')
        c = run(armors=[a]).A[C.rid(a)]
        self.assertEqual((c['rule'], c['row']), ('fallback(IA multi)', 'Fur'))

    def test_override_reaches_template_variants(self):
        base = armo('ArmorBanditCuirass', atype='Light')
        var = armo('EnchBanditThing', template='ArmorBanditCuirass', keywords='ArmorMaterialSteel', atype='Light')
        cls = run(armors=[base, var])
        self.assertEqual(cls.A[C.rid(var)]['row'], 'Fur')
        self.assertEqual(cls.A[C.rid(var)]['rule'], 'override')

    def test_weapon_types(self):
        hammer = weap('Hammer', anim='TwoHandAxe', keywords='WeapTypeWarhammer WeapMaterialSteel')
        axe = weap('Axe', anim='TwoHandAxe', keywords='WeapMaterialSteel')
        xbow = weap('Xbow', anim='Crossbow', keywords='WeapMaterialDwarven')
        bow = weap('IronBow', anim='Bow', keywords='WeapMaterialIron')
        falmer = weap('FalmerBow', anim='Bow')
        dummy = weap('testVorpalSword')
        cls = run([hammer, axe, xbow, bow, falmer, dummy])
        got = [(cls.W[C.rid(x)]['kind'], cls.W[C.rid(x)]['type'], cls.W[C.rid(x)]['row']) for x in (hammer, axe, xbow, bow, falmer, dummy)]
        self.assertEqual(got, [('weapon', 'warhammer', 'Steel'), ('weapon', 'battleaxe', 'Steel'), ('crossbow', 'crossbow', 'Dwarven'),
                               ('bow', 'bow', 'Long'), ('bow', 'bow', 'Falmer'), ('dummy', 'sword', 'Dummy')])

    def test_audit_caps_to_the_recipe_rank_and_variants_follow(self):
        base = armo('ModScaledCuirass', keywords='ArmorMaterialScaled', atype='Light')
        var = armo('EnchModScaledCuirass', template='ModScaledCuirass', keywords='ArmorMaterialScaled', atype='Light', non_playable=1)
        cls = run(armors=[base, var], cobjs=[cobj('ModScaledCuirass', gates=('Blacksmith Adept', 'Tailor Expert'))])
        self.assertEqual(cls.final_row('ARMO', base), ('Studded', 'audit'))
        self.assertEqual(cls.final_row('ARMO', var), ('Studded', 'audit (template)'))
        overrides, _ = G.overrides_map(cls)
        self.assertEqual(overrides, {base['desc']: 'Studded', var['desc']: 'Studded'})

    def test_bow_audit_names_a_bow_row(self):
        b = weap('ModElvenBow', anim='Bow', keywords='WeapMaterialElven')
        cls = run([b], cobjs=[cobj('ModElvenBow', gates=('Woodworker Novice',))])
        self.assertEqual(cls.final_row('WEAP', b), ('Long', 'audit'))

    def test_assume_retier_lifts_the_d6_audit(self):
        a = armo('ArmorStuddedCuirass', keywords='ArmorMaterialStudded', atype='Light')
        r = cobj('ArmorStuddedCuirass', gates=('Blacksmith Novice',))
        self.assertEqual(run(armors=[a], cobjs=[r]).final_row('ARMO', a)[0], 'Hide')
        self.assertEqual(run(armors=[a], cobjs=[r], retier=True).final_row('ARMO', a), ('Studded', 'keyword'))

    def test_parked_recipe_is_not_audited(self):
        a = armo('DLC2ArmorBonemoldCuirass', keywords='DLC2ArmorMaterialBonemoldHeavy', atype='Heavy')
        parked = cobj('DLC2ArmorBonemoldCuirass', gates=('Blacksmith Novice',), bench='MothNest1')
        cls = run(armors=[a], cobjs=[parked])
        self.assertEqual(cls.final_row('ARMO', a), ('Bonemold', 'keyword'))
        self.assertEqual(C.parked_benches(), {'MothNest1'})
        live = cobj('DLC2ArmorBonemoldCuirass', gates=('Blacksmith Novice',))
        self.assertEqual(run(armors=[a], cobjs=[parked, live]).final_row('ARMO', a), ('Iron', 'audit'))

    def test_closed_helmet_is_not_audited(self):
        a = armo('ModScaledHelmet_CLS', slots='30:Head 31:Hair', keywords='ArmorMaterialScaled', atype='Light')
        cls = run(armors=[a], cobjs=[cobj('ModScaledHelmet_CLS', gates=('Blacksmith Novice',))])
        self.assertEqual(cls.final_row('ARMO', a), ('Scaled', 'keyword'))

    def test_light_hold_uniform_takes_the_guard_row(self):
        kw = 'TH_MaterialGuard ArmorMaterialSteel'
        light = armo('TH_WhiterunCuirass', atype='Light', keywords=kw)
        rift_helm = armo('TH_RiftenHelmet', slots='31:Hair', atype='Light', keywords=kw)
        heavy = armo('TH_WhiterunCuirassHeavy', keywords=kw)
        rift_boots = armo('TH_RiftenBoots', slots='37:Feet', keywords=kw)
        shield = armo('TH_WhiterunShield', slots='39:Shield', atype='Light', keywords=kw + ' ArmorShield')
        recipes = [cobj(e) for e in ('TH_WhiterunCuirass', 'TH_RiftenHelmet', 'TH_WhiterunShield')]
        cls = run(armors=[light, rift_helm, heavy, rift_boots, shield], cobjs=recipes)
        rows = [cls.final_row('ARMO', a) for a in (light, rift_helm, heavy, rift_boots, shield)]
        self.assertEqual(rows, [('Stormcloak', 'override'), ('Stormcloak', 'override'), ('Steel', 'keyword'), ('Steel', 'keyword'), ('Iron', 'audit')])
        self.assertEqual(round(cls.piece_dt(cls.A[C.rid(light)], 'Stormcloak'), 4), 3.9)


class Numbers(unittest.TestCase):
    def test_round_half_up(self):
        self.assertEqual([C.round_half_up(x) for x in (11.055, 21.5, 10.5, 13.25)], [11, 22, 11, 13])

    def test_piece_dt(self):
        steel = armo('SteelCuirass', keywords='ArmorMaterialSteel')
        light_daedric = armo('LightDaedricHelm', slots='31:Hair', atype='Light', keywords='ArmorMaterialDaedric')
        guard = armo('ArmorGuardShieldWhiterun', slots='39:Shield', keywords='ArmorShield')
        ring = armo('SteelRing', slots='36:Ring', keywords='ArmorMaterialSteel')
        cls = run(armors=[steel, light_daedric, guard, ring])
        dt = [round(cls.piece_dt(cls.A[C.rid(a)], cls.final_row('ARMO', a)[0]), 4) for a in (steel, light_daedric, guard, ring)]
        self.assertEqual(dt, [5.85, round(15 * 0.15 * 0.7, 4), 0.27, 0.0])

    def test_hp_tables_cover_every_row(self):
        self.assertEqual(G.hp_problems(DESIGN), [])

    def test_creature_variants_take_the_creature_dt_and_the_rest_are_listed(self):
        race = lambda desc, dmg, playable=False: dict(desc=desc, unarmed_damage=dmg, playable=playable)  # noqa: E731
        edids = [e for c in DESIGN['npc']['creatures'].values() for e in [c['race']] + c.get('variants', [])]
        races = {e: race(f'{i + 1:x}:Test.esm', 5) for i, e in enumerate(edids)}
        races.update(ChaurusRace=race('131eb:Skyrim.esm', 20), NordRace=race('13746:Skyrim.esm', 4, True), DraugrRace=race('d53:Skyrim.esm', 1))
        ndt, rows, unmapped, problems = G.natural_dt(DESIGN, races)
        self.assertEqual((ndt[races['TrollRace']['desc']], ndt[races['DLC1TrollRaceArmored']['desc']]), (2.0, 2.0))
        self.assertEqual({ndt[races[e]['desc']] for e in ('DragonRace', 'DLC2DragonBlackRace', 'UndeadDragonRace', 'DLC1UndeadDragonRace')}, {6.0})
        self.assertNotIn(races['SkeeverWhiteRace']['desc'], ndt)
        self.assertEqual(unmapped, [['ChaurusRace', '131eb:Skyrim.esm', 20], ['DraugrRace', 'd53:Skyrim.esm', 1]])
        self.assertEqual(problems, [])
        del races['SabreCatSnowyRace']
        self.assertEqual(G.natural_dt(DESIGN, races)[3], ['creature SabreCat: no RACE SabreCatSnowyRace in the load order'])

    def test_claw_overrides_are_checked(self):
        bad = json.loads(json.dumps(DESIGN))
        bad['unarmed']['raceOverride']['KhajiitRace'] = {'weaponRow': 'Mithril', 'type': 'claw'}
        _, problems = G.race_override(bad, {'KhajiitRace': {}, 'KhajiitRaceVampire': {}, 'ArgonianRace': {}, 'ArgonianRaceVampire': {}})
        self.assertEqual(len(problems), 2)
        claws, problems = G.race_override(DESIGN, None)
        self.assertEqual((claws['KhajiitRace'], claws['ArgonianRaceVampire'], problems),
                         ({'weaponRow': 'Steel', 'type': 'dagger'}, {'weaponRow': 'Iron', 'type': 'dagger'}, []))


class Outputs(unittest.TestCase):
    def setUp(self):
        self.orc = armo('ArmorOrcishCuirass', keywords='ArmorMaterialOrcish', weight=35.0, ar=40.0)
        self.orc_light = armo('LightOrcCuirass', keywords='ArmorMaterialOrcish', atype='Light', weight=6.0)
        self.nordic_shield = armo('NordicShield', slots='39:Shield', keywords='DLC2ArmorMaterialNordicHeavy ArmorShield', weight=10.0)
        self.slow = weap('SlowDagger', anim='OneHandDagger', speed=1.0, damage=7, keywords='WeapMaterialEbony')
        self.slow_var = weap('EnchSlowDagger', anim='OneHandDagger', speed=1.0, damage=7, template='SlowDagger', keywords='WeapMaterialEbony')
        self.steel_dagger = weap('SteelDagger', anim='OneHandDagger', speed=1.3, damage=7, keywords='WeapMaterialSteel')
        self.iron_dagger = weap('IronDagger', anim='OneHandDagger', speed=1.3, damage=6, keywords='WeapMaterialIron')
        self.npc_draugr = armo('ArmorDraugrCuirass', keywords='ArmorMaterialDaedric', non_playable=1)
        self.cls = run([self.slow, self.slow_var, self.steel_dagger, self.iron_dagger],
                       [self.orc, self.orc_light, self.nordic_shield, self.npc_draugr],
                       [cobj('NordicShield', gates=('Blacksmith Expert',)),
                        cobj('ArmorOrcishCuirass', bench='CraftingSmithingArmorTable', ingredients=('IngotOrichalcum',))])

    def test_settings_block(self):
        block, info = G.settings_block(DESIGN, self.cls, None, INGREDIENTS, {'durability'})
        self.assertEqual((block['enabled'], block['durability']['enabled']), (False, True))
        self.assertEqual(info['problems'], [])
        self.assertEqual(block['overrides'], {self.npc_draugr['desc']: 'AncientNord', self.nordic_shield['desc']: 'Dwarven'})
        fm = block['durability']['repair']['fallbackMaterial']
        self.assertEqual((fm['armor']['Orcish'], fm['armor']['Iron'], fm['weapon']['Imperial'], fm['bow']['Nordic']),
                         ('5ad99:Skyrim.esm', 'db5d2:Skyrim.esm', '5ace5:Skyrim.esm', '5ada0:Skyrim.esm'))
        self.assertEqual(set(fm['weapon']), set(DESIGN['weapons']))
        self.assertEqual(block['armor']['GuardShield'], {'class': 'heavy', 'setDT': 0, 'shieldDT': 0.27})
        self.assertNotIn('fallbackMaterialDefault', block['durability']['repair'])

    def test_plugin_lists(self):
        lists, checks = G.esp_lists(DESIGN, self.cls, None, None, None)
        self.assertEqual([(w['edid'], w['from'], w['to']) for w in lists['weights']], [('ArmorOrcishCuirass', 35.0, 52)])
        self.assertEqual(sorted(x[0] for x in checks['skipped_weights']), ['LightOrcCuirass', 'NordicShield'])
        self.assertEqual(sorted((s['edid'], s['variantOf'], s['to']) for s in lists['speeds']),
                         [('EnchSlowDagger', 'SlowDagger', 1.3), ('SlowDagger', None, 1.3)])
        tips = {t['edid']: (t['from'], t['to']) for t in lists['tooltips']['weapons']}
        self.assertEqual((tips['SteelDagger'], tips['IronDagger'], tips['SlowDagger']), ((7, 11), (6, 10), (7, 13)))
        self.assertEqual({c['race']: c['after'] for c in lists['claws']},
                         {'KhajiitRace': 11, 'KhajiitRaceVampire': 11, 'ArgonianRace': 10, 'ArgonianRaceVampire': 10})
        armor = {t['edid']: t['to'] for t in lists['tooltips']['armor']}
        self.assertEqual(armor['ArmorOrcishCuirass'], 73.5)

    def test_synced_names_what_the_plugin_lacks(self):
        studded = armo('ArmorStuddedCuirass', keywords='ArmorMaterialStudded', atype='Light', ar=46.5, weight=6.0)
        races = {r: dict(form_key='1:Test.esm', unarmed_damage=u) for r, u in
                 (('KhajiitRace', 11.0), ('KhajiitRaceVampire', 11.0), ('ArgonianRace', 10.0), ('ArgonianRaceVampire', 6.0))}
        lists, _ = G.esp_lists(DESIGN, run(armors=[studded], cobjs=[cobj('ArmorStuddedCuirass', gates=('Tailor Adept',), bench='CraftingTanningRack')]),
                               None, None, races)
        self.assertEqual([(r['gates'], r['landed']) for r in lists['retier']], [(['Tailor Adept'], True)])
        self.assertEqual(G.sync_problems(lists), ['claws: ArgonianRaceVampire has unarmed damage 6.0, IronDagger gives 10'])
        shared = cobj('ArmorStuddedCuirass', gates=('Blacksmith Novice', 'Tailor Adept'))
        lists, _ = G.esp_lists(DESIGN, run(armors=[armo('ArmorStuddedCuirass', keywords='ArmorMaterialStudded', atype='Light')], cobjs=[shared]), None, None, None)
        self.assertEqual(G.sync_problems(lists)[:2],
                         ['the plugin lacks 1 listed values (tooltips 0 WEAP / 1 ARMO, weights 0, speeds 0): run the stat pass, patch.py --stats esp-lists.json',
                          'retier: RecipeArmorStuddedCuirass is gated Blacksmith Novice, Tailor Adept, not Tailor Adept alone'])

    def test_survival_keywords_count_a_record_once(self):
        orc = armo('WarmOrcCuirass', keywords='ArmorMaterialOrcish Survival_ArmorWarm', weight=35.0, ar=40.0)

        class Order:
            names = ['Test.esp']
        _, checks = G.esp_lists(DESIGN, run(armors=[orc]), Order, None, None)
        self.assertEqual(dict(checks['survival_listed']), {'Survival_ArmorWarm': 1})


@unittest.skipUnless(os.path.isdir(DUMP), 'research dump not found')
class ResearchDump(unittest.TestCase):
    def test_matches_the_published_coverage(self):
        load = lambda n: G.read_json(os.path.join(DUMP, n))  # noqa: E731
        cls = run(load('weapons.json'), load('armors.json'), load('cobj.json'))
        wc, ac, wfb, _ = G.coverage(cls)
        self.assertEqual(dict(wc), {'keyword': 3315, 'staff (0)': 94, 'override': 70, 'crossbow row': 37, 'unarmed row': 5})
        self.assertEqual(dict(ac), {'keyword': 4634, 'clothing/jewelry (DT 0)': 1413, 'override': 115, 'fallback': 85,
                                    'fallback(IA multi)': 14, 'AldCatMat': 4})
        self.assertEqual(wfb, [])
        self.assertEqual(len(cls.audit), 218)
        tv = sorted(v['sig'] for v in cls.variants.values() if cls.playable(v['rec']))
        self.assertEqual((tv.count('WEAP'), tv.count('ARMO')), (31, 187))
        ores = [cls.A[C.rid(a)]['row'] for a in cls.armors if cls.playable(a)]
        self.assertEqual((ores.count('Orcish'), ores.count('Dwarven')), (137, 179))
        slow = [w for w in cls.weapons if cls.playable(w) and not w['template'] and cls.W[C.rid(w)]['kind'] in ('weapon', 'bow')
                and w['speed'] < cls.std_speed(cls.W[C.rid(w)]['kind'], cls.W[C.rid(w)]['type'], cls.W[C.rid(w)]['row']) - 1e-6]
        self.assertEqual(len(slow), 40)


if __name__ == '__main__':
    unittest.main(verbosity=2)
