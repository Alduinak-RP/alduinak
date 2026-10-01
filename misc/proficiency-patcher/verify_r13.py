#!/usr/bin/env python3
# Independent check of a hotfix run (patch.py --hotfix --stage), reading every plugin with misc/esplib.py alone, no Mutagen:
#   python verify_r13.py --out <patch.py out dir> [--spec spec.json]
# The output is compared with its pre-cleaned input and with the winners of settings.stage.json before it; verify-r13.txt
# lists what was checked and every problem, exit code 3 on any.
import argparse
import collections
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from esplib import edid, parse_subs, scan, zstr  # noqa: E402
import patch  # noqa: E402

ESL, LOCALIZED_PLUGIN, COMPRESSED = 0x200, 0x80, 0x40000
DELETED, DISABLED = patch.DELETED, patch.INITIALLY_DISABLED
PLAYER_REF = ('skyrim.esm', 0x14)
# A localized plugin holds a string id in these, the output the text itself
LOCALIZED = {'FULL', 'DESC'}
CELL_GROUPS, WORLD_GROUPS = (6, 8, 9, 10), (1,)
# Created objects the crafting categories tag with keywords
ITEM_TYPES = {'ARMO', 'WEAP', 'AMMO', 'MISC', 'BOOK'}
# WEAP DNAM animation type by Mutagen's WeaponAnimationType name
WEAPON_ANIMATIONS = {'HandToHandMelee': 0, 'OneHandSword': 1, 'OneHandDagger': 2, 'OneHandAxe': 3, 'OneHandMace': 4, 'TwoHandSword': 5, 'TwoHandAxe': 6, 'Bow': 7, 'Staff': 8, 'Crossbow': 9}
SPELL_TYPES = {'Spell': 0, 'Disease': 1, 'Power': 2, 'LesserPower': 3, 'Ability': 4, 'Poison': 5, 'Addiction': 10, 'Voice': 11}
PLACED = {'REFR', 'ACHR', 'PGRE', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA', 'PHZD'}
# Subrecords made of form ids alone, where one left unrenumbered is an error rather than data that looks like one
PLACED_IDS = {'NAME', 'XESP', 'XOWN', 'XLCN', 'XEZN', 'XLKR', 'XLRT', 'XLRL', 'XMRC', 'INAM'}
FORM_IDS = {'ACHR': PLACED_IDS, 'REFR': PLACED_IDS, 'CELL': {'XCLR', 'LTMP', 'XCWT', 'XCCM', 'XCAS', 'XCMO', 'XCIM', 'XILL', 'XOWN', 'XLCN', 'XEZN'},
            'WRLD': {'WNAM', 'CNAM', 'NAM2', 'NAM3', 'XLCN', 'ZNAM'}, 'RACE': {'SPLO', 'KWDA', 'RNAM', 'WNAM'}, 'HDPT': {'RNAM', 'HNAM', 'TNAM', 'CNAM'}}
ANY_IDS = {'KWDA', 'EFID', 'EITM', 'ETYP', 'SPLO'}


class Plugin:
    def __init__(self, path, name=None):
        self.buf = open(path, 'rb').read()
        self.name = name or os.path.basename(path)
        self.flags = struct.unpack_from('<I', self.buf, 8)[0]
        head = parse_subs(self.buf[24:24 + struct.unpack_from('<I', self.buf, 4)[0]])
        self.masters = [zstr(v) for t, v in head if t == 'MAST']
        self.next_id = struct.unpack('<fII', next(v for t, v in head if t == 'HEDR'))[2]

    def key(self, fid):
        i = fid >> 24
        return (self.masters[i] if i < len(self.masters) else self.name).lower(), fid & 0xFFFFFF

    def container(self, rec, groups):
        return next((self.key(label) for g, label in reversed(rec.path) if g in groups), None)


def form_key(text):
    local, plugin = text.split(':', 1)
    return plugin.lower(), int(local, 16)


def show(key):
    return f'{key[1]:06X}:{key[0]}'


class Checker:
    def __init__(self, order, known):
        self.pos = {n.lower(): i for i, n in enumerate(order)}
        self.known = known
        self.tables = {}

    def table(self, src, dst):
        # Master index in src -> index of the same plugin in dst, for every form id prefix src can hold
        if (src.name, dst.name) not in self.tables:
            names = [m.lower() for m in src.masters] + [src.name.lower()]
            to = {m.lower(): i for i, m in enumerate(dst.masters)}
            to[dst.name.lower()] = len(dst.masters)
            self.tables[(src.name, dst.name)] = ([to.get(names[h]) if h < len(names) else None for h in range(256)], names)
        return self.tables[(src.name, dst.name)]

    def same_bytes(self, x, y, tab, names, ids):
        # None when equal except for form ids renumbered between the two master lists, at any offset
        x, y = patch.norm_zero(x), patch.norm_zero(y)
        if len(x) != len(y):
            return f'size {len(x)} -> {len(y)}'
        for i, (a, b) in enumerate(zip(x, y)):
            to = tab[a]
            if a == b:
                if ids and i % 4 == 3 and to is not None and to != a and (self.pos.get(names[a], 255) << 24 | int.from_bytes(x[i - 3:i], 'little')) in self.known:
                    return f'form id {x[i - 3:i + 1][::-1].hex()} at {i - 3} not renumbered'
            elif i < 3 or to != b or x[i - 3:i] != y[i - 3:i]:
                return f'byte {i}: {a:02x} -> {b:02x}'
        return None

    def compare(self, rtype, src, a_flags, a_data, dst, b_data, skip=()):
        # None when b (in dst) is a (in src) up to renumbered form ids and Mutagen's normalisations
        sa, sb = parse_subs(a_data), parse_subs(b_data)
        if a_flags & DELETED and not sb:
            return None
        drop = set(skip) | (LOCALIZED if src.flags & LOCALIZED_PLUGIN and not dst.flags & LOCALIZED_PLUGIN else set())
        # Mutagen writes subrecords in definition order
        sa = sorted(((t, v) for t, v in sa if t not in drop), key=lambda s: s[0])
        sb = sorted(((t, v) for t, v in sb if t not in drop), key=lambda s: s[0])
        if [t for t, _ in sa] != [t for t, _ in sb]:
            return f'subrecords {[t for t, _ in sa]} -> {[t for t, _ in sb]}'
        tab, names = self.table(src, dst)
        for (t, x), (_, y) in zip(sa, sb):
            if t == 'XPRM' and len(x) == len(y) == 32 and x[24:] == y[24:] and patch.floats_close(x[:24], y[:24]):
                continue
            why = self.same_bytes(x, y, tab, names, t in FORM_IDS.get(rtype, ANY_IDS))
            if why:
                return f'{t} {why}'
        return None


def enable_parent(pl, data):
    if b'XESP' not in data:
        return None
    for t, v in parse_subs(data):
        if t == 'XESP':
            return pl.key(struct.unpack_from('<I', v, 0)[0]), v[4] & 1
    return None


def spell_of(rec):
    subs = dict(rec.subs())
    return zstr(subs.get('EDID', b'')), struct.unpack_from('<I', subs['SPIT'], 8)[0] if 'SPIT' in subs else -1


def damage_of(rec):
    data = dict(rec.subs()).get('DATA', b'')
    return struct.unpack_from('<H', data, 8)[0] if len(data) >= 10 else None


def keywords_of(pl, data):
    kwda = dict(parse_subs(data)).get('KWDA', b'')
    return {pl.key(f) for f in struct.unpack(f'<{len(kwda) // 4}I', kwda)}


def id_list(pl, data, tag):
    return [pl.key(struct.unpack('<I', v)[0]) for t, v in parse_subs(data) if t == tag]


def check_race(ck, spec, spells, weapons, src, flags, data, out, q):
    # None when the race differs from its winner only as the races section says
    race = edid(q)
    p = next((x for x in spec.get('passives', []) if race in x['races']), {})
    description = spec.get('descriptions', {}).get(race)
    why = ck.compare('RACE', src, flags, data, out, q.data(), skip=('SPLO', 'SPCT', 'DATA') + (('DESC',) if description else ()))
    if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED:
        return why or f'flags {flags:#x} -> {q.flags:#x}'
    # DATA: starting health, magicka and stamina at 36, unarmed damage at 96
    want, got = bytearray(dict(parse_subs(data))['DATA']), dict(parse_subs(q.data()))['DATA']
    for i, stat in enumerate(('startingHealth', 'startingMagicka', 'startingStamina')):
        if stat in p:
            struct.pack_into('<f', want, 36 + 4 * i, p[stat])
    if 'unarmedDamageFrom' in p:
        struct.pack_into('<f', want, 96, weapons[p['unarmedDamageFrom']])
    elif 'unarmedDamage' in p:
        struct.pack_into('<f', want, 96, p['unarmedDamage'])
    if patch.norm_zero(bytes(want)) != patch.norm_zero(got):
        return f"DATA is not the winner's with the passives of the spec: {bytes(want).hex()} -> {got.hex()}"
    if description and zstr(dict(parse_subs(q.data())).get('DESC', b'')) != description:
        return 'description is not the spec text'
    types = {SPELL_TYPES[x] for x in spec.get('removeSpellTypes', [])}
    keep = set(spec.get('keepSpells', []))
    removable = lambda s: spells.get(s, ('', -1))[1] in types and spells[s][0] not in keep or spells.get(s, ('',))[0] in p.get('removeSpells', [])
    before, after = id_list(src, data, 'SPLO'), id_list(out, q.data(), 'SPLO')
    added = [spells.get(s, (s,))[0] for s in after if s not in before]
    speed = [s for s, races in spec.get('speed', {}).get('spells', {}).items() if race in races]
    if added != speed:
        return f'spells added: {added}, the speed section adds {speed}'
    wrong = [spells.get(s, s) for s in before if (s in after) == removable(s)]
    return f'spells kept or removed against the spec: {wrong}' if wrong else None


def effects_of(pl, data):
    # [effect key, magnitude, [(function, param 1, comparison value, operator and flags, run on)]] per effect of a spell
    out = []
    for t, v in parse_subs(data):
        if t == 'EFID':
            out.append([pl.key(struct.unpack('<I', v)[0]), None, []])
        elif t == 'EFIT' and out:
            out[-1][1] = struct.unpack_from('<f', v)[0]
        elif t == 'CTDA' and out:
            out[-1][2].append((struct.unpack_from('<H', v, 8)[0], struct.unpack_from('<I', v, 12)[0], struct.unpack_from('<f', v, 4)[0], v[0], struct.unpack_from('<I', v, 20)[0]))
    return out


def check_speed(speed, out, ro, races):
    # Each speed spell gives each sex the SpeedMult that brings SpeedMult / 100 x the race height to the target, and its races hand it out
    problems, own = [], {(t, edid(r)): (k, r) for (t, k), r in ro.items() if k[0] == out.name.lower()}
    heights = {edid(r): struct.unpack_from('<2f', dict(r.subs())['DATA'], 16) for (t, k), r in ro.items() if t == 'RACE'}
    for spell, names in speed['spells'].items():
        if ('SPEL', spell) not in own:
            problems.append(f'SPEL {spell}: missing')
            continue
        key, rec = own[('SPEL', spell)]
        pairs = {heights.get(n) for n in names}
        if None in pairs or len(pairs) != 1:
            problems.append(f'SPEL {spell}: races {names} lack an override or differ in height')
            continue
        male, female = pairs.pop()
        want = [(None, male)] if male == female else [(0, male), (1, female)]
        effects = effects_of(out, rec.data())
        if len(effects) != len(want):
            problems.append(f'SPEL {spell}: {len(effects)} effects for heights {male}/{female}')
            continue
        for (mgef, magnitude, conds), (sex, height) in zip(effects, want):
            data = dict(ro[('MGEF', mgef)].subs())['DATA'] if ('MGEF', mgef) in ro else b''
            if len(data) < 72 or struct.unpack_from('<Ii', data, 64) != (0, 30) or not struct.unpack_from('<I', data)[0] & 2:
                problems.append(f'SPEL {spell}: effect {show(mgef)} is not a recovering SpeedMult value modifier')
            if conds != ([] if sex is None else [(70, sex, 1.0, 0, 0)]):
                problems.append(f'SPEL {spell}: conditions {conds} for sex {sex}')
            if abs((1 + magnitude / 100) * height - speed['target']) > 1e-5:
                problems.append(f'SPEL {spell}: SpeedMult +{magnitude} at height {height} gives {(1 + magnitude / 100) * height}, not {speed["target"]}')
        problems.extend(f'RACE {n}: does not hand out {spell}' for n in names if key not in races.get(n, []))
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='the patch.py --stage output folder')
    ap.add_argument('--spec', default=os.path.join(HERE, 'spec.json'))
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding='utf-8'))
    name = spec.get('pluginName', 'AlduinakAdditions.esp')
    me = name.lower()
    stage = json.load(open(os.path.join(a.out, 'settings.stage.json'), encoding='utf-8'))
    order = [os.path.basename(p.replace('\\', '/')) for p in stage['loadOrder']]
    here = [n.lower() for n in order].index(me)
    inp = Plugin(os.path.join(a.out, os.path.splitext(name)[0] + '.preclean.esp'), name)
    out = Plugin(os.path.join(a.out, name), name)
    log, problems, checked = [], [], collections.Counter()

    # Masters: the input's plus plugins loaded before this one, in load order, never one generated from the whole order
    pos = {n.lower(): i for i, n in enumerate(order)}
    mo, mi = [m.lower() for m in out.masters], [m.lower() for m in inp.masters]
    log.append(f'masters: {len(mi)} -> {len(mo)}' + ''.join(f'\n  master added: {m}' for m in out.masters if m.lower() not in mi))
    problems.extend(f'masters: {m} was dropped' for m in inp.masters if m.lower() not in mo)
    if any(pos.get(m, here) >= here for m in mo) or [pos[m] for m in mo] != sorted(pos[m] for m in mo):
        problems.append(f'masters: not a load-order subsequence of the plugins before {name}')
    problems.extend(f'masters: {m} is generated from the whole load order' for m in out.masters if m.lower() in patch.NEVER_MASTERS)
    if out.next_id < inp.next_id:
        problems.append(f'HEDR next object id {out.next_id:#x} is below the input {inp.next_id:#x}')

    def index(pl):
        recs, dup = {}, []
        for r in scan(pl.buf):
            k = (r.type, pl.key(r.fid))
            if k in recs:
                dup.append(k)
            recs[k] = r
        return recs, dup
    ri, _ = index(inp)
    ro, dup = index(out)
    problems.extend(f'{t} {show(k)} appears twice' for t, k in dup)

    # Nothing is dropped, own records keep their local ids, and new ones take ids past the input's next object id
    for (t, k), r in ri.items():
        if k[0] == me and (edid(ro[(t, k)]) if (t, k) in ro else None) not in (edid(r), 'AldProf_' + edid(r)[len('AldMastery_'):] if t == 'SPEL' and edid(r).startswith('AldMastery_') else None):
            problems.append(f'own {t} {show(k)} {edid(r)} lost its local id')
        elif (t, k) not in ro:
            problems.append(f'{t} {show(k)} {edid(r)} was dropped')
    problems.extend(f'new own {t} {show(k)} reuses an id below {inp.next_id:#x}' for t, k in ro if k[0] == me and (t, k) not in ri and k[1] < inp.next_id)

    # Winners before the plugin: the records the output overrides and every actor's state; every record key feeds the form id check
    known = {here << 24 | k[1] for _, k in list(ri) + list(ro) if k[0] == me}
    disable_refs = {form_key(x) for x in spec.get('disableReferences', {}).get('refs', [])}
    enable_refs = {form_key(x) for x in spec.get('enableReferences', {}).get('refs', [])}
    problems.extend(f'{show(k)} is in disableReferences and enableReferences both' for k in sorted(disable_refs & enable_refs))
    listed_refs = disable_refs | enable_refs
    # A worldspace override takes its fields from the last winner outside these
    not_from = {n.lower() for n in spec.get('disableActors', {}).get('notFrom', [])}
    winners, actors, parents, spells, races, weapons, lists, effects, slot = {}, {}, {}, {}, {}, {}, {}, {}, 0
    for n in order[:here]:
        pl = Plugin(os.path.join(stage['dataDir'], n))
        if not (pl.flags & ESL or n.lower().endswith('.esl')):
            slot += 1
        for r in scan(pl.buf):
            k = pl.key(r.fid)
            known.add(pos.get(k[0], 255) << 24 | k[1])
            if r.type in PLACED:
                parents[k] = (r.type, r.flags, enable_parent(pl, r.data()))
            if r.type == 'ACHR':
                actors[k] = (n, r.flags, parents[k][2])
            if r.type == 'SPEL':
                spells[k] = spell_of(r)
            if r.type == 'WEAP':
                weapons[edid(r)] = damage_of(r)
            if r.type == 'FLST':
                lists[edid(r)] = k
            if r.type == 'MGEF':
                effects[edid(r)] = k
            if r.type == 'RACE':
                races[edid(r)] = id_list(pl, r.data(), 'SPLO')
            if ((r.type, k) in ro or r.type in PLACED and k in listed_refs) and not (r.type == 'WRLD' and n.lower() in not_from):
                winners[(r.type, k)] = (pl, r.flags, r.data(), pl.container(r, CELL_GROUPS if r.type != 'CELL' else WORLD_GROUPS))
        pl.buf = None
    for (t, k), r in ro.items():
        if t in PLACED:
            parents[k] = (t, r.flags, enable_parent(out, r.data()))
        if t == 'ACHR':
            actors[k] = (name, r.flags, parents[k][2])
        if t == 'SPEL':
            spells[k] = spell_of(r)
        if t == 'WEAP':
            weapons[edid(r)] = damage_of(r)
        if t == 'RACE':
            races[edid(r)] = id_list(out, r.data(), 'SPLO')
    ck = Checker(order, known)

    # Every changed or added record is one a spec section explains
    allowed = patch.spec_allowed(a.spec)
    switched = set()
    head_parts = {p: h['validRaces'] for h in spec.get('headParts', []) for p in h['parts']}
    prefix = spec.get('craftingCategories', {}).get('keywordPrefix')
    tags = {k for (t, k), r in ro.items() if t == 'KYWD' and k[0] == me and (prefix and edid(r).startswith(prefix) or edid(r).startswith('AldKeyword_'))}
    # The overrides section: an item keeps everything but its weight, a recipe everything but its created count, a food everything but one effect, an own reference everything but its scale, a quest everything but the scripts it drops, a global everything but its value, a light everything but its burn time, a weapon everything but its animation type, a moved reference everything but its position and scale, a reflagged reference everything but its flags
    over = spec.get('overrides', {})
    over_misc = {form_key(m['item']): m['weight'] for m in over.get('misc', [])}
    over_cobj = {form_key(r['recipe']): r['count'] for r in over.get('recipes', [])}
    over_qust = {form_key(q['quest']): q['dropScripts'] for q in over.get('quests', [])}
    over_glob = {form_key(g['global']): g['value'] for g in over.get('globals', [])}
    over_ligh = {form_key(x['item']): x['time'] for x in over.get('lights', [])}
    over_weap = {form_key(w['item']): w['animation'] for w in over.get('weapons', [])}
    over_move = {form_key(m['ref']): (m['pos'], m.get('scale')) for m in over.get('moves', [])}
    over_flags = {form_key(f.get('ref') or f['item']): (int(f.get('clear', '0'), 16), int(f.get('set', '0'), 16)) for f in over.get('flags', [])}
    over_refs = {r['ref']: r['scale'] for r in over.get('refs', [])}
    over_food = {form_key(f['item']): (effects.get(f['from']), effects.get(f['hunger'])) for f in over.get('foods', [])}
    for (t, k), q in ro.items():
        r = ri.get((t, k))
        diff = None if r is None else ck.compare(t, inp, r.flags, r.data(), out, q.data()) or (r.flags & ~COMPRESSED != q.flags & ~COMPRESSED and f'flags {r.flags:#x} -> {q.flags:#x}')
        if r is not None and not diff:
            checked['unchanged'] += 1
            continue
        groups = WORLD_GROUPS if t == 'CELL' else CELL_GROUPS
        ref = (inp, r.flags, r.data(), inp.container(r, groups)) if r is not None else winners.get((t, k))
        where = out.container(q, groups)
        label = f'{t} {show(k)} {edid(q)}'.rstrip()
        if ref is None and k[0] != me:
            problems.append(f'{label}: overrides a record no plugin before it defines')
            continue
        if t == 'ACHR' and 'disableActors' in spec:
            src, flags, data, cell = ref
            parent = enable_parent(src, data)
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('XESP',))
            if q.flags & ~COMPRESSED != (flags | DISABLED) & ~COMPRESSED:
                why = f'flags {flags:#x} -> {q.flags:#x}'
            elif (parent is None) != (enable_parent(out, q.data()) is None) or parent and enable_parent(out, q.data()) != (PLAYER_REF, 1):
                why = f'enable parent {parent} -> {enable_parent(out, q.data())}'
            elif cell != where:
                why = f'moved from cell {cell} to {where}'
            if why:
                problems.append(f'{label}: not {src.name}\'s actor Initially Disabled ({why})')
            switched.add(k)
            checked[f'actors disabled (from {"the input" if r is not None else "the load order"})'] += 1
        elif t in ('CELL', 'WRLD') and r is None:
            src, flags, data, world = ref
            # The offset table only fits the file it came from
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('OFST',))
            if q.flags & ~COMPRESSED != flags & ~COMPRESSED:
                why = f'flags {flags:#x} -> {q.flags:#x}'
            elif world != where:
                why = f'moved from worldspace {world} to {where}'
            if why:
                problems.append(f'{label}: not the {src.name} record ({why})')
            checked[f'new {t} overrides equal to the winner'] += 1
        elif t in ('CELL', 'WRLD'):
            problems.append(f'{label}: a record the input already held changed ({diff})')
        elif t == 'RACE' and edid(q) in spec.get('races', {}).get('races', []):
            why = check_race(ck, spec['races'], spells, weapons, *ref[:3], out, q)
            if why:
                problems.append(f'{label}: {why}')
            checked['races checked against the races section'] += 1
        elif t == 'MISC' and k in over_misc:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('DATA',))
            was, now = dict(parse_subs(data)).get('DATA', b''), dict(parse_subs(q.data())).get('DATA', b'')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or len(now) != 8 or was[:4] != now[:4] or abs(struct.unpack('<f', now[4:])[0] - over_misc[k]) > 1e-6:
                problems.append(f'{label}: not {src.name}\'s item with only the weight set to {over_misc[k]} ({why or now.hex()})')
            checked['items overridden for their weight'] += 1
        elif t == 'COBJ' and k in over_cobj:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('NAM1',))
            nam1 = dict(parse_subs(q.data())).get('NAM1', b'')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or len(nam1) != 2 or struct.unpack('<H', nam1)[0] != over_cobj[k]:
                problems.append(f'{label}: not {src.name}\'s recipe with only the created count set to {over_cobj[k]} ({why or nam1.hex()})')
            checked['recipes overridden for their created count'] += 1
        elif t == 'ALCH' and k in over_food:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('EFID',))
            swap, now = over_food[k], id_list(out, q.data(), 'EFID')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or None in swap or now != [swap[1] if e == swap[0] else e for e in id_list(src, data, 'EFID')]:
                problems.append(f'{label}: not {src.name}\'s food with only {swap[0]} swapped for {swap[1]} ({why or now})')
            checked['foods overridden for their hunger effect'] += 1
        elif t == 'QUST' and k in over_qust:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('VMAD',))
            vmad = dict(parse_subs(q.data())).get('VMAD', b'')
            left = [s for s in over_qust[k] if s.encode() in vmad]
            if why or left or q.flags & ~COMPRESSED != flags & ~COMPRESSED:
                problems.append(f'{label}: not {src.name}\'s quest with only {over_qust[k]} dropped ({why or left})')
            checked['quests overridden without named scripts'] += 1
        elif t == 'GLOB' and k in over_glob:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('FLTV',))
            fltv = dict(parse_subs(q.data())).get('FLTV', b'')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or len(fltv) != 4 or abs(struct.unpack('<f', fltv)[0] - over_glob[k]) > 1e-6:
                problems.append(f'{label}: not {src.name}\'s global with only the value set to {over_glob[k]} ({why or fltv.hex()})')
            checked['globals overridden for their value'] += 1
        elif t == 'LIGH' and k in over_ligh:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('DATA',))
            was, now = dict(parse_subs(data)).get('DATA', b''), dict(parse_subs(q.data())).get('DATA', b'')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or len(now) != len(was) or len(now) < 4 or was[4:] != now[4:] or struct.unpack_from('<i', now)[0] != over_ligh[k]:
                problems.append(f'{label}: not {src.name}\'s light with only the burn time set to {over_ligh[k]} ({why or now.hex()})')
            checked['lights overridden for their burn time'] += 1
        elif t == 'WEAP' and k in over_weap:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('DNAM',))
            was, now = dict(parse_subs(data)).get('DNAM', b''), dict(parse_subs(q.data())).get('DNAM', b'')
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or len(now) != len(was) or not now or was[1:] != now[1:] or now[0] != WEAPON_ANIMATIONS.get(over_weap[k]):
                problems.append(f'{label}: not {src.name}\'s weapon with only the animation type set to {over_weap[k]} ({why or now[:1].hex()})')
            checked['weapons overridden for their animation type'] += 1
        elif t == 'REFR' and k[0] == me and edid(q) in over_refs and r is not None:
            why = ck.compare(t, inp, r.flags, r.data(), out, q.data(), skip=('XSCL',))
            xscl = dict(parse_subs(q.data())).get('XSCL', b'')
            if why or q.flags & ~COMPRESSED != r.flags & ~COMPRESSED or len(xscl) != 4 or abs(struct.unpack('<f', xscl)[0] - over_refs[edid(q)]) > 1e-6:
                problems.append(f'{label}: not the input\'s reference with only the scale set to {over_refs[edid(q)]} ({why or xscl.hex()})')
            checked['own references overridden for their scale'] += 1
        elif t in ITEM_TYPES and r is None and k[0] != me and tags:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('KWDA', 'KSIZ'))
            before, after = keywords_of(src, data), keywords_of(out, q.data())
            if why or q.flags & ~COMPRESSED != flags & ~COMPRESSED or not before <= after or not after - before <= tags:
                problems.append(f'{label}: not {src.name}\'s item with only crafting category keywords added ({why or sorted(after ^ before)})')
            checked['items overridden for their crafting category keywords'] += 1
        elif t == 'HDPT' and edid(q) in head_parts:
            src, flags, data, _ = ref
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('RNAM',))
            rnam = dict(parse_subs(q.data())).get('RNAM')
            if why or not rnam or out.key(struct.unpack('<I', rnam)[0]) != lists.get(head_parts[edid(q)]):
                problems.append(f'{label}: not {src.name}\'s head part offered to {head_parts[edid(q)]} ({why or "race list"})')
            checked['head parts given their race list'] += 1
        elif t == 'REFR' and k in over_move:
            src, flags, data, cell = ref
            pos, scale = over_move[k]
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('DATA',) + (('XSCL',) if scale is not None else ()))
            was, now = dict(parse_subs(data)).get('DATA', b''), dict(parse_subs(q.data())).get('DATA', b'')
            moved = len(was) == len(now) == 24 and struct.unpack('<3f', was[12:]) == struct.unpack('<3f', now[12:]) \
                and all(abs(x - y) <= 1e-3 for x, y in zip(struct.unpack('<3f', now[:12]), pos))
            xscl = dict(parse_subs(q.data())).get('XSCL', b'')
            if scale is not None and (len(xscl) != 4 or abs(struct.unpack('<f', xscl)[0] - scale) > 1e-6):
                why = why or f'XSCL {xscl.hex()}'
            if why or not moved or q.flags & ~COMPRESSED != flags & ~COMPRESSED or cell != where:
                problems.append(f'{label}: not {src.name}\'s reference with only the position set to {pos}{"" if scale is None else f" and the scale to {scale}"} ({why or now.hex()}, cell {cell} -> {where})')
            checked['references moved to their overridden position'] += 1
        elif (t in PLACED or t == 'ARMO') and k in over_flags:
            src, flags, data, cell = ref
            clear, set_ = over_flags[k]
            why = ck.compare(t, src, flags, data, out, q.data())
            if why or q.flags & ~COMPRESSED != ((flags & ~clear) | set_) & ~COMPRESSED or cell != where:
                problems.append(f'{label}: not {src.name}\'s record with only flags {clear:#x} cleared and {set_:#x} set ({why or f"flags {flags:#x} -> {q.flags:#x}"}, cell {cell} -> {where})')
            checked[f'{"references" if t in PLACED else "armour"} overridden for their flags'] += 1
        elif t in PLACED and k in disable_refs:
            src, flags, data, cell = ref
            parent = enable_parent(src, data)
            why = ck.compare(t, src, flags, data, out, q.data(), skip=('XESP',))
            if q.flags & ~COMPRESSED != (flags | DISABLED) & ~COMPRESSED or cell != where:
                why = f'flags {flags:#x} -> {q.flags:#x}, cell {cell} -> {where}'
            elif enable_parent(out, q.data()) != (parent if parent in (None, (PLAYER_REF, 1)) else (PLAYER_REF, 1)):
                why = f'enable parent {parent} -> {enable_parent(out, q.data())}'
            if why:
                problems.append(f'{label}: not {src.name}\'s reference Initially Disabled ({why})')
            checked['disableReferences references'] += 1
        elif t == 'REFR' and k in enable_refs:
            src, flags, data, cell = ref
            why = ck.compare(t, src, flags, data, out, q.data())
            if q.flags & ~COMPRESSED != (flags & ~DISABLED) & ~COMPRESSED or cell != where:
                why = f'flags {flags:#x} -> {q.flags:#x}, cell {cell} -> {where}'
            if why:
                problems.append(f'{label}: not {src.name}\'s reference with Initially Disabled cleared ({why})')
            checked['enableReferences references'] += 1
        elif t in patch.PATCHED_TYPES or allowed((t, 'self' if k[0] == me else k[0], k[1] if k[0] != me else edid(q) or f'{k[1]:06X}'), q):
            checked[f'{t} added or changed by the spec'] += 1
        else:
            problems.append(f'{label}: {f"changed ({diff})" if r is not None else "added"}, and no spec section writes it')

    # The marker spells keep the ids live characters and server-settings.json name, renamed AldProf_ by the revamp; their shared effect is unchanged
    for (t, k), r in ri.items():
        if k[0] == me and t == 'SPEL' and edid(r).startswith(('AldMastery_', 'AldProf_')):
            want = 'AldProf_' + edid(r).split('_', 1)[1]
            if (t, k) not in ro or edid(ro[(t, k)]) != want:
                problems.append(f'{t} {edid(r)}: not kept at {k[1]:06X} as {want}')
            checked['marker spells kept at their ids'] += 1
        elif k[0] == me and (t, k[1]) == ('MGEF', 0x20E5):
            why = ck.compare(t, inp, r.flags, r.data(), out, ro[(t, k)].data()) if (t, k) in ro else 'missing'
            if why:
                problems.append(f'{t} {edid(r)}: changed ({why})')
            checked['marker effect unchanged'] += 1

    # Every actor and listed reference ends Initially Disabled with no enable parent that could turn it on
    if 'disableActors' in spec:
        keep = {form_key(x) for x in spec['disableActors'].get('except', [])} | {PLAYER_REF}
        for k, (winner, flags, parent) in actors.items():
            if k in keep or flags & DELETED:
                continue
            if not flags & DISABLED or parent not in (None, (PLAYER_REF, 1)):
                problems.append(f'ACHR {show(k)} from {winner} can still be enabled (flags {flags:#x}, enable parent {parent})')
            checked['actors covered'] += 1
        # A reference whose enable parent is an actor switched off here goes with it, unless it is set to the opposite state
        for k, (t, flags, parent) in parents.items():
            if parent and parent[0] in switched and not flags & DELETED:
                checked[f'{t} whose enable parent is an actor switched off{", opposite" if parent[1] else ""}'] += 1
                if parent[1] and t != 'ACHR':
                    problems.append(f'{t} {show(k)} turns on when its enable parent, actor {show(parent[0])}, is disabled')
    # Every listed race ends without the spells the races section removes
    rs = spec.get('races', {})
    types = {SPELL_TYPES[x] for x in rs.get('removeSpellTypes', [])}
    for race in rs.get('races', []):
        left = [spells[s][0] for s in races.get(race, []) if s in spells and spells[s][1] in types and spells[s][0] not in rs.get('keepSpells', [])]
        if race not in races or left:
            problems.append(f'RACE {race}: {"not found" if race not in races else f"still hands out {left}"}')
    if 'speed' in rs:
        problems.extend(check_speed(rs['speed'], out, ro, races))
        checked['race speed spells checked'] += len(rs['speed']['spells'])
    for k in disable_refs:
        final = ro.get(('REFR', k)) or ro.get(('ACHR', k)) or ro.get(('PHZD', k))
        flags = final.flags if final is not None else (winners.get(('REFR', k)) or winners.get(('PHZD', k)) or (None, 0))[1]
        parent = parents.get(k, (None, 0, None))[2]
        if not flags & (DISABLED | DELETED):
            problems.append(f'disableReferences {show(k)} is not Initially Disabled')
        elif not flags & DELETED and parent not in (None, (PLAYER_REF, 1)):
            problems.append(f'disableReferences {show(k)} can still be enabled by its enable parent {parent}')
    # A winner already enabled gets no override, so its own flags decide
    for k in enable_refs:
        final = ro.get(('REFR', k))
        flags = final.flags if final is not None else winners.get(('REFR', k), (None, DISABLED))[1]
        if flags & (DISABLED | DELETED):
            problems.append(f'enableReferences {show(k)} is not enabled in the output')

    # proficiency-ids.json carries the full slot the server and the game give the plugin
    ids = json.load(open(os.path.join(a.out, 'proficiency-ids.json'), encoding='utf-8'))
    local = {edid(r): k[1] for (t, k), r in ro.items() if t == 'SPEL' and k[0] == me}
    if ids['loadIndex'] != slot:
        problems.append(f'proficiency-ids.json: loadIndex {ids["loadIndex"]:#x}, the load order gives {slot:#x}')
    for e, gid in ids['markerSpells'].items():
        if int(gid, 16) != (slot << 24 | local.get(e, -1)):
            problems.append(f'proficiency-ids.json: {e} is {gid}, the plugin holds it at {local.get(e, -1):06X} in slot {slot:#x}')
    log.append(f'full slot {slot:#04x}; AldProf_Hunter_Master {ids["markerSpells"].get("AldProf_Hunter_Master")}')
    log.append(f'records: {len(ri)} -> {len(ro)}')
    log.extend(f'  {what}: {n}' for what, n in sorted(checked.items()))
    with open(os.path.join(a.out, 'verify-r13.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(log + [''] + problems) + '\n')
    print('\n'.join(log))
    if problems:
        print(f'VERIFY R13 FAILED: {len(problems)} problem(s), first 20:')
        print('\n'.join(problems[:20]))
        sys.exit(3)
    print(f'verified {os.path.join(a.out, name)} against its input and the load order before it')


if __name__ == '__main__':
    main()
