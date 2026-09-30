"""Generates the rebalance settings block and the plugin lists from the Test load order (offline; nothing is deployed).

Reads the server loadOrder (only that key of the settings file), classifies every WEAP and ARMO with the shared
classifier (classify.py, the rules of design.json) and writes into --out:
  alduinakDamageFormulaSettings.json  the block for the Test server-settings.json: rows, keyword tables, the generated
                                      overrides (regex rules, recipe-rank audit, their template variants), claws as
                                      unarmed.raceOverride objects, creature natural DT, block stamina and durability
                                      (HP per row, generated repair fallback materials)
  esp-lists.json                      input of plugin run r27b: tooltip values, Orcish and Dwarven weights, slow record
                                      speeds, claw values, the D6 retier, master and shadow checks
  report.md                           coverage, the audit, fallbacks, every list's counts and every check
Form ids: the settings use the server's FormDesc ("13986:Skyrim.esm"), the plugin lists the patcher's FormKey
("013986:Skyrim.esm"). Rerun after every plugin change and every Update Modlist.

Run:  python misc/combat-settings/generate.py --settings <Test server-settings.json> --out <dir>
Options: --plugin <AlduinakAdditions.esp> (read in place of the load order's copy), --data <Data dir>,
         --design <design.json>, --enable formula,durability (writes enabled: true), --assume-retier (applies the
         design's D6 recipe ranks to the audit before the plugin carries them), --items <dir> (classify a research
         dump of items/*.json instead of plugins; only report.md is written)
"""
import argparse
import collections
import hashlib
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import classify as C  # noqa: E402
import loadorder as L  # noqa: E402

REPO = os.path.dirname(os.path.dirname(HERE))
MELEE = ('dagger', 'sword', 'waraxe', 'mace', 'greatsword', 'battleaxe', 'warhammer')
TYPE_KEYS = ('speed', 'hands', 'dmgMult', 'critChance', 'critMult', 'penetration', 'powerMult', 'sneakMult', 'floor', 'autoCritOnSneak')
SURVIVAL_KEYWORDS = ('Survival_ArmorWarm', 'Survival_ArmorCold', 'Survival_BodyAndHead')
ALDUINAK = 'AlduinakAdditions.esp'


class GenError(Exception):
    pass


def numeric(d, keys):
    return {k: d[k] for k in keys if k in d and isinstance(d[k], (int, float, bool))}


def read_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def sha12(path):
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read()).hexdigest()[:12]


def md(header, rows):
    out = ['| ' + ' | '.join(header) + ' |', '|' + '---|' * len(header)]
    out += ['| ' + ' | '.join(str(x) for x in r) + ' |' for r in rows]
    return '\n'.join(out) + '\n'


# ------------------------------------------------------------------ settings block
def race_override(D, races, cls=None):
    out, problems = {}, []
    for row, edid in D['unarmed']['clawTooltipWeapon'].items():
        w = cls.by_edid.get(edid) if cls else None
        if cls and not w:
            problems.append(f'claw weapon {edid} is not in the load order')
        elif w:
            c = cls.W[C.rid(w)]
            got = cls.final_row('WEAP', w)[0]
            if (got, c['type']) != (row, 'dagger'):
                problems.append(f'claw weapon {edid} resolves to {got} {c["type"]}, not the {row} dagger')
    for race, o in D['unarmed']['raceOverride'].items():
        if o.get('weaponRow') not in D['weapons']:
            problems.append(f'{race}: weaponRow {o.get("weaponRow")} is not a weapons row')
        if o.get('type') not in MELEE:
            problems.append(f'{race}: type {o.get("type")} is not a melee type')
        if races is not None and race not in races:
            problems.append(f'{race}: no RACE record with that editor id in the load order')
        out[race] = {'weaponRow': o['weaponRow'], 'type': o['type']}
    return out, problems


def natural_dt(D, races):
    out, rows = {}, []
    for k, c in D['npc']['creatures'].items():
        r = (races or {}).get(c['race'])
        rows.append([k, c['race'], r['desc'] if r else 'missing', c['damage'], r['unarmed_damage'] if r else '-', c['dt']])
        if r and c['dt']:
            out[r['desc']] = c['dt']
    return out, rows


def fallback_materials(cls, lo_ingredients):
    """Per kind and row: the ingredient most temper recipes of that row's playable records use."""
    D = cls.D
    tally = collections.defaultdict(collections.Counter)
    names = {}
    for sig, recs in (('WEAP', cls.weapons), ('ARMO', cls.armors)):
        for r in recs:
            if not cls.playable(r):
                continue
            c = (cls.W if sig == 'WEAP' else cls.A)[C.rid(r)]
            if c['kind'] in ('staff', 'unarmed', 'dummy', 'clothing'):
                continue
            kind = 'armor' if sig == 'ARMO' else c['kind']
            row, _ = cls.final_row(sig, r)
            for t in cls.temper.get(r['edid'], []):
                for i in t['ingredients']:
                    tally[kind, row][i['desc']] += 1
                    names[i['desc']] = f"{i['edid']} ({i['name']})" if i.get('name') else i['edid']
    default = D['durability']['repair']['fallbackMaterialDefault']
    tables = {'weapon': D['weapons'], 'bow': D['bows']['bows'], 'crossbow': D['bows']['crossbows'],
              'armor': {k: v for k, v in D['armor'].items() if v['class'] != 'clothing'}}
    out, rows, problems = {}, [], []
    for kind, table in tables.items():
        out[kind] = {}
        for row in table:
            t = tally.get((kind, row))
            if t:
                desc, n = t.most_common(1)[0]
                src = f'{n} of {sum(t.values())} temper inputs'
            else:
                edid = default[kind].get(row, default[kind]['*'])
                desc = lo_ingredients.get(edid)
                src = f'no temper recipe; default {edid}'
                names[desc] = edid
                if not desc:
                    problems.append(f'fallback material {edid} for {kind} {row} is not in the load order')
                    continue
            out[kind][row] = desc
            rows.append([kind, row, names.get(desc, desc), desc, src])
    return out, rows, problems


def hp_problems(D):
    dur = D['durability']
    need = (('weaponHP', D['weapons']), ('bowHP', D['bows']['bows']), ('crossbowHP', D['bows']['crossbows']),
            ('armorSetHP', {k: v for k, v in D['armor'].items() if v['class'] != 'clothing'}))
    out = []
    for key, table in need:
        missing = [r for r in table if r not in dur[key]]
        extra = [r for r in dur[key] if r not in table]
        if missing:
            out.append(f'durability.{key} lacks rows {", ".join(missing)}')
        if extra:
            out.append(f'durability.{key} names rows that do not exist: {", ".join(extra)}')
    return out


def overrides_map(cls):
    """{desc: row} for every non-deleted record a regex rule, the audit or an audited template picks."""
    out, counts = {}, collections.Counter()
    for sig, recs in (('WEAP', cls.weapons), ('ARMO', cls.armors)):
        for r in recs:
            c = (cls.W if sig == 'WEAP' else cls.A)[C.rid(r)]
            row, how = cls.final_row(sig, r)
            if how not in ('override', 'audit', 'audit (template)'):
                continue
            out[r['desc']] = row
            counts[sig, how, 'playable' if cls.playable(r) else 'other'] += 1
            if c['kind'] == 'dummy':
                counts[sig, 'dummy', 'all'] += 1
    return dict(sorted(out.items())), counts


def settings_block(D, cls, races, lo_ingredients, enable, source=''):
    F = D['formula']
    problems = hp_problems(D)
    claws, p = race_override(D, races, cls)
    problems += p
    ndt, ndt_rows = natural_dt(D, races)
    fmat, fmat_rows, p = fallback_materials(cls, lo_ingredients)
    problems += p
    overrides, ocounts = overrides_map(cls)
    armor = {}
    for row, a in D['armor'].items():
        e = {'class': a['class'], 'setDT': a['setDT'] or 0}
        if a['setDT'] is None and a['dt'].get('shield') is not None:
            e['shieldDT'] = a['dt']['shield']
        armor[row] = e
    wt = D['weaponTypes']
    dur = {k: v for k, v in D['durability'].items() if k not in ('model', 'fallbackMaterialRule')}
    dur['enabled'] = 'durability' in enable
    dur['repair'] = {k: v for k, v in dur['repair'].items() if k != 'fallbackMaterialDefault'}
    dur['repair']['fallbackMaterial'] = fmat
    u = D['unarmed']
    block = {
        'source': source,
        'enabled': 'formula' in enable,
        **numeric(F, ('floor', 'minDamage', 'critDTMult', 'powerMult', 'npcNaturalPowerMult', 'bashMult', 'playerHitCap',
                      'shieldShare', 'lightItemHeavyRowFactor')),
        'speedNorm': numeric(F['speedNorm'], ('min', 'max')),
        'rateLimitFactor': F['rateLimitFactor'],
        'quickShotDrawMult': F['rangedLimits']['quickShotDrawMult'],
        'crossbowReload': F['rangedLimits']['crossbowReload'],
        'poisonFloor': F['poisonFloor'],
        'healthSnap': F['healthSnap'],
        'sneak': {k: F['sneak'][k] for k in ('minSneakSeconds', 'targetCalmSeconds', 'calmRuleTargets')},
        'power': numeric(F['power'], ('eventWindowSeconds', 'minIntervalSeconds', 'splashWindowSeconds', 'logOnly')),
        'effectModifiers': D['effectModifiers'],
        'tempering': numeric(D['tempering'], ('weaponPerStep', 'armorPerStep')),
        'weaponTypes': {t: numeric(wt[t], TYPE_KEYS) for t in MELEE + ('bow', 'crossbow', 'unarmed')},
        'weapons': {r: {'base': w['base'], **{k: v for k, v in w['trait'].items() if v}} for r, w in D['weapons'].items()},
        'dummyRow': C.DUMMY_ROW,
        'bows': {r: numeric(b, ('base', 'speed')) for r, b in D['bows']['bows'].items()},
        'bowRowForMaterial': D['bows']['rowForMaterial'],
        'crossbows': {r: numeric(b, ('base',)) for r, b in D['bows']['crossbows'].items()},
        'arrow': numeric(D['arrows'], ('scale', 'zero', 'max')),
        'unarmed': {'base': u['base'], 'raceOverride': claws, **numeric(u, ('penetration', 'floor', 'critChance', 'critMult'))},
        'armor': armor,
        'slotShare': D['armorRules']['slotShare'],
        'slotBipeds': {b: list(ids) for b, ids in C.BUCKETS} | {'shield': [C.SHIELD_SLOT]},
        'weaponKeywords': D['keywordMap']['weapons'],
        'armorKeywords': D['keywordMap']['armor'],
        'aldCatMat': D['keywordMap']['aldCatMat'],
        'multiIAKFallback': D['keywordMap']['multiIAKFallback'],
        'fallbackRows': D['keywordMap']['fallbackRows'],
        'overrides': overrides,
        'npc': {**numeric(D['npc'], ('playerToNpcMult', 'naturalCapBeforeDT', 'naturalFloor', 'naturalCanCrit', 'humanoidNpcCanCrit')),
                'naturalPenetration': D['npc']['naturalPenetration'], 'naturalDT': ndt},
        'blockStamina': numeric(D['blockStamina'], ('perArmorWeight', 'weightCap')),
        'durability': dur,
    }
    return block, dict(problems=problems, ocounts=ocounts, ndt_rows=ndt_rows, fmat_rows=fmat_rows)


# ------------------------------------------------------------------ plugin lists (PL-r27b)
def esp_lists(D, cls, lo, input_plugin, races):
    tooltips_w, tooltips_a, weights, speeds, skipped_weights = [], [], [], [], []
    touched = collections.defaultdict(collections.Counter)
    shadowed = []
    names = lo.names if lo else []
    after = set(names[names.index(ALDUINAK) + 1:]) if ALDUINAK in names else set()
    survival_listed = collections.Counter()

    def entry(r, **kw):
        return dict(item=r['form_key'], edid=r['edid'], name=r['name'], winner=r['winning_plugin'], **kw)

    def note(listname, r):
        touched[listname][r['form_key'].split(':', 1)[1]] += 1
        if after & set(r.get('plugins', [])):
            shadowed.append([listname, r['edid'], ', '.join(sorted(after & set(r['plugins'])))])
        for k in SURVIVAL_KEYWORDS:
            if k in C.kw_list(r):
                survival_listed[k] += 1

    for w in cls.weapons:
        if not cls.playable(w):
            continue
        c = cls.W[C.rid(w)]
        if c['kind'] not in ('weapon', 'bow', 'crossbow'):
            continue
        row, _ = cls.final_row('WEAP', w)
        dmg = cls.weapon_damage(c['kind'], c['type'], row)
        to = C.round_half_up(dmg)
        if to != w['damage']:
            tooltips_w.append(entry(w, kind=c['kind'], type=c['type'], row=row, **{'from': w['damage'], 'to': to}))
            note('tooltips.weapons', w)
        std = cls.std_speed(c['kind'], c['type'], row)
        if std and w['speed'] < std - 1e-6:
            base = next((e for e in cls.template_chain(w)[1:]), None)
            speeds.append(entry(w, kind=c['kind'], type=c['type'], row=row, variantOf=base, **{'from': w['speed'], 'to': std}))
            note('speeds', w)
    for a in cls.armors:
        if not cls.playable(a):
            continue
        c = cls.A[C.rid(a)]
        if c['kind'] == 'clothing':
            to, row = 0.0, None
        else:
            row, _ = cls.final_row('ARMO', a)
            to = round(cls.piece_dt(c, row) * 10, 2)
        if a['ar'] is not None and abs(to - a['ar']) > 0.005:
            tooltips_a.append(entry(a, kind=c['kind'], row=row, slots=c['buckets'], **{'from': a['ar'], 'to': to}))
            note('tooltips.armor', a)
        ore = {row, c['row']} & {'Orcish', 'Dwarven'}
        if ore and c['kind'] != 'clothing':
            wto = cls.piece_weight(c, row) if row in ore else None
            why = (f'audited {c["row"]} -> {row}' if row != c['row'] else 'light item' if a['armor_type'] != 'Heavy'
                   else 'no slot weight' if wto is None else None)
            if why:
                skipped_weights.append([a['edid'], a['armor_type'], why, ' '.join(c['buckets']) or a['biped_slots'], a['weight']])
            elif abs(wto - a['weight']) > 1e-4:
                weights.append(entry(a, row=row, slots=c['buckets'], **{'from': a['weight'], 'to': wto}))
                note('weights', a)
    claws = []
    for race, o in D['unarmed']['raceOverride'].items():
        weap = D['unarmed']['clawTooltipWeapon'].get(o['weaponRow'])
        r = (races or {}).get(race, {})
        claws.append(dict(race=race, raceItem=r.get('form_key'), unarmedNow=r.get('unarmed_damage'), unarmedDamageFrom=weap,
                          after=C.round_half_up(D['weapons'][o['weaponRow']]['base'] * D['weaponTypes'][o['type']]['dmgMult'])))
    retier = []
    for rx, rule in [(re.compile(x['created']), x) for x in D.get('recipeRetier', {}).get('rules', [])]:
        for c in cls.cobjs:
            if c['bench'] not in C.TEMPER_BENCHES and rx.search(c['created_edid']):
                gates = sorted(set(C.PROF_GATE.findall(' '.join(c['conditions']))))
                retier.append(dict(recipe=c.get('form_key'), edid=c['edid'], created=c['created_edid'], bench=c['bench'],
                                   gates=[f'{p} {k}' for p, k in gates], to=f"{rule['profession']} {rule['rank']}"))
    masters = [m.lower() for m in L.masters_of(input_plugin)] if input_plugin else []
    master_rows = []
    for listname, plugins in touched.items():
        for p, n in sorted(plugins.items()):
            master_rows.append([listname, p, n, 'yes' if p.lower() in masters or p == ALDUINAK else 'NO'])
    for x in (tooltips_w, tooltips_a, weights, speeds):
        x.sort(key=lambda e: (e['item'].split(':', 1)[1], e['item']))
    out = {
        'comment': 'Input of plugin run r27b (plan section 3 steps 11 to 14), generated by misc/combat-settings/generate.py. '
                   'Every entry names the item by FormKey, the winning plugin and the value now (from) and after (to). '
                   'tooltips.weapons: WEAP DATA damage = the row damage rounded half up; tooltips.armor: ARMO DNAM rating = '
                   'piece DT x 10 (clothing 0); weights: Orcish and Dwarven heavy pieces at the row weight of their slot; '
                   'speeds: WEAP DNAM speed raised to the row speed; claws: RACE unarmed damage once unarmedDamageFrom reads '
                   'the synced dagger; retier: D6. The pass must not touch the keywords in untouchedKeywords.',
        'tooltips': {'weapons': tooltips_w, 'armor': tooltips_a},
        'weights': weights,
        'speeds': speeds,
        'claws': claws,
        'retier': retier,
        'untouchedKeywords': list(SURVIVAL_KEYWORDS),
    }
    checks = dict(master_rows=master_rows, shadowed=shadowed, skipped_weights=skipped_weights, survival_listed=survival_listed)
    return out, checks


# ------------------------------------------------------------------ report
def coverage(cls):
    wc, ac = collections.Counter(), collections.Counter()
    wfb, afb = [], []
    for w in cls.weapons:
        if cls.playable(w):
            c = cls.W[C.rid(w)]
            wc[c['rule']] += 1
            if C.is_fallback(c['rule']):
                wfb.append(f"{w['edid']} ({w['anim_type']})")
    for a in cls.armors:
        if cls.playable(a):
            c = cls.A[C.rid(a)]
            ac[c['rule']] += 1
            if C.is_fallback(c['rule']) and not a.get('template') and (a['ar'] or 0) > 0:
                afb.append(f"{a['edid']} ({a['armor_type']}, AR {a['ar']}, -> {c['row']})")
    return wc, ac, wfb, afb


def audit_table(cls):
    agg = collections.defaultdict(list)
    for x in cls.audit:
        agg[x['sig'], x['row'], x['tier'], x['rank'], x['to']].append(x['rec']['edid'])
    return [[k[0], k[1], k[2], k[3], k[4], len(v), ', '.join(sorted(v)[:4])] for k, v in sorted(agg.items(), key=lambda x: (-len(x[1]), x[0]))]


def report(D, cls, meta, info=None, lists=None, checks=None):
    wc, ac, wfb, afb = coverage(cls)
    tv = collections.Counter(v['sig'] for v in cls.variants.values() if cls.playable(v['rec']))
    L_ = [f"# Rebalance settings generator report\n\n{meta}\n", '## Item mapping (every playable, named WEAP and ARMO, variants included)\n',
          md(['WEAP rule', 'records'], sorted(wc.items(), key=lambda x: -x[1])),
          md(['ARMO rule', 'records'], sorted(ac.items(), key=lambda x: -x[1])),
          f'Weapons on the fallback row: {"; ".join(wfb) or "none"}.\n',
          f'Armor base records with AR on the fallback row (logged once each by the server): {len(afb)}: {"; ".join(afb)}.\n',
          f'## Recipe-rank audit\n\n{len(cls.audit)} craftable base records sit on a row above their recipe rank and get an '
          f'override to the reference row of that rank; {tv["WEAP"]} WEAP and {tv["ARMO"]} ARMO playable template variants '
          f'inherit it.\n', md(['kind', 'row', 'row tier', 'recipe rank', 'capped to', 'records', 'examples'], audit_table(cls))]
    if info:
        oc = info['ocounts']
        rows = [[s, h, p, n] for (s, h, p), n in sorted(oc.items())]
        L_.append('## Overrides in the settings block\n\nNon-playable records (NPC gear) are included, so the server resolves them too.\n')
        L_.append(md(['type', 'source', 'records', 'count'], rows))
        L_.append('## Creature natural DT (npc.naturalDT)\n\nThe design table by creature, its RACE, the RACE unarmed damage the '
                  'server uses, and the DT written (only non-zero values are written).\n')
        L_.append(md(['creature', 'race', 'desc', 'design damage', 'RACE unarmed damage', 'DT'], info['ndt_rows']))
        L_.append('## Durability repair fallback materials (durability.repair.fallbackMaterial)\n\nFor items without a temper '
                  'recipe; per kind and row, the ingredient most temper recipes of that row use.\n')
        L_.append(md(['kind', 'row', 'material', 'desc', 'evidence'], info['fmat_rows']))
    if lists is not None:
        L_.append('## Plugin lists for r27b (esp-lists.json)\n\n')
        L_.append(md(['list', 'records'], [['tooltips.weapons', len(lists['tooltips']['weapons'])], ['tooltips.armor', len(lists['tooltips']['armor'])],
                                           ['weights', len(lists['weights'])], ['speeds', len(lists['speeds'])],
                                           ['speeds (base records)', sum(1 for s in lists['speeds'] if not s['variantOf'])],
                                           ['claws', len(lists['claws'])], ['retier (D6)', len(lists['retier'])]]))
        wr = collections.Counter((w['row'], ' '.join(w['slots']), w['from'], w['to']) for w in lists['weights'])
        L_.append('Weights by row and slot:\n\n' + md(['row', 'slot', 'from', 'to', 'records'], [list(k) + [n] for k, n in sorted(wr.items())]))
        if checks['skipped_weights']:
            L_.append('Orcish or Dwarven pieces left at their own weight (a light item keeps 70% of the row DT and its weight; a '
                      'piece the audit moves into or out of those rows is not of that material):\n\n'
                      + md(['edid', 'type', 'why', 'slot', 'weight'], sorted(checks['skipped_weights'])))
        L_.append('Base records slower than their row (template variants follow):\n\n' + md(
            ['edid', 'type', 'row', 'speed', 'row speed'], [[s['edid'], s['type'], s['row'], s['from'], s['to']] for s in lists['speeds'] if not s['variantOf']]))
        L_.append('Claws (RACE unarmed damage once the dagger tooltips are synced; the new formula reads unarmed.raceOverride instead):\n\n'
                  + md(['race', 'now', 'unarmedDamageFrom', 'after r27b'], [[c['race'], c['unarmedNow'], c['unarmedDamageFrom'], c['after']] for c in lists['claws']]))
        L_.append('D6 retier (recipes in the input plugin):\n\n' + md(['recipe', 'created', 'bench', 'gates now', 'to'],
                                                                     [[r['edid'], r['created'], r['bench'], ', '.join(r['gates']), r['to']] for r in lists['retier']]))
        L_.append('Plugins whose records each list overrides, and whether the input plugin already has them as masters:\n\n'
                  + md(['list', 'plugin', 'records', 'master'], checks['master_rows']))
        L_.append(f'Listed records also overridden after {ALDUINAK} (the change would be shadowed): {len(checks["shadowed"])}'
                  + (':\n\n' + md(['list', 'edid', 'later plugins'], checks['shadowed']) if checks['shadowed'] else '.\n'))
        L_.append('Listed records carrying a Survival warmth keyword (the pass changes fields only and must keep these keywords): '
                  + (', '.join(f'{k} {n}' for k, n in checks['survival_listed'].items()) or 'none') + '.\n')
    if info and info['problems']:
        L_.append('## Problems\n\n' + '\n'.join(f'- {p}' for p in info['problems']) + '\n')
    return '\n'.join(L_)


def summary(block, lists, info):
    dur = block['durability']
    oc = info['ocounts']
    rules = sum(n for (s, h, p), n in oc.items() if h == 'override')
    audit = sum(n for (s, h, p), n in oc.items() if h == 'audit')
    var = sum(n for (s, h, p), n in oc.items() if h == 'audit (template)')
    claws = ', '.join(f"{r} {o['weaponRow']} {o['type']}" for r, o in block['unarmed']['raceOverride'].items())
    return (f"[combat-settings] enabled {block['enabled']}, durability {dur['enabled']}; rows weapons {len(block['weapons'])}, bows "
            f"{len(block['bows'])}, crossbows {len(block['crossbows'])}, armor {len(block['armor'])}; floor {block['floor']}, crit DT x"
            f"{block['critDTMult']}, power x{block['powerMult']}, bash x{block['bashMult']}, cap {block['playerHitCap']}, shield "
            f"{block['shieldShare']}, temper {block['tempering']['weaponPerStep']}/{block['tempering']['armorPerStep']}, snap "
            f"{block['healthSnap']}; overrides {len(block['overrides'])} (rules {rules}, audit {audit}, template variants {var}); "
            f"claws {claws}; natural DT {len(block['npc']['naturalDT'])} races; durability HP weapons {len(dur['weaponHP'])}, bows "
            f"{len(dur['bowHP'])}, crossbows {len(dur['crossbowHP'])}, armor sets {len(dur['armorSetHP'])}, shield share "
            f"{dur['shieldHPShare']}, fallback materials {sum(len(v) for v in dur['repair']['fallbackMaterial'].values())}; plugin lists "
            f"tooltips {len(lists['tooltips']['weapons'])} WEAP / {len(lists['tooltips']['armor'])} ARMO, weights {len(lists['weights'])}, "
            f"speeds {len(lists['speeds'])}, retier {len(lists['retier'])}; problems {len(info['problems'])}")


def dumps_rows(obj, pad=''):
    """JSON with every object inside a list on one line, so a list diffs by entry."""
    inner = pad + ' '
    if isinstance(obj, dict) and obj:
        return '{\n' + ',\n'.join(f'{inner}{json.dumps(k, ensure_ascii=False)}: {dumps_rows(v, inner)}' for k, v in obj.items()) + f'\n{pad}}}'
    if isinstance(obj, list) and any(isinstance(x, (dict, list)) for x in obj):
        return '[\n' + ',\n'.join(inner + json.dumps(x, ensure_ascii=False) for x in obj) + f'\n{pad}]'
    return json.dumps(obj, ensure_ascii=False)


def write_text(path, text):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)


def write_json(path, obj):
    write_text(path, dumps_rows(obj) + '\n')


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--settings', default=os.path.join(REPO, 'build', 'dist', 'testserver', 'server-settings.json'))
    ap.add_argument('--plugin', help=f'{ALDUINAK} to read in place of the load order copy')
    ap.add_argument('--data', help='Data folder for strings (default: the folder of the first plugin)')
    ap.add_argument('--design', default=os.path.join(HERE, 'design.json'))
    ap.add_argument('--out', required=True)
    ap.add_argument('--enable', default='', help='comma list of formula, durability')
    ap.add_argument('--assume-retier', action='store_true')
    ap.add_argument('--items', help='a research dump folder (weapons.json, armors.json, cobj.json) instead of plugins')
    a = ap.parse_args(argv)
    D = read_json(a.design)
    enable = {x.strip() for x in a.enable.split(',') if x.strip()}
    if enable - {'formula', 'durability'}:
        raise GenError(f'--enable takes formula and durability, not {", ".join(enable - {"formula", "durability"})}')
    os.makedirs(a.out, exist_ok=True)
    opts = f"options: enable {','.join(sorted(enable)) or 'none'}, assume-retier {a.assume_retier}"
    if a.items:
        load = lambda n: read_json(os.path.join(a.items, n))  # noqa: E731
        cls = C.Classifier(D, load('weapons.json'), load('armors.json'), load('cobj.json'), a.assume_retier).run()
        meta = f"Input: research dump {a.items}; design {D['version']}; {opts}."
        write_text(os.path.join(a.out, 'report.md'), report(D, cls, meta))
        print(f'[combat-settings] classified the dump {a.items}: {len(cls.weapons)} WEAP, {len(cls.armors)} ARMO, audit {len(cls.audit)}')
        return 0
    load_order = L.read_load_order(a.settings)
    subst = {ALDUINAK: a.plugin} if a.plugin else None
    lo = L.LoadOrder(load_order, subst, a.data)
    races = L.races(lo)
    cls = C.Classifier(D, L.weapons(lo), L.armors(lo), L.cobjs(lo), a.assume_retier).run()
    ingredients = {r.edid(): lo.desc(k) for t in ('MISC', 'INGR') for k, r, _ in lo.by_type.get(t, [])}
    input_plugin = a.plugin or next((p for p in load_order if os.path.basename(p) == ALDUINAK), None)
    sha = sha12(input_plugin) if input_plugin else '-'
    source = f"misc/combat-settings/generate.py; {ALDUINAK} {sha}; {len(load_order)} plugins; design {D['version'].split(' ')[0]}; {opts}"
    block, info = settings_block(D, cls, races, ingredients, enable, source)
    lists, checks = esp_lists(D, cls, lo, input_plugin, races)
    meta = (f"Input: {len(load_order)} plugins from the loadOrder of {a.settings}; {ALDUINAK} read from {input_plugin} "
            f"(sha256 {sha}); design {D['version']}; {opts}.")
    write_json(os.path.join(a.out, 'alduinakDamageFormulaSettings.json'), {'alduinakDamageFormulaSettings': block})
    write_json(os.path.join(a.out, 'esp-lists.json'), lists)
    write_text(os.path.join(a.out, 'report.md'), report(D, cls, meta, info, lists, checks))
    print(summary(block, lists, info))
    for p in info['problems']:
        print(f'[combat-settings] problem: {p}')
    return 1 if info['problems'] else 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except GenError as e:
        print(f'[combat-settings] {e}', file=sys.stderr)
        sys.exit(2)
