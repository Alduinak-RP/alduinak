"""Generates the admin panel's map-marker teleports (skymp5-server/ts/systems/adminMapMarkers.ts).

Walks every plugin of the server loadOrder in order, collects the map marker
references (REFR of the MapMarker static 0x10:Skyrim.esm carrying XMRK) and
keeps the last override of each, so a mod that moves or deletes a marker wins
like it does in game. Markers whose TNAM type is in KINDS become teleports at
the marker's worldspace, position and heading (the fast travel arrival spot).
Localized names come from Strings/ or the "Skyrim - Interface.bsa" strings.

Run:  python misc/gen-map-marker-teleports.py            (writes the .ts)
      python misc/gen-map-marker-teleports.py --dump     (every marker of every type, nothing written)
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from esplib import Plugin, Group, parse_subs, zstr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'adminMapMarkers.ts')

MAP_MARKER_BASE = ('skyrim.esm', 0x10)
DELETED = 0x20
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

# TNAM type -> label shown in the panel; everything else is left out
KINDS = {
    1: 'City', 2: 'Town', 3: 'Settlement', 6: 'Fort', 16: 'Imperial Camp', 17: 'Stormcloak Camp', 28: 'Orc Stronghold',
    54: 'Town', 56: 'Settlement',
    **{t: 'City' for t in range(36, 53, 2)},
    **{t: 'Castle' for t in range(35, 52, 2)},
}


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


class Bsa:
    """Uncompressed-entry reader for BSA v104/v105 (strings are stored raw)."""

    def __init__(self, path):
        self.path = path
        self.files = {}
        b = open(path, 'rb').read()
        magic, ver, off, aflags, nfold, nfile, _tfold, tfile = struct.unpack_from('<4sIIIIIII', b, 0)
        if magic != b'BSA\0' or ver not in (104, 105):
            raise ValueError(f'{path}: unsupported archive')
        rec = 24 if ver == 105 else 16
        counts = [struct.unpack_from('<Q I', b, off + i * rec)[1] for i in range(nfold)]
        i = off + nfold * rec
        entries = []
        for c in counts:
            n = b[i]
            folder = b[i + 1:i + n].rstrip(b'\0').decode('latin1')
            i += 1 + n
            for _ in range(c):
                _h, size, pos = struct.unpack_from('<QII', b, i)
                entries.append((folder, size, pos))
                i += 16
        names = b[i:i + tfile].split(b'\0')
        for (folder, size, pos), name in zip(entries, names):
            compressed = bool(aflags & 0x4) != bool(size & 0x40000000)
            self.files[(folder + '\\' + name.decode('latin1')).lower()] = (pos, size & 0x3FFFFFFF, compressed)
        self.buf = b

    def read(self, name):
        hit = self.files.get(name.lower())
        if not hit:
            return None
        pos, size, compressed = hit
        if compressed:
            raise ValueError(f'{self.path}: {name} is compressed')
        return self.buf[pos:pos + size]


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

        for n, parents in p.walk():
            if isinstance(n, Group) or n.type != 'REFR':
                continue
            key = gkey(n.fid)
            known = key in markers
            if not known and not n.compressed and b'XMRK' not in n.raw:
                continue
            if n.flags & DELETED:
                if known:
                    markers.pop(key)
                    moved_by.setdefault(key, []).append(plugin + ' (deleted)')
                continue
            subs = dict(reversed(parse_subs(n.data())))
            if not known and ('XMRK' not in subs or gkey(struct.unpack('<I', subs.get('NAME', b'\0' * 4))[0]) != MAP_MARKER_BASE):
                continue
            world = next((g for g in reversed(parents) if g.gtype == GROUP_WORLD_CHILDREN), None)
            cell = next((g for g in reversed(parents) if g.gtype in GROUP_CELL_GROUPS), None)
            place = gkey(world.label if world else cell.label)
            x, y, z, _rx, _ry, rz = struct.unpack('<6f', subs['DATA'][:24])
            name = ''
            if 'FULL' in subs:
                name = strings.table(plugin).get(struct.unpack('<I', subs['FULL'][:4])[0], '') if localized else zstr(subs['FULL'])
            tnam = subs['TNAM'][0] if 'TNAM' in subs else 0
            entry = {'name': name, 'type': tnam, 'place': place, 'pos': [x, y, z], 'rz': rz, 'plugin': plugin,
                     'flags': subs['FNAM'][0] if 'FNAM' in subs else 0}
            if known:
                prev = markers[key]
                entry['name'] = entry['name'] or prev['name']
                if prev['pos'] != entry['pos'] or prev['place'] != place or prev['rz'] != rz:
                    moved_by.setdefault(key, []).append(plugin)
                entry['origin'] = prev.get('origin', prev['plugin'])
            markers[key] = entry
        print(f'{plugin}: {len(markers)} marker(s) so far', file=sys.stderr)

    for key, who in sorted(moved_by.items()):
        m = markers.get(key)
        print(f'override {desc(key)} {m["name"] if m else ""}: {", ".join(who)}', file=sys.stderr)

    if dump:
        for key, m in sorted(markers.items(), key=lambda kv: (kv[1]['type'], kv[1]['name'])):
            print(f'{m["type"]:2} {TYPES.get(m["type"], "?"):16} fnam {m["flags"]:02x} {m["name"]:40} {desc(key):26} {desc(m["place"]):26} '
                  f'{" ".join(f"{v:.0f}" for v in m["pos"])} {math.degrees(m["rz"]) % 360:.1f} {m["plugin"]}')
        return

    rows = {}
    for key, m in sorted(markers.items()):
        if m['type'] not in KINDS or not m['name']:
            continue
        kind = KINDS[m['type']]
        if (m['name'], kind) in rows:
            print(f'duplicate {kind} {m["name"]} {desc(key)} skipped', file=sys.stderr)
            continue
        place = (names.get(m['place'][0], m['place'][0]), m['place'][1])
        rows[(m['name'], kind)] = (m['name'], kind, desc(place), [num(v) for v in m['pos']], num(math.degrees(m['rz']) % 360), m['plugin'])
    rows = sorted(rows.values(), key=lambda r: (r[0].lower(), r[1]))
    seen = {}
    for r in rows:
        seen[r[0]] = seen.get(r[0], 0) + 1
    lines = []
    for name, kind, place, pos, deg, plugin in rows:
        label = f'{name} ({kind})' if seen[name] > 1 else name
        print(f'{kind:16} {label:40} {place:24} {plugin}', file=sys.stderr)
        lines.append(f'  {{ name: {json.dumps(label)}, kind: "{kind}", cellOrWorldDesc: "{place}", pos: [{pos[0]}, {pos[1]}, {pos[2]}], rot: [0, 0, {deg}] }},')
    groups = {}
    for t, kind in sorted(KINDS.items()):
        groups.setdefault(kind, []).append(str(t))
    kinds = ', '.join(f'{kind} ({"/".join(ts)})' for kind, ts in groups.items())
    body = (
        '// Generated by misc/gen-map-marker-teleports.py from the map markers of the server load order; rerun it instead of editing.\n'
        f'// Marker types included: {kinds}.\n'
        'export const MAP_MARKER_LOCATIONS = [\n' + '\n'.join(lines) + '\n];\n'
    )
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(body)
    print(f'wrote {len(lines)} location(s) to {OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
