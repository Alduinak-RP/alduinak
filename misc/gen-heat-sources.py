"""Generates the survival heat sources (skymp5-server/ts/systems/heatSources.ts).

Walks every plugin of the server loadOrder in order and keeps the last override
of each placed reference (REFR), so a mod that moves, deletes or disables a
campfire wins like it does in game. A reference counts when it is neither
deleted nor Initially Disabled and its base is a heat source: a base of
Survival Mode's Survival_WarmUpObjectsList (campfires, fireplaces, fire FX,
forges, smelters), a base named in survivalHeatExtraBases, or furniture (FURN)
carrying a keyword of survivalHeatKeywords (default CraftingCookpot, the
cooking spits and pots, and AldCraftingKiln). Positions are bucketed by
interior cell desc, or by worldspace desc and 4096-unit grid cell, so the
server's heat check reads only the cells around a player.

Run:  python misc/gen-heat-sources.py                 (writes the .ts)
      python misc/gen-heat-sources.py --dump          (bases and counts per base; nothing written)
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from esplib import parse_subs, scan, zstr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'heatSources.ts')

DELETED = 0x20
INITIALLY_DISABLED = 0x800
LIGHT_PLUGIN = 0x200
GRID = 4096
# Group types: 1 world children, 6/8/9/10 cell children
WORLD_CHILDREN = 1
CELL_CHILDREN = {6, 8, 9, 10}
WARM_UP_LIST = 'Survival_WarmUpObjectsList'
DEFAULT_KEYWORDS = ['CraftingCookpot', 'AldCraftingKiln']


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def first_sub(data, name):
    """The first subrecord of a type in raw record data, without decoding the rest."""
    i = 0
    while i + 6 <= len(data):
        t = data[i:i + 4]
        sz = struct.unpack_from('<H', data, i + 4)[0]
        if t == b'XXXX':
            return None
        if t == name:
            return data[i + 6:i + 6 + sz]
        i += 6 + sz
    return None


def main():
    dump = '--dump' in sys.argv
    settings_path = arg('--settings', os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    settings = json.load(open(settings_path, encoding='utf-8'))
    data_dir = arg('--data', settings.get('dataDir') or '')
    load_order = [os.path.basename(p) for p in settings['loadOrder']]
    keywords = settings.get('survivalHeatKeywords', DEFAULT_KEYWORDS)
    extra = settings.get('survivalHeatExtraBases', [])
    if not isinstance(keywords, list) or not all(isinstance(k, str) for k in keywords):
        sys.exit('survivalHeatKeywords must be a list of editor ids')
    if not isinstance(extra, list) or not all(isinstance(k, str) for k in extra):
        sys.exit('survivalHeatExtraBases must be a list of editor ids or descs')
    names = {n.lower(): n for n in load_order}

    edids = {}
    edid_of = {}
    flst = {}
    furn_kw = {}
    types = {}
    refs = {}
    plugins = []
    for plugin in load_order:
        path = os.path.join(data_dir, plugin)
        if not os.path.exists(path):
            print(f'skipped {plugin}: not in {data_dir}', file=sys.stderr)
            continue
        buf = open(path, 'rb').read()
        hflags = struct.unpack_from('<I', buf, 8)[0]
        header = parse_subs(buf[24:24 + struct.unpack_from('<I', buf, 4)[0]])
        masters = [zstr(v).lower() for t, v in header if t == 'MAST']
        own = plugin.lower()
        light = plugin.lower().endswith('.esl') or bool(hflags & LIGHT_PLUGIN)
        plugins.append(own)

        def gkey(fid, masters=masters, own=own, light=light):
            idx = fid >> 24
            if idx < len(masters):
                return (masters[idx], fid & 0xFFFFFF)
            return (own, fid & (0xFFF if light else 0xFFFFFF))

        seen = 0
        for rec in scan(buf, types={'REFR', 'FLST', 'FURN', 'KYWD', 'MSTT', 'LIGH', 'ACTI', 'STAT', 'MISC'}):
            key = gkey(rec.fid)
            if rec.type != 'REFR':
                types[key] = rec.type
                if rec.flags & DELETED:
                    continue
                subs = rec.subs()
                byname = dict(reversed(subs))
                if 'EDID' in byname:
                    edids[zstr(byname['EDID']).lower()] = key
                    edid_of[key] = zstr(byname['EDID'])
                if rec.type == 'FLST':
                    flst[key] = [gkey(struct.unpack('<I', v)[0]) for t, v in subs if t == 'LNAM']
                elif rec.type == 'FURN':
                    kwda = byname.get('KWDA', b'')
                    furn_kw[key] = [gkey(x) for x in struct.unpack(f'<{len(kwda) // 4}I', kwda)]
                continue
            seen += 1
            data = rec.data()
            name = first_sub(data, b'NAME')
            if rec.flags & (DELETED | INITIALLY_DISABLED) or not name:
                refs.pop(key, None)
                continue
            world = None
            cell = None
            for gtype, label in rec.path:
                if gtype == WORLD_CHILDREN:
                    world = gkey(label)
                elif gtype in CELL_CHILDREN:
                    cell = gkey(label)
            pos = first_sub(data, b'DATA')
            if not pos or len(pos) < 12:
                refs.pop(key, None)
                continue
            refs[key] = (gkey(struct.unpack('<I', name)[0]), world, cell, struct.unpack_from('<fff', pos, 0))
        print(f'{plugin}: {seen} reference(s)', file=sys.stderr)

    def proper(key):
        return f'{key[1]:x}:{names.get(key[0], key[0])}'

    bases = {}
    listed = flst.get(edids.get(WARM_UP_LIST.lower()))
    if listed is None:
        sys.exit(f'{WARM_UP_LIST} is not in the load order')
    for b in listed:
        bases[b] = WARM_UP_LIST
    missing = []
    kw_keys = []
    for k in keywords:
        key = edids.get(k.lower())
        if key and types.get(key) == 'KYWD':
            kw_keys.append(key)
        else:
            missing.append(f'keyword {k}')
    for base, kws in furn_kw.items():
        hit = [k for k in kw_keys if k in kws]
        if hit:
            bases.setdefault(base, 'keyword')
    for name in extra:
        if ':' in name:
            fid, plugin = name.split(':', 1)
            key = (plugin.lower(), int(fid, 16))
        else:
            key = edids.get(name.lower())
        if key and key in types:
            bases.setdefault(key, 'extra')
        else:
            missing.append(f'base {name}')
    if missing:
        print(f'not in the load order, ignored: {", ".join(missing)}', file=sys.stderr)

    interiors = {}
    worlds = {}
    per_base = {}
    for base, world, cell, (x, y, z) in refs.values():
        if base not in bases:
            continue
        per_base[base] = per_base.get(base, 0) + 1
        point = [round(x), round(y), round(z)]
        if world:
            grid = f'{int(x // GRID)},{int(y // GRID)}'
            worlds.setdefault(proper(world), {}).setdefault(grid, []).append(point)
        elif cell:
            interiors.setdefault(proper(cell), []).append(point)

    if dump:
        for base, why in sorted(bases.items(), key=lambda kv: proper(kv[0])):
            print(f'{proper(base):28} {types.get(base, "?"):5} {edid_of.get(base, "?"):44} {why:28} {per_base.get(base, 0)}')
        return

    total = sum(per_base.values())
    cells = sum(len(g) for g in worlds.values())

    def points(ps):
        return '[' + ', '.join(f'[{x}, {y}, {z}]' for x, y, z in sorted(ps)) + ']'

    body = (
        '// Generated by misc/gen-heat-sources.py from the REFR, FLST, FURN and KYWD records of the server load order; rerun it instead of editing.\n'
        '// Enabled references whose base is in Survival_WarmUpObjectsList, is named in survivalHeatExtraBases or is furniture with a survivalHeatKeywords keyword.\n'
        'export const HEAT_SOURCE_INPUTS: { keywords: string[]; extraBases: string[]; bases: number; references: number } = '
        f'{{ keywords: {json.dumps(keywords)}, extraBases: {json.dumps(extra)}, bases: {len(bases)}, references: {total} }};\n'
        '// Interior cell desc -> [x, y, z] of each heat source\n'
        'export const HEAT_INTERIORS: Record<string, number[][]> = {\n'
        + '\n'.join(f'  "{c}": {points(ps)},' for c, ps in sorted(interiors.items())) + '\n};\n'
        f'// Worldspace desc -> "x,y" grid cell of {GRID} units -> [x, y, z] of each heat source\n'
        'export const HEAT_WORLDS: Record<string, Record<string, number[][]>> = {\n'
        + '\n'.join(f'  "{w}": {{ ' + ', '.join(f'"{g}": {points(ps)}' for g, ps in sorted(grids.items())) + ' },' for w, grids in sorted(worlds.items())) + '\n};\n'
    )
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    print(f'wrote {total} heat source(s) of {len(bases)} base(s): {sum(len(p) for p in interiors.values())} in {len(interiors)} interior cell(s), '
          f'{total - sum(len(p) for p in interiors.values())} in {cells} grid cell(s) of {len(worlds)} world(s) to {OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
