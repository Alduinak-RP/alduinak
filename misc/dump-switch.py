"""Prints what a placed reference is wired to: a lever that moves nothing or a door that lands wrong.

Walks every plugin of the server loadOrder in order, like gen-map-marker-teleports.py, and keeps the
last override of each record as the game does. For the given ref it prints the base (record type,
editor id, VMAD script names with their properties), the record flags (initially disabled and deleted
refs are never loaded by the server), XAPD, its own XAPR parents, then every REFR whose XAPR names it as
activation parent with the same detail; a child in another cell is marked. With --door it follows the
ref's XTEL to the destination door and prints both halves: destination ref, its cell or worldspace,
position and rotation in degrees.

Run:  python misc/dump-switch.py 5ebd9            (global id of the server load order, hex, 0x optional)
      python misc/dump-switch.py 5ebd9:Skyrim.esm --door
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import json
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from esplib import COMPRESSED, parse_subs, scan, zstr  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DELETED = 0x20
PERSISTENT = 0x400
INITIALLY_DISABLED = 0x800
FLAG_NAMES = ((DELETED, 'deleted'), (INITIALLY_DISABLED, 'initially disabled'), (PERSISTENT, 'persistent'))
GROUP_WORLD_CHILDREN = 1
GROUP_CELL_GROUPS = (6, 8, 9, 10)
XAPD_PARENT_ONLY = 1


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def desc(key, names):
    return f'{key[1]:x}:{names.get(key[0], key[0])}'


def flag_names(flags):
    return ', '.join(n for bit, n in FLAG_NAMES if flags & bit) or 'none'


def degrees(rad):
    return f'{math.degrees(rad) % 360:.1f}'


def parse_ref(text, load_order):
    """(plugin lower, local id) from '5ebd9', '0x5ebd9' or '5ebd9:Plugin.esp'."""
    if ':' in text:
        fid, plugin = text.split(':', 1)
        return (plugin.lower(), int(fid, 16) & 0xFFFFFF)
    fid = int(text, 16)
    idx = fid >> 24
    if idx >= len(load_order):
        sys.exit(f'{text}: load order index {idx:02x} is beyond the {len(load_order)} plugins of loadOrder')
    return (load_order[idx].lower(), fid & 0xFFFFFF)


def vmad_scripts(raw, gkey, names):
    """[(script name, {property: value})]; object properties become record descs, arrays lists."""
    out = []
    pos = [0]

    def take(fmt):
        v = struct.unpack_from(fmt, raw, pos[0])
        pos[0] += struct.calcsize(fmt)
        return v[0]

    def string():
        n = take('<H')
        s = raw[pos[0]:pos[0] + n].decode('latin1')
        pos[0] += n
        return s

    def obj(form):
        fid = struct.unpack_from('<I', raw, pos[0] if form == 1 else pos[0] + 4)[0]
        pos[0] += 8
        return desc(gkey(fid), names)

    try:
        version, form, count = take('<H'), take('<H'), take('<H')
        for _ in range(count):
            name = string()
            if version >= 4:
                take('<B')
            props = {}
            for _ in range(take('<H')):
                prop = string()
                kind = take('<B')
                if version >= 4:
                    take('<B')
                if kind == 1:
                    props[prop] = obj(form)
                elif kind == 2:
                    props[prop] = string()
                elif kind == 3:
                    props[prop] = take('<i')
                elif kind == 4:
                    props[prop] = take('<f')
                elif kind == 5:
                    props[prop] = bool(take('<B'))
                elif 11 <= kind <= 15:
                    items = []
                    for _ in range(take('<I')):
                        if kind == 11:
                            items.append(obj(form))
                        elif kind == 12:
                            items.append(string())
                        elif kind == 13:
                            items.append(take('<i'))
                        elif kind == 14:
                            items.append(take('<f'))
                        else:
                            items.append(bool(take('<B')))
                    props[prop] = items
                else:
                    out.append((name, props))
                    return out
            out.append((name, props))
    except struct.error:
        pass
    return out


def plugins(load_order, data_dir):
    """Yields (plugin, buffer, gkey) per plugin of the load order that exists in the data dir."""
    for plugin in load_order:
        path = os.path.join(data_dir, plugin)
        if not os.path.exists(path):
            print(f'skipped {plugin}: not in {data_dir}', file=sys.stderr)
            continue
        buf = open(path, 'rb').read()
        hsz = struct.unpack_from('<I', buf, 4)[0]
        masters = [zstr(v).lower() for t, v in parse_subs(buf[24:24 + hsz]) if t == 'MAST']
        own = plugin.lower()

        def gkey(fid, masters=masters, own=own):
            idx = fid >> 24
            return (masters[idx] if idx < len(masters) else own, fid & 0xFFFFFF)

        yield plugin, buf, gkey


def ref_info(h, sublist, gkey, names, plugin, prev):
    subs = {}
    for t, v in sublist:
        subs.setdefault(t, v)
    cell = next((label for gtype, label in reversed(h.path) if gtype in GROUP_CELL_GROUPS), None)
    world = next((label for gtype, label in reversed(h.path) if gtype == GROUP_WORLD_CHILDREN), None)
    xtel = struct.unpack_from('<I6f', subs['XTEL']) if 'XTEL' in subs else None
    return {
        'flags': h.flags, 'subs': subs, 'plugins': (prev['plugins'] if prev else []) + [plugin],
        'cell': gkey(cell) if cell is not None else None, 'world': gkey(world) if world is not None else None,
        'base': gkey(struct.unpack_from('<I', subs['NAME'])[0]) if 'NAME' in subs else None,
        'parents': [(gkey(struct.unpack_from('<I', v)[0]), struct.unpack_from('<f', v, 4)[0]) for t, v in sublist if t == 'XAPR'],
        'xtel': {'dest': gkey(xtel[0]), 'pos': xtel[1:4], 'rot': xtel[4:7]} if xtel else None,
        'vmad': vmad_scripts(subs['VMAD'], gkey, names) if 'VMAD' in subs else [],
    }


def main():
    values = {sys.argv.index(o) + 1 for o in ('--settings', '--data') if o in sys.argv}
    args = [a for i, a in enumerate(sys.argv) if i > 0 and i not in values and not a.startswith('--')]
    if len(args) != 1:
        sys.exit(__doc__)
    door = '--door' in sys.argv
    settings_path = arg('--settings', os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    settings = json.load(open(settings_path, encoding='utf-8'))
    data_dir = arg('--data', settings.get('dataDir') or '')
    load_order = [os.path.basename(p) for p in settings['loadOrder']]
    names = {n.lower(): n for n in load_order}
    target = parse_ref(args[0], load_order)

    # Pass 1: the ref, the refs naming it as activation parent, every load door and the cell and worldspace editor ids
    found = None
    children = {}
    doors = {}
    places = {}
    for plugin, buf, gkey in plugins(load_order, data_dir):
        for h in scan(buf, ('REFR', 'CELL', 'WRLD')):
            key = gkey(h.fid)
            if h.type != 'REFR':
                if h.flags & DELETED:
                    places.pop(key, None)
                else:
                    places[key] = zstr(dict(parse_subs(h.data())).get('EDID', b'\0')) or places.get(key, '')
                continue
            known = key == target or key in children or key in doors
            start, end = h.off + 24, h.off + 24 + h.size
            if not known and not h.flags & COMPRESSED and buf.find(b'XAPR', start, end) < 0 and buf.find(b'XTEL', start, end) < 0:
                continue
            prev = found if key == target else children.get(key) or doors.get(key)
            info = ref_info(h, [] if h.flags & DELETED else parse_subs(h.data()), gkey, names, plugin, prev)
            if key == target:
                found = info
            if any(parent == target for parent, _delay in info['parents']):
                children[key] = info
            else:
                children.pop(key, None)
            if info['xtel']:
                doors[key] = info
            else:
                doors.pop(key, None)
        print(f'{plugin}: {len(children)} child(ren), {len(doors)} load door(s) so far', file=sys.stderr)
    if not found:
        sys.exit(f'{desc(target, names)}: no REFR of that id in the load order')

    # Pass 2: the base records of everything printed
    twin = doors.get(found['xtel']['dest']) if door and found['xtel'] else None
    wanted = {r['base'] for r in [found, twin, *children.values()] if r and r['base']}
    bases = {}
    for plugin, buf, gkey in plugins(load_order, data_dir):
        for h in scan(buf):
            if h.type in ('REFR', 'CELL', 'WRLD'):
                continue
            key = gkey(h.fid)
            if key not in wanted:
                continue
            if h.flags & DELETED:
                bases.pop(key, None)
                continue
            subs = dict(parse_subs(h.data()))
            bases[key] = {'type': h.type, 'edid': zstr(subs.get('EDID', b'\0')), 'plugin': plugin,
                          'vmad': vmad_scripts(subs['VMAD'], gkey, names) if 'VMAD' in subs else []}

    def place(r):
        out = f'cell {desc(r["cell"], names)} {places.get(r["cell"], "")}'.rstrip() if r['cell'] else 'no cell'
        return out + (f' in {desc(r["world"], names)} {places.get(r["world"], "")}'.rstrip() if r['world'] else '')

    def show(label, key, r):
        print(f'{label} {desc(key, names)} REFR in {", ".join(r["plugins"])}: {place(r)}')
        print(f'  flags: {flag_names(r["flags"])}')
        b = bases.get(r['base']) if r['base'] else None
        if b:
            print(f'  base {desc(r["base"], names)} {b["type"]} {b["edid"]} in {b["plugin"]}')
            for name, props in b['vmad']:
                print(f'    script {name} {props}')
        else:
            print(f'  base {desc(r["base"], names) if r["base"] else "none"}: no record in the load order')
        if 'DATA' in r['subs']:
            x, y, z, rx, ry, rz = struct.unpack_from('<6f', r['subs']['DATA'])
            print(f'  pos {x:.2f} {y:.2f} {z:.2f} rot {degrees(rx)} {degrees(ry)} {degrees(rz)}')
        if 'XAPD' in r['subs']:
            print(f'  XAPD {r["subs"]["XAPD"][0]:#x}: {"parent activate only" if r["subs"]["XAPD"][0] & XAPD_PARENT_ONLY else "any activation"}')
        for parent, delay in r['parents']:
            print(f'  XAPR parent {desc(parent, names)} delay {delay:g}')
        for name, props in r['vmad']:
            print(f'  script {name} {props}')

    def show_xtel(r):
        x = r['xtel']
        if not x:
            print('  XTEL: none, not a load door')
            return
        far = doors.get(x['dest'])
        print(f'  XTEL -> {desc(x["dest"], names)} {place(far) if far else "(no load door of that id)"}')
        print(f'    arrival pos {x["pos"][0]:.2f} {x["pos"][1]:.2f} {x["pos"][2]:.2f} rot {" ".join(degrees(v) for v in x["rot"])}')

    show('ref', target, found)
    if door:
        show_xtel(found)
        if twin:
            show('twin', found['xtel']['dest'], twin)
            show_xtel(twin)
    print(f'children: {len(children)} REFR with XAPR -> {desc(target, names)}')
    for key, r in sorted(children.items()):
        show('  child', key, r)
        if r['cell'] != found['cell']:
            print('    in another cell than the parent')


if __name__ == '__main__':
    main()
