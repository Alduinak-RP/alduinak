"""Generates the admin panel's map-marker and temple teleports (skymp5-server/ts/systems/adminMapMarkers.ts).

Walks every plugin of the server loadOrder in order, collects the map marker
references (REFR of the MapMarker static 0x10:Skyrim.esm carrying XMRK), the
load doors (REFR carrying XTEL) and the interior cell and worldspace names, and
keeps the last override of each, so a mod that moves or deletes a marker wins
like it does in game. Markers whose TNAM type is in KINDS become teleports at
the marker's worldspace, position and heading (the fast travel arrival spot).
Interior cells named "Temple" become teleports at the arrival point (XTEL) of
the load door leading in from another place; test cells and cells only reached
from test cells are left out. Every entry carries its panel section (GROUPS).
Localized names come from Strings/ or the "Skyrim - Interface.bsa" strings.

Run:  python misc/gen-map-marker-teleports.py            (writes the .ts)
      python misc/gen-map-marker-teleports.py --dump     (every marker of every type, nothing written)
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import json
import math
import os
import re
import struct
import sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bsalib import Bsa  # noqa: E402
from esplib import Plugin, Group, parse_subs, zstr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'adminMapMarkers.ts')

MAP_MARKER_BASE = ('skyrim.esm', 0x10)
DELETED = 0x20
INITIALLY_DISABLED = 0x800
LOCALIZED = 0x80
GROUP_WORLD_CHILDREN = 1
GROUP_CELL_GROUPS = (6, 8, 9, 10)

# TNAM map marker types, checked against the vanilla markers (16/17 are the two civil war camp icons)
TYPES = {
    0: 'None', 1: 'City', 2: 'Town', 3: 'Settlement', 4: 'Cave', 5: 'Camp', 6: 'Fort', 7: 'Nordic Ruins',
    8: 'Dwemer Ruin', 9: 'Shipwreck', 10: 'Grove', 11: 'Landmark', 12: 'Dragon Lair', 13: 'Farm', 14: 'Wood Mill',
    15: 'Mine', 16: 'Imperial Camp', 17: 'Stormcloak Camp', 18: 'Doomstone', 19: 'Wheat Mill', 20: 'Smelter',
    21: 'Stable', 22: 'Imperial Tower', 23: 'Clearing', 24: 'Pass', 25: 'Altar', 26: 'Rock', 27: 'Lighthouse',
    28: 'Orc Stronghold', 29: 'Giant Camp', 30: 'Shack', 31: 'Nordic Tower', 32: 'Nordic Dwelling', 33: 'Docks',
    34: 'Shrine', 35: 'Riften Castle', 36: 'Riften Capitol', 37: 'Windhelm Castle', 38: 'Windhelm Capitol',
    39: 'Whiterun Castle', 40: 'Whiterun Capitol', 41: 'Solitude Castle', 42: 'Solitude Capitol',
    43: 'Markarth Castle', 44: 'Markarth Capitol', 45: 'Winterhold Castle', 46: 'Winterhold Capitol',
    47: 'Morthal Castle', 48: 'Morthal Capitol', 49: 'Falkreath Castle', 50: 'Falkreath Capitol',
    51: 'Dawnstar Castle', 52: 'Dawnstar Capitol', 53: 'Temple of Miraak', 54: 'Raven Rock', 55: 'Beast Stone',
    56: 'Tel Mithryn', 57: 'To Skyrim', 58: 'To Solstheim', 59: 'Castle Karstaag',
}

# TNAM type -> pet home kind: stables keep horses, farms and wheat mills keep livestock (PET_ANCHORS, used by PetSystem)
PET_ANCHOR_KINDS = {13: 'farm', 19: 'farm', 21: 'stable'}

# TNAM type -> label shown in the panel; everything else is left out
KINDS = {
    1: 'City', 2: 'Town', 3: 'Settlement', 6: 'Fort', 16: 'Imperial Camp', 17: 'Stormcloak Camp', 28: 'Orc Stronghold',
    54: 'Town', 56: 'Settlement',
    **{t: 'City' for t in range(36, 53, 2)},
    **{t: 'Castle' for t in range(35, 52, 2)},
}

TEMPLE = 'Temple'

# Kind label -> Teleport tab section; the panel files anything else under Other
GROUPS = {
    'City': 'cities', 'Town': 'villages', 'Settlement': 'villages', 'Orc Stronghold': 'villages',
    'Fort': 'forts', 'Castle': 'forts', 'Imperial Camp': 'forts', 'Stormcloak Camp': 'forts',
    TEMPLE: 'temples',
}

TEST_CELL = re.compile(r'test|^qa|^zz', re.I)


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def parse_strings(raw):
    count, _size = struct.unpack_from('<II', raw, 0)
    base = 8 + count * 8
    out = {}
    for k in range(count):
        sid, off = struct.unpack_from('<II', raw, 8 + k * 8)
        end = raw.index(b'\0', base + off)
        text = raw[base + off:end]
        try:
            out[sid] = text.decode('utf-8')
        except UnicodeDecodeError:
            out[sid] = text.decode('cp1252')
    return out


class Strings:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.bsa = None
        self.cache = {}

    def table(self, plugin):
        key = os.path.splitext(plugin)[0].lower()
        if key not in self.cache:
            name = f'strings\\{key}_english.strings'
            loose = os.path.join(self.data_dir, 'Strings', f'{key}_english.strings')
            if os.path.exists(loose):
                raw = open(loose, 'rb').read()
            else:
                if self.bsa is None:
                    self.bsa = Bsa(os.path.join(self.data_dir, 'Skyrim - Interface.bsa'))
                raw = self.bsa.read(name)
            self.cache[key] = parse_strings(raw) if raw else {}
        return self.cache[key]


def desc(key):
    return f'{key[1]:x}:{key[0]}'


def num(v):
    s = f'{v:.2f}'.rstrip('0').rstrip('.')
    return '0' if s == '-0' else s


def temples(places, doors):
    """(label, cell key, entry door) per temple cell; outdoor, enabled doors win, the entrance names same-named cells apart."""
    best = {}
    for key, door in doors.items():
        far = doors.get(door['dest'])
        cell = places.get(far['place']) if far and not far['exterior'] else None
        src = places.get(door['place'])
        if not cell or not src or TEMPLE.lower() not in cell['name'].lower() or src['name'] == cell['name']:
            continue
        if TEST_CELL.search(cell['edid']) or TEST_CELL.search(src['edid']):
            print(f'test cell skipped: door {desc(key)} {src["edid"]} -> {cell["edid"]}', file=sys.stderr)
            continue
        rank = (not door['exterior'], door['disabled'], key)
        if far['place'] not in best or rank < best[far['place']][0]:
            best[far['place']] = (rank, door, src['name'] or src['edid'])
    kept = {}
    for cell, (_rank, door, src) in sorted(best.items(), key=lambda kv: kv[1][0]):
        where = (places[cell]['name'], src)
        if where in kept:
            print(f'duplicate temple {where[0]} {desc(cell)} skipped: {desc(kept[where][0])} has the same name and is also entered from {src}', file=sys.stderr)
            continue
        kept[where] = (cell, door)
    names = Counter(name for name, _ in kept)
    return [(f'{name} ({src})' if names[name] > 1 else name, cell, door) for (name, src), (cell, door) in kept.items()]


def main():
    dump = '--dump' in sys.argv
    settings_path = arg('--settings', os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    settings = json.load(open(settings_path, encoding='utf-8'))
    data_dir = arg('--data', settings.get('dataDir') or '')
    load_order = [os.path.basename(p) for p in settings['loadOrder']]
    names = {n.lower(): n for n in load_order}
    strings = Strings(data_dir)
    markers = {}
    moved_by = {}
    places = {}
    doors = {}

    for plugin in load_order:
        path = os.path.join(data_dir, plugin)
        if not os.path.exists(path):
            print(f'skipped {plugin}: not in {data_dir}', file=sys.stderr)
            continue
        p = Plugin(path)
        masters = [m.lower() for m in p.masters()]
        own = plugin.lower()
        localized = bool(p.header.flags & LOCALIZED)

        def gkey(fid):
            idx = fid >> 24
            return (masters[idx] if idx < len(masters) else own, fid & 0xFFFFFF)

        def full_name(subs):
            if 'FULL' not in subs:
                return ''
            return strings.table(plugin).get(struct.unpack('<I', subs['FULL'][:4])[0], '') if localized else zstr(subs['FULL'])

        for n, parents in p.walk():
            if isinstance(n, Group):
                continue
            if n.type in ('CELL', 'WRLD'):
                key = gkey(n.fid)
                if n.flags & DELETED:
                    places.pop(key, None)
                    continue
                subs = dict(reversed(parse_subs(n.data())))
                if n.type == 'CELL' and not subs.get('DATA', b'\0')[0] & 1:
                    continue
                places[key] = {'name': full_name(subs) or places.get(key, {}).get('name', ''), 'edid': zstr(subs.get('EDID', b'\0'))}
                continue
            if n.type != 'REFR':
                continue
            key = gkey(n.fid)
            known = key in markers
            if not known and key not in doors and not n.compressed and b'XMRK' not in n.raw and b'XTEL' not in n.raw:
                continue
            if n.flags & DELETED:
                doors.pop(key, None)
                if known:
                    markers.pop(key)
                    moved_by.setdefault(key, []).append(plugin + ' (deleted)')
                continue
            subs = dict(reversed(parse_subs(n.data())))
            world = next((g for g in reversed(parents) if g.gtype == GROUP_WORLD_CHILDREN), None)
            cell = next((g for g in reversed(parents) if g.gtype in GROUP_CELL_GROUPS), None)
            place = gkey(world.label if world else cell.label)
            if 'XTEL' in subs:
                dest, x, y, z, _rx, _ry, rz = struct.unpack_from('<I6f', subs['XTEL'])
                doors[key] = {'place': place, 'exterior': world is not None, 'dest': gkey(dest), 'pos': [x, y, z], 'rz': rz,
                              'disabled': bool(n.flags & INITIALLY_DISABLED), 'plugin': plugin}
            else:
                doors.pop(key, None)
            if not known and ('XMRK' not in subs or gkey(struct.unpack('<I', subs.get('NAME', b'\0' * 4))[0]) != MAP_MARKER_BASE):
                continue
            x, y, z, _rx, _ry, rz = struct.unpack('<6f', subs['DATA'][:24])
            tnam = subs['TNAM'][0] if 'TNAM' in subs else 0
            entry = {'name': full_name(subs), 'type': tnam, 'place': place, 'pos': [x, y, z], 'rz': rz, 'plugin': plugin,
                     'flags': subs['FNAM'][0] if 'FNAM' in subs else 0}
            if known:
                prev = markers[key]
                entry['name'] = entry['name'] or prev['name']
                if prev['pos'] != entry['pos'] or prev['place'] != place or prev['rz'] != rz:
                    moved_by.setdefault(key, []).append(plugin)
                entry['origin'] = prev.get('origin', prev['plugin'])
            markers[key] = entry
        print(f'{plugin}: {len(markers)} marker(s), {len(doors)} load door(s) so far', file=sys.stderr)

    for key, who in sorted(moved_by.items()):
        m = markers.get(key)
        print(f'override {desc(key)} {m["name"] if m else ""}: {", ".join(who)}', file=sys.stderr)

    if dump:
        for key, m in sorted(markers.items(), key=lambda kv: (kv[1]['type'], kv[1]['name'])):
            print(f'{m["type"]:2} {TYPES.get(m["type"], "?"):16} fnam {m["flags"]:02x} {m["name"]:40} {desc(key):26} {desc(m["place"]):26} '
                  f'{" ".join(f"{v:.0f}" for v in m["pos"])} {math.degrees(m["rz"]) % 360:.1f} {m["plugin"]}')
        return

    def proper(key):
        return desc((names.get(key[0], key[0]), key[1]))

    rows = {}
    for key, m in sorted(markers.items()):
        if m['type'] not in KINDS or not m['name']:
            continue
        kind = KINDS[m['type']]
        if (m['name'], kind) in rows:
            print(f'duplicate {kind} {m["name"]} {desc(key)} skipped', file=sys.stderr)
            continue
        rows[(m['name'], kind)] = (m['name'], kind, proper(m['place']), [num(v) for v in m['pos']], num(math.degrees(m['rz']) % 360), m['plugin'])
    for label, cell, door in temples(places, doors):
        rows[(label, TEMPLE)] = (label, TEMPLE, proper(cell), [num(v) for v in door['pos']], num(math.degrees(door['rz']) % 360), door['plugin'])
        print(f'temple {label:40} {places[cell]["edid"]:32} {proper(cell):26} via door {proper(door["dest"])} <- {desc(door["place"])}', file=sys.stderr)
    rows = sorted(rows.values(), key=lambda r: (r[0].lower(), r[1]))
    seen = {}
    for r in rows:
        seen[r[0]] = seen.get(r[0], 0) + 1
    lines = []
    for name, kind, place, pos, deg, plugin in rows:
        label = f'{name} ({kind})' if seen[name] > 1 else name
        print(f'{kind:16} {label:40} {place:24} {plugin}', file=sys.stderr)
        lines.append(f'  {{ name: {json.dumps(label)}, kind: "{kind}", group: "{GROUPS[kind]}", cellOrWorldDesc: "{place}", '
                     f'pos: [{pos[0]}, {pos[1]}, {pos[2]}], rot: [0, 0, {deg}] }},')
    anchors = []
    for key, m in sorted(markers.items(), key=lambda kv: (kv[1]['name'].lower(), kv[0])):
        if m['type'] not in PET_ANCHOR_KINDS or not m['name']:
            continue
        anchors.append(f'  {{ name: {json.dumps(m["name"])}, kind: "{PET_ANCHOR_KINDS[m["type"]]}", cellOrWorldDesc: "{proper(m["place"])}", '
                       f'pos: [{", ".join(num(v) for v in m["pos"])}] }},')
    kinds = {}
    for t, kind in sorted(KINDS.items()):
        kinds.setdefault(kind, []).append(str(t))
    body = (
        '// Generated by misc/gen-map-marker-teleports.py from the map markers, load doors and cells of the server load order; rerun it instead of editing.\n'
        f'// Marker types included: {", ".join(f"{kind} ({chr(47).join(ts)})" for kind, ts in kinds.items())}.\n'
        '// Temples: interior cells named "Temple", at the arrival point of the load door leading in.\n'
        'export const MAP_MARKER_LOCATIONS = [\n' + '\n'.join(lines) + '\n];\n'
        '// Pet homes: Stable (21) markers keep horses, Farm (13) and Wheat Mill (19) markers keep livestock; PetSystem stores a pet within petAnchorRadius of one.\n'
        'export const PET_ANCHORS = [\n' + '\n'.join(anchors) + '\n];\n'
    )
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    print(f'wrote {len(lines)} location(s) and {len(anchors)} pet anchor(s) to {OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
