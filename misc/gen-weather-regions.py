"""Generates the server's weather regions and weather catalog (skymp5-server/ts/systems/weatherRegions.ts).

Walks every plugin of the server loadOrder in order and keeps the last override
of each REGN, WTHR and WRLD record, so a mod that reshapes a region or retunes a
weather wins like it does in game. A region counts when it names a worldspace
and carries a weather list (an RDAT of type 3 followed by RDWT entries); worlds
in WORLD_DENYLIST (quest realms whose weather is scripted) are left out, and a
region without polygons is left out when its world also has polygon regions
(the game only falls back to it outside every polygon). Regions are ordered by
weather priority, highest first, so the server's point-in-polygon lookup picks
the one the game would. A child worldspace that shares its parent's terrain
(WRLD PNAM "Use Land Data") or holds a City map marker (adminMapMarkers.ts),
which is every walled city and the Dragonsreach porch, drops its own regions
and is folded into the parent region around it (the marker, or the centroid
of its own polygons), so a player inside the walls keeps the weather of the
land outside the gate. The catalog lists every weather of the load order with
its classification, so the admin tab can offer them without a plugin scan.

Run:  python misc/gen-weather-regions.py                (writes the .ts)
      python misc/gen-weather-regions.py --dump         (every region, its priority, polygons and weathers; nothing written)
      python misc/gen-weather-regions.py --json <file>  (also writes the regions as JSON, the shape build/dist/server/weather-regions.json takes)
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import json
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from esplib import parse_subs, scan, zstr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'weatherRegions.ts')
MARKERS = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'adminMapMarkers.ts')

DELETED = 0x20
RDAT_WEATHER = 3
# WTHR DATA byte 11: classification flags
KINDS = {1: 'pleasant', 2: 'cloudy', 4: 'rainy', 8: 'snow'}

# WRLD PNAM flag: the child world uses its parent's terrain, so its coordinates are the parent's
USE_LAND_DATA = 0x1

# Worldspace editor ids whose sky is scripted by their quests (the realms, Apocrypha, Skuldafn) or that is no place to stand (the FX light world)
WORLD_DENYLIST = {'Sovngarde', 'DLC01SoulCairn', 'DLC2ApocryphaWorld', 'SkuldafnWorld', 'FXLightWorldSpace'}

# Region editor id (minus a DLC or Weather prefix) -> panel name, for the ones a camel-case split reads badly
NAMES = {
    'FFRiften': 'Riften', 'HighHrothgar': 'High Hrothgar', 'ThroatOfTheWorld': 'Throat of the World', 'VampCastleStorm': 'Castle Volkihar',
    'CoastFog': 'Coast (fog)', 'DA02': 'Sacellum of Boethiah', 'SolstheimMtns': 'Solstheim Mountains', 'FVBoss': 'Forgotten Vale (inner sanctum)',
    'Grove': 'Forgotten Vale Grove', 'Playground': 'Forgotten Vale', 'Ice': 'Forgotten Vale (glacier)', 'Canyon': 'Forgotten Vale Canyon',
}


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def desc(key):
    return f'{key[1]:x}:{key[0]}'


def region_id(edid):
    """Editor id minus the Weather prefix, lower camel: WeatherFFRiften -> ffRiften, DLC01WeatherIce -> dlc01Ice."""
    s = re.sub(r'^(DLC\d+)?Weather(?=[A-Z])', r'\1', edid) or edid
    run = re.match(r'^[A-Z0-9]+', s)
    n = len(run.group(0)) if run else 0
    if 1 < n < len(s):
        n -= 1
    return s[:n].lower() + s[n:]


def region_name(edid):
    s = re.sub(r'^(DLC\d+)?Weather(?=[A-Z])', '', edid) or edid
    s = re.sub(r'^DLC\d+(?=[A-Z])', '', s) or s
    if s in NAMES:
        return NAMES[s]
    s = re.sub(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=\d)', ' ', s).strip()
    return re.sub(r'^(.+) No Precip$', r'\1 (no rain)', s)


def inside(poly, x, y):
    n = len(poly)
    j = n - 1
    res = False
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            res = not res
        j = i
    return res


def city_markers():
    """world key -> (name, x, y) of the City markers of adminMapMarkers.ts, the fold point of a city world."""
    try:
        src = open(MARKERS, encoding='utf-8').read()
    except OSError:
        return {}
    out = {}
    for m in re.finditer(r'name: "([^"]+)", kind: "City", group: "[^"]*", cellOrWorldDesc: "([0-9a-f]+):([^"]+)", pos: \[([^\]]+)\]', src):
        name, fid, plugin, pos = m.group(1), int(m.group(2), 16), m.group(3), [float(v) for v in m.group(4).split(',')]
        out.setdefault((plugin.lower(), fid), (name, pos[0], pos[1]))
    return out


def centroid(polys):
    pts = [p for poly in polys for p in poly]
    return sum(x for x, _y in pts) / len(pts), sum(y for _x, y in pts) / len(pts)


def main():
    dump = '--dump' in sys.argv
    settings_path = arg('--settings', os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    settings = json.load(open(settings_path, encoding='utf-8'))
    data_dir = arg('--data', settings.get('dataDir') or '')
    load_order = [os.path.basename(p) for p in settings['loadOrder']]
    names = {n.lower(): n for n in load_order}
    worlds = {}
    weathers = {}
    regions = {}

    for plugin in load_order:
        path = os.path.join(data_dir, plugin)
        if not os.path.exists(path):
            print(f'skipped {plugin}: not in {data_dir}', file=sys.stderr)
            continue
        buf = open(path, 'rb').read()
        header = parse_subs(buf[24:24 + struct.unpack_from('<I', buf, 4)[0]])
        masters = [zstr(v).lower() for t, v in header if t == 'MAST']
        own = plugin.lower()

        def gkey(fid):
            idx = fid >> 24
            return (masters[idx] if idx < len(masters) else own, fid & 0xFFFFFF)

        seen = 0
        for rec in scan(buf, types={'REGN', 'WTHR', 'WRLD'}):
            key = gkey(rec.fid)
            table = {'REGN': regions, 'WTHR': weathers, 'WRLD': worlds}[rec.type]
            if rec.flags & DELETED:
                table.pop(key, None)
                continue
            subs = rec.subs()
            byname = dict(reversed(subs))
            edid = zstr(byname['EDID']) if 'EDID' in byname else table.get(key, {}).get('edid', '')
            seen += 1
            if rec.type == 'WRLD':
                prev = worlds.get(key, {})
                worlds[key] = {
                    'edid': edid,
                    'parent': gkey(struct.unpack('<I', byname['WNAM'])[0]) if 'WNAM' in byname else prev.get('parent'),
                    'pnam': struct.unpack_from('<H', byname['PNAM'])[0] if 'PNAM' in byname else prev.get('pnam', 0),
                }
                continue
            if rec.type == 'WTHR':
                data = byname.get('DATA', b'')
                weathers[key] = {'edid': edid, 'kind': KINDS.get(data[11] & 0xF, 'unknown') if len(data) > 11 else 'unknown', 'plugin': plugin}
                continue
            world = gkey(struct.unpack('<I', byname['WNAM'])[0]) if 'WNAM' in byname else None
            entries, polys, prio, current = [], [], 0, None
            for t, v in subs:
                if t == 'RDAT':
                    current, _flags, p = struct.unpack_from('<IBB', v, 0)
                    if current == RDAT_WEATHER:
                        prio = p
                elif t == 'RDWT' and current == RDAT_WEATHER:
                    entries = [(gkey(w), chance) for w, chance, _g in (struct.unpack_from('<IIi', v, i * 12) for i in range(len(v) // 12))]
                elif t == 'RPLD':
                    polys.append([struct.unpack_from('<ff', v, i * 8) for i in range(len(v) // 8)])
            regions[key] = {'edid': edid, 'world': world, 'prio': prio, 'weathers': entries, 'polys': polys, 'plugin': plugin}
        print(f'{plugin}: {seen} record(s)', file=sys.stderr)

    def wname(key):
        return worlds.get(key, {}).get('edid', '') or desc(key)

    kept = {}
    for key, r in regions.items():
        if not r['world'] or not r['weathers']:
            continue
        if wname(r['world']) in WORLD_DENYLIST:
            print(f'denylisted world: {r["edid"]} in {wname(r["world"])}', file=sys.stderr)
            continue
        entries = [(w, c) for w, c in r['weathers'] if w in weathers and c > 0]
        missing = [desc(w) for w, c in r['weathers'] if w not in weathers]
        if missing:
            print(f'{r["edid"]}: unknown weather(s) {", ".join(missing)} dropped', file=sys.stderr)
        if entries:
            kept[key] = dict(r, weathers=entries)
    poly_worlds = {r['world'] for r in kept.values() if r['polys']}
    for key in list(kept):
        r = kept[key]
        if not r['polys'] and r['world'] in poly_worlds:
            print(f'no polygon: {r["edid"]} skipped, {wname(r["world"])} has polygon regions', file=sys.stderr)
            del kept[key]
    ordered = sorted(kept.items(), key=lambda kv: (-kv[1]['prio'], kv[0]))

    def proper(key):
        return desc((names.get(key[0], key[0]), key[1]))

    if dump:
        for key, r in ordered:
            w = worlds.get(r['world'], {})
            print(f'{proper(key):26} {r["edid"]:30} {wname(r["world"]):22} parent {wname(w["parent"]) if w.get("parent") else "-":10} pnam {w.get("pnam", 0):#06x} '
                  f'prio {r["prio"]:3} polys {len(r["polys"])} pts {sum(len(p) for p in r["polys"])} {r["plugin"]}')
            for wk, c in r['weathers']:
                print(f'    {weathers[wk]["edid"]:34} {c:3}% {weathers[wk]["kind"]}')
        return

    # A child world on its parent's terrain (or a walled city) takes the parent region around its fold point instead of its own regions
    markers = city_markers()
    folded = {}
    for world in sorted({r['world'] for _k, r in ordered}):
        parent = worlds.get(world, {}).get('parent')
        if not parent or parent == world or (not worlds[world]['pnam'] & USE_LAND_DATA and world not in markers):
            continue
        own = [(k, r) for k, r in ordered if r['world'] == world]
        label, x, y = markers.get(world) or (wname(world), *centroid([p for _k, r in own for p in r['polys']]))
        for key, r in ordered:
            if r['world'] == parent and any(inside(p, x, y) for p in r['polys']):
                folded.setdefault(key, []).append(world)
                ordered = [(k, r) for k, r in ordered if r['world'] != world]
                print(f'folded {label:14} {proper(world):18} -> {r["edid"]}, dropping {", ".join(r["edid"] for _k, r in own)}', file=sys.stderr)
                break
        else:
            print(f'{label} ({proper(world)}): no {wname(parent)} region contains ({x:.0f}, {y:.0f}), keeps its own regions', file=sys.stderr)
    ids = {}
    for key, r in ordered:
        rid = region_id(r['edid'])
        if rid in ids.values():
            print(f'duplicate id {rid}: {r["edid"]} gets its form id appended', file=sys.stderr)
            rid = f'{rid}_{key[1]:x}'
        ids[key] = rid

    rows = []
    for key, r in ordered:
        areas = [{'world': proper(r['world']), 'poly': [[round(x), round(y)] for x, y in p]} for p in r['polys']] or [{'world': proper(r['world'])}]
        areas += [{'world': proper(w)} for w in folded.get(key, [])]
        rows.append({
            'id': ids[key], 'name': region_name(r['edid']), 'edid': r['edid'], 'priority': r['prio'], 'areas': areas,
            'weathers': [{'desc': proper(w), 'edid': weathers[w]['edid'], 'chance': c} for w, c in r['weathers']],
        })
    catalog = [{'desc': proper(k), 'edid': w['edid'], 'kind': w['kind']} for k, w in sorted(weathers.items(), key=lambda kv: kv[1]['edid'].lower()) if w['edid']]

    if '--json' in sys.argv:
        out = arg('--json', '')
        with open(out, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(rows, f, indent=1)
        print(f'wrote {len(rows)} region(s) to {out}', file=sys.stderr)

    def ts_region(r):
        areas = ', '.join('{ world: "%s"%s }' % (a['world'], ', poly: [%s]' % ', '.join(f'[{x}, {y}]' for x, y in a['poly']) if 'poly' in a else '') for a in r['areas'])
        ws = ', '.join('{ desc: "%s", edid: "%s", chance: %d }' % (w['desc'], w['edid'], w['chance']) for w in r['weathers'])
        return f'  {{ id: "{r["id"]}", name: {json.dumps(r["name"])}, edid: "{r["edid"]}", priority: {r["priority"]}, areas: [{areas}], weathers: [{ws}] }},'

    body = (
        '// Generated by misc/gen-weather-regions.py from the REGN, WTHR and WRLD records of the server load order; rerun it instead of editing.\n'
        '// Regions in lookup order (weather priority, highest first). An area without poly covers its whole world; poly points are [x, y] in world units.\n'
        'export interface WeatherArea { world: string; poly?: number[][] }\n'
        'export interface WeatherChance { desc: string; edid: string; chance: number }\n'
        'export interface WeatherRegionDef { id: string; name: string; edid: string; priority: number; areas: WeatherArea[]; weathers: WeatherChance[] }\n'
        'export interface WeatherCatalogEntry { desc: string; edid: string; kind: string }\n'
        'export const WEATHER_REGIONS: WeatherRegionDef[] = [\n' + '\n'.join(ts_region(r) for r in rows) + '\n];\n'
        '// Every WTHR of the load order; kind is the record classification (pleasant, cloudy, rainy, snow)\n'
        'export const WEATHER_CATALOG: WeatherCatalogEntry[] = [\n'
        + '\n'.join('  { desc: "%s", edid: "%s", kind: "%s" },' % (c['desc'], c['edid'], c['kind']) for c in catalog) + '\n];\n'
    )
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    by_world = {}
    for r in rows:
        for a in r['areas']:
            by_world[a['world']] = by_world.get(a['world'], 0) + 1
    print(f'wrote {len(rows)} region(s) over {len(by_world)} world(s) and {len(catalog)} catalog weather(s) to {OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
