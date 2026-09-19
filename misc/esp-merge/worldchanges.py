#!/usr/bin/env python3
# Turns Graves's AlduinakWorldChanges.esp into the "world" section of the proficiency spec, and says why it drops
# everything it drops. His Creation Kit keeps only ESM masters, so the plugin re-owns the records of the .esp master
# it loaded and rewrites every cell it touched; only the references are worth carrying.
#   python worldchanges.py            # classify and check the section spec.json holds
#   python worldchanges.py --write    # rewrite that section
import json
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, '..')]
from r7lib import RUN, STAGE, STAGE_SETTINGS, check_sha  # noqa: E402
from esplib import Plugin, Record  # noqa: E402
import fastesp  # noqa: E402

SPEC = os.path.join(HERE, '..', 'proficiency-patcher', 'spec.json')
WORLD = (RUN['dir'] + 'input/AlduinakWorldChanges.esp', '9776cba33bc215c4a693648a88314fa080858acbed7986db2a16d71d5471b1cc')
BASE = RUN['BASE']
VANILLA = ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm']
# The plugin's own index. It is one past the self index because the Creation Kit dropped one .esp master.
OWN = 6
# The bench the placeholders become, and the first id of the block the new references take
BENCH = 'AldWoodcraftingBench'
ID_BASE = 0x2200
# What the Creation Kit rewrites in a cell or worldspace it merely opened: delocalized names, dropped large-reference
# and offset tables, recalculated height and land data, reordered regions, an editor id, water and location links.
CONTAINER_NOISE = {'FULL', 'RNAM', 'OFST', 'MHDT', 'XCLC', 'XCLR', 'EDID', 'DATA', 'XCWT', 'XLCN', 'TVDT'}
# Subrecords the Creation Kit adds to or rounds on a reference it did not really change
REF_NOISE = {'XLRL', 'XSCL'}


def key_of(masters, fid, dropped):
    idx, loc = fid >> 24, fid & 0xFFFFFF
    if idx < len(masters):
        return masters[idx], loc
    return (dropped if idx == OWN else '?'), loc


def placement(rec):
    return struct.unpack('<6f', dict(rec.subs())['DATA'])


def base_of(rec):
    return struct.unpack('<I', dict(rec.subs())['NAME'])[0]


def load_order():
    return [os.path.basename(p) for p in json.load(open(STAGE_SETTINGS, encoding='utf-8'))['loadOrder']]


def own_refs(path, name):
    # (local id, (plugin, local id) of the base object) of every reference the plugin defines itself
    pl = fastesp.load(path)
    n, m = len(pl['masters']), pl['masters']
    out = {}
    for r in pl['recs']:
        if r.type != 'REFR' or (r.fid >> 24) != n:
            continue
        nm = r.sub('NAME')
        if nm:
            b = struct.unpack('<I', nm)[0]
            out[r.fid & 0xFFFFFF] = ((m[b >> 24] if (b >> 24) < n else name), b & 0xFFFFFF)
    return out


def winners(order):
    # (plugin, local id) -> the winning REFR of the load order, and the plugins that define each record itself
    win, defined = {}, {}
    for fn in order:
        path = STAGE + fn
        if not os.path.exists(path):
            continue
        pl = fastesp.load(path)
        n, m = len(pl['masters']), pl['masters']
        for r in pl['recs']:
            if r.type != 'REFR':
                continue
            k = ((m[r.fid >> 24] if (r.fid >> 24) < n else fn), r.fid & 0xFFFFFF)
            win[k] = r
            if (r.fid >> 24) == n:
                defined[k] = fn
    return win, defined


def classify(report):
    g = Plugin(check_sha(*WORLD))
    assert g.masters() == VANILLA, f'AlduinakWorldChanges.esp masters are {g.masters()}, not the five vanilla ones'
    order = load_order()
    win, _ = winners(order)
    base = fastesp.load(check_sha(*BASE))
    bm = base['masters']
    held = {((bm[r.fid >> 24] if (r.fid >> 24) < len(bm) else 'self'), r.fid & 0xFFFFFF): r
            for r in base['recs'] if r.type == 'REFR'}

    mine = [n for n, _ in g.walk() if isinstance(n, Record)]
    assert {r.fid >> 24 for r in mine} <= set(range(len(VANILLA))) | {OWN}, 'a record sits at an unexpected master index'

    # Which .esp master the Creation Kit dropped: the one whose own references the plugin re-owned, id and base object
    ours = [r for r in mine if (r.fid >> 24) == OWN and r.type == 'REFR']
    candidates = {}
    for fn in order:
        path = STAGE + fn
        if not os.path.exists(path):
            continue
        theirs = own_refs(path, fn)
        hits = [r for r in ours if (r.fid & 0xFFFFFF) in theirs
                and theirs[r.fid & 0xFFFFFF] == key_of(VANILLA, base_of(r), fn)]
        if hits:
            candidates[fn] = {r.fid & 0xFFFFFF for r in hits}
    assert len(candidates) == 1, f'the dropped master is not a single plugin: {sorted(candidates)}'
    dropped, reowned = next(iter(candidates.items()))
    report.append(f'dropped master: {dropped}, {len(reowned)} references re-owned by the Creation Kit')

    # Containers: never carried, so nothing the CK rewrote in them can reach the plugin
    sk = fastesp.load(STAGE + 'Skyrim.esm')
    vanilla = {(r.type, r.fid): r for r in sk['recs'] if r.type in ('CELL', 'WRLD')}
    noise = set()
    for r in mine:
        if r.type not in ('CELL', 'WRLD'):
            continue
        v = vanilla[(r.type, r.fid)]
        a, b = dict(r.subs()), dict(v.subs())
        noise |= {t for t in set(a) | set(b) if a.get(t) != b.get(t)}
    assert noise <= CONTAINER_NOISE, f'a cell or worldspace carries a real edit: {sorted(noise - CONTAINER_NOISE)}'
    containers = sum(1 for r in mine if r.type in ('CELL', 'WRLD'))
    report.append(f'dropped {containers} cell and worldspace records: Creation Kit rewrites only ({" ".join(sorted(noise))})')

    placements, moves, disables, skipped = [], [], [], []
    for r in sorted(mine, key=lambda x: x.fid):
        if r.type != 'REFR':
            continue
        idx = r.fid >> 24
        loc = r.fid & 0xFFFFFF
        pos = placement(r)
        if idx == OWN and loc not in reowned:
            cell = key_of(VANILLA, [p for n, p in g.walk() if n is r][0][-1].label, dropped)
            b = key_of(VANILLA, base_of(r), dropped)
            scale = dict(r.subs()).get('XSCL')
            placements.append({
                'edid': f'AldWorldRef_{loc:06X}',
                'base': BENCH if b == ('HearthFires.esm', 0x003065) else '%06X:%s' % (b[1], b[0]),
                'cell': '%06X:%s' % (cell[1], cell[0]),
                'pos': [round(x, 2) for x in pos[:3]],
                'rot': [round(x, 5) for x in pos[3:]],
                **({'scale': round(struct.unpack('<f', scale)[0], 4)} if scale else {}),
            })
            continue
        key = (dropped, loc) if idx == OWN else (VANILLA[idx], loc)
        name = '%06X:%s' % (loc, key[0])
        against = held.get(key) or win[key]
        where = 'the plugin' if key in held else 'the load order'
        other = placement(against)
        moved = math.dist(pos[:3], other[:3])
        turned = max(abs(pos[i] - other[i]) for i in range(3, 6))
        a, b = dict(r.subs()), dict(against.subs())
        differs = {t for t in set(a) | set(b) if a.get(t) != b.get(t)} - REF_NOISE - {'DATA'}
        disabled = bool(r.flags & 0x800), bool(against.flags & 0x800)
        assert turned < 1e-4, f'{name} was rotated, which this step does not carry'
        if disabled[0] and not disabled[1]:
            disables.append(name)
            skipped.append(f'{name}: disabled, moved {moved:.0f} units in {where} (the move is not carried, the reference is off)')
        elif disabled[0] and disabled[1]:
            skipped.append(f'{name}: already disabled in {where}, moved {moved:.0f} units'
                           + (f', Creation Kit dropped {" ".join(sorted(differs))}' if differs else ''))
        elif moved < 1:
            skipped.append(f'{name}: unchanged against {where}, Creation Kit noise only')
        else:
            assert not differs, f'{name} differs beyond its position: {sorted(differs)}'
            moves.append({'ref': name, 'pos': [round(x, 2) for x in pos[:3]]})
            skipped.append(f'{name}: moved {moved:.0f} units against {where}, kept disabled' if disabled[1] else None)
    for i, p in enumerate(sorted(placements, key=lambda x: x['edid'])):
        p['formId'] = f'0x{ID_BASE + i:04X}'
    return placements, moves, disables, [s for s in skipped if s], dropped


def section(placements, moves, dropped):
    out = []
    for p in sorted(placements, key=lambda x: x['edid']):
        e = {'edid': p['edid'], 'formId': p['formId'], 'base': p['base'], 'cell': p['cell'],
             'pos': p['pos'], 'rot': p['rot']}
        if 'scale' in p:
            e['scale'] = p['scale']
        out.append(e)
    return {
        'comment': ('AlduinakWorldChanges.esp (9776cba3), merged as spec data. Its Creation Kit dropped the '
                    f'{dropped} master and rewrote every cell it opened, so only the references are carried: '
                    'the new ones here, the nudges under "moves", and one disable under "disableReferences". '
                    'misc/esp-merge/worldchanges.py regenerates and checks this section.'),
        'placements': out,
        'moves': moves,
    }


def main():
    report = []
    placements, moves, disables, skipped, dropped = classify(report)
    want = section(placements, moves, dropped)
    spec = json.load(open(SPEC, encoding='utf-8'))
    report.append(f'{len(placements)} new references, {len(moves)} moves, {len(disables)} disables, {len(skipped)} records dropped')
    report += ['  ' + s for s in skipped]
    report += [f'  disable {d}' for d in disables]
    print('\n'.join(report))
    if '--write' in sys.argv:
        ordered = {}
        for k, v in spec.items():
            ordered[k] = v
            # next to the other reference work, not at the end of the file
            if k == 'placements':
                ordered['world'] = want
        spec = ordered
        refs = spec['disableReferences']['refs']
        for d in disables:
            if d not in refs:
                refs.append(d)
        with open(SPEC, 'w', encoding='utf-8', newline=chr(10)) as f:
            json.dump(spec, f, indent=1, ensure_ascii=False)
            f.write('\n')
        print(f'wrote the world section and {len(disables)} disable(s) into {SPEC}')
        return
    got = spec.get('world')
    if json.dumps(got, sort_keys=True) != json.dumps(want, sort_keys=True):
        print('\nthe spec section differs from the plugin; run with --write')
        print(json.dumps(want, indent=1))
        sys.exit(4)
    missing = [d for d in disables if d not in spec['disableReferences']['refs']]
    assert not missing, f'disableReferences is missing {missing}'
    print('the spec section matches the plugin')


if __name__ == '__main__':
    main()
