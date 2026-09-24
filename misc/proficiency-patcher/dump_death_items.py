#!/usr/bin/env python3
# Prints what the live spawn bases drop, the way the server rolls it: each base's NPC_ followed through its template
# chain while Use Traits is set, then the death item list of the record it stops at with its flags, chance none and
# entries, sublists included; then, through the chain while Use Inventory is set, the inventory and outfit the server
# adds when the actor is created. A leveled actor list in a chain is followed for every actor it can pick at level 1.
# Editor ids on the command line (NPC_ or LVLI) are printed the same way, so the lists spec.json names can be checked
# before a run, and --plugin reads a patched copy in place of the Data folder's. --forbid lists every item whose
# editor id contains one of the given strings that a spawn base can still get at level 1, and exits 1 if there is any.
#   python dump_death_items.py [--settings build/dist/server/server-settings.json] [--spawns build/dist/server/NPC-Spawns.json] [--plugin out/AlduinakAdditions.esp] [--forbid Gold001 Ebony] [editor id ...]
import argparse
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from esplib import edid, parse_subs, scan, sub, zstr  # noqa: E402

ESL = 0x200
USE_TRAITS = 0x01
USE_INVENTORY = 0x100
LVLF = {0x01: 'AllLevels', 0x02: 'EachItem', 0x04: 'UseAll', 0x08: 'SpecialLoot'}
# The lists, the actors, the outfits and every record an entry can name
TYPES = {'NPC_', 'LVLN', 'LVLI', 'OTFT', 'GLOB', 'ARMO', 'WEAP', 'AMMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'SLGM', 'KEYM', 'LIGH', 'SCRL'}


def show(key):
    return f'{key[1]:06X}:{key[0]}'


class LoadOrder:
    # Winning records by (owner plugin, local id), full and light plugins slotted like the server's combined space
    def __init__(self, data_dir, names, replace=None):
        self.full, self.light, self.records, self.by_edid = [], [], {}, {}
        for n in names:
            path = replace if replace and os.path.basename(replace).lower() == n.lower() else os.path.join(data_dir, n)
            buf = open(path, 'rb').read()
            flags = struct.unpack_from('<I', buf, 8)[0]
            head = parse_subs(buf[24:24 + struct.unpack_from('<I', buf, 4)[0]])
            masters = [zstr(v).lower() for t, v in head if t == 'MAST']
            (self.light if flags & ESL or n.lower().endswith('.esl') else self.full).append(n.lower())
            for r in scan(buf, TYPES):
                key = self.key(r.fid, masters, n)
                e = edid(r)
                self.records[key] = (n, r.type, e, self.info(r, masters, n))
                if e:
                    self.by_edid[e.lower()] = key

    @staticmethod
    def key(fid, masters, name):
        i = fid >> 24
        return (masters[i] if i < len(masters) else name.lower()), fid & 0xFFFFFF

    def info(self, r, masters, n):
        ref = lambda v: self.key(struct.unpack_from('<I', v)[0], masters, n)  # noqa: E731
        if r.type == 'NPC_':
            acbs, tplt, inam, doft = sub(r, 'ACBS'), sub(r, 'TPLT'), sub(r, 'INAM'), sub(r, 'DOFT')
            return {'tflags': struct.unpack_from('<H', acbs, 18)[0] if acbs else 0,
                    'tplt': ref(tplt) if tplt else None,
                    'inam': ref(inam) if inam else None,
                    'doft': ref(doft) if doft else None,
                    'cnto': [(ref(v), struct.unpack_from('<i', v, 4)[0]) for t, v in r.subs() if t == 'CNTO']}
        if r.type in ('LVLI', 'LVLN'):
            g = sub(r, 'LVLG')
            entries = [(struct.unpack('<I', v[0:4])[0], ref(v[4:8]), struct.unpack('<I', v[8:12])[0])
                       for t, v in r.subs() if t == 'LVLO' and len(v) >= 12]
            return {'chance': (sub(r, 'LVLD') or b'\0')[0], 'flags': (sub(r, 'LVLF') or b'\0')[0],
                    'global': ref(g) if g else None, 'entries': entries}
        if r.type == 'OTFT':
            items = sub(r, 'INAM') or b''
            return {'items': [ref(items[i:i + 4]) for i in range(0, len(items) - 3, 4)]}
        return None

    def resolve(self, text):
        # A base id of NPC-Spawns.json: a form desc "local:Plugin.esp" or a load-order form id, else None
        try:
            if ':' in text:
                local, plugin = text.split(':', 1)
                return plugin.lower(), int(local, 16)
            fid = int(text, 16)
        except ValueError:
            return None
        if fid >> 24 == 0xFE:
            i = (fid >> 12) & 0xFFF
            return (self.light[i] if i < len(self.light) else '?'), fid & 0xFFF
        i = fid >> 24
        return (self.full[i] if i < len(self.full) else '?'), fid & 0xFFFFFF

    def name(self, key):
        r = self.records.get(key)
        return f'{r[2] or "?"} ({show(key)}, winner {r[0]})' if r else f'{show(key)} not in the load order'

    def rolled(self, key):
        # A list the server rolls as always empty gives nothing
        i = self.records[key][3]
        return not i['global'] and i['chance'] < 100

    def picks(self, key, stack=()):
        # The actors a leveled actor list can hand the template chain at level 1
        r = self.records.get(key)
        if not r or r[1] != 'LVLN':
            yield key
            return
        if key in stack or not self.rolled(key):
            return
        for level, ref, _ in r[3]['entries']:
            if level <= 1:
                yield from self.picks(ref, stack + (key,))

    def stops(self, key, flag):
        # (chain, record) per actor the chain can reach: the record the server reads a field off while the flag is set
        found = []

        def walk(k, chain):
            r = self.records.get(k)
            if r and r[1] == 'LVLN':
                for p in self.picks(k):
                    walk(p, chain + [k])
                return
            if not r or r[1] != 'NPC_':
                found.append((chain + [k], None))
                return
            i = r[3]
            if not i['tplt'] or not i['tflags'] & flag:
                found.append((chain + [k], k))
            elif k in chain:
                found.append((chain + [k], None))
            else:
                walk(i['tplt'], chain + [k])
        walk(key, [])
        return found

    def chain_lines(self, chain, stop, what, out):
        if len(chain) > 1:
            out.append(f'  {what} from ' + ' -> '.join(self.name(k) for k in chain[1:]))
        if stop is None:
            last = self.records.get(chain[-1])
            out.append(f'  {self.name(chain[-1])} is {last[1] if last else "missing"}, the server cannot resolve this base')
        return stop is not None

    def npc(self, key, out):
        for chain, stop in self.stops(key, USE_TRAITS):
            if not self.chain_lines(chain, stop, 'traits', out):
                continue
            if not self.records[stop][3]['inam']:
                out.append('  no death item')
            else:
                self.lvli(self.records[stop][3]['inam'], out, 1, [])
        for chain, stop in self.stops(key, USE_INVENTORY):
            if not self.chain_lines(chain, stop, 'inventory', out):
                continue
            i = self.records[stop][3]
            for ref, n in i['cnto']:
                self.entry(ref, n, 1, out, 1, [], 'inventory ')
            if i['doft']:
                out.append(f'  outfit {self.name(i["doft"])}')
                for ref in self.outfit(i['doft']):
                    self.entry(ref, 1, 1, out, 2, [])

    def outfit(self, key):
        r = self.records.get(key)
        return r[3]['items'] if r and r[1] == 'OTFT' else []

    def entry(self, ref, n, level, out, depth, stack, prefix=''):
        e = self.records.get(ref)
        above = ' (above level 1, never rolled)' if level > 1 else ''
        if e and e[1] == 'LVLI':
            self.lvli(ref, out, depth, stack, count=str(n), suffix=above, prefix=prefix)
        else:
            out.append(f'{"  " * depth}{prefix}{n}x {self.name(ref)} {e[1] if e else ""} level {level}{above}')

    def lvli(self, key, out, depth, stack, count=None, suffix='', prefix=''):
        r = self.records.get(key)
        pad = '  ' * depth
        if not r or r[1] != 'LVLI':
            out.append(f'{pad}{self.name(key)} is not a leveled item list')
            return
        i = r[3]
        names = ','.join(v for f, v in LVLF.items() if i['flags'] & f) or '-'
        line = f'{pad}{prefix}{count + "x " if count else ""}{self.name(key)} flags {i["flags"]:#04x} [{names}] chanceNone {i["chance"]}'
        if i['global']:
            line += f' global {self.name(i["global"])} (the server rolls it as always empty)'
        out.append(line + suffix)
        if key in stack:
            out.append(f'{pad}  (already shown above)')
            return
        for level, ref, n in i['entries']:
            self.entry(ref, n, level, out, depth + 1, stack + [key])

    def yields(self, key, stack=()):
        # (item, lists it came through) for every item a list or direct entry can give at level 1
        r = self.records.get(key)
        if not r or r[1] != 'LVLI':
            yield key, ()
            return
        if key in stack or not self.rolled(key):
            return
        for level, ref, _ in r[3]['entries']:
            if level <= 1:
                for item, path in self.yields(ref, stack + (key,)):
                    yield item, (key,) + path

    def sources(self, key):
        # Every death item, inventory entry and outfit item the server can roll for a base
        for _, stop in self.stops(key, USE_TRAITS):
            if stop and self.records[stop][3]['inam']:
                yield 'death item', self.records[stop][3]['inam']
        for _, stop in self.stops(key, USE_INVENTORY):
            if not stop:
                continue
            i = self.records[stop][3]
            for ref, _ in i['cnto']:
                yield f'inventory of {self.records[stop][2]}', ref
            for ref in self.outfit(i['doft']):
                yield f'outfit {self.records[i["doft"]][2]}', ref

    def forbidden(self, key, words):
        hits = set()
        for where, ref in self.sources(key):
            for item, path in self.yields(ref):
                e = (self.records.get(item) or ('', '', ''))[2]
                if any(w.lower() in e.lower() for w in words):
                    hits.add(f'{e} via {where}: ' + ' > '.join(self.records[k][2] or show(k) for k in path))
        return sorted(hits)


def spawn_bases(path):
    # Base id -> zone names, from the file the server reads; keys are matched case-insensitively like the server does
    raw = json.load(open(path, encoding='utf-8'))
    zones = next((v for k, v in raw.items() if k.lower() == 'zones'), []) if isinstance(raw, dict) else raw
    bases = {}
    for z in zones:
        f = {k.lower(): v for k, v in z.items()}
        npc = f.get('npc', [])
        for it in npc if isinstance(npc, list) else [npc]:
            text = str({k.lower(): v for k, v in it.items()}.get('id', '')) if isinstance(it, dict) else str(it).split()[0] if str(it).split() else ''
            if text:
                bases.setdefault(text, []).append(str(f.get('name', '?')))
    return bases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--settings', default=os.path.join(HERE, '..', '..', 'build', 'dist', 'server', 'server-settings.json'))
    ap.add_argument('--spawns', default=os.path.join(HERE, '..', '..', 'build', 'dist', 'server', 'NPC-Spawns.json'))
    ap.add_argument('--plugin', help='a plugin read in place of the Data folder copy of the same name, such as the patcher output')
    ap.add_argument('--forbid', nargs='+', default=[], help='editor id fragments no spawn base may get, such as Gold001 Ebony')
    ap.add_argument('edids', nargs='*', help='NPC_ or LVLI editor ids to print besides the spawn bases')
    a = ap.parse_args()
    s = json.load(open(a.settings, encoding='utf-8'))
    order = LoadOrder(s['dataDir'], [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']], a.plugin)
    out, bad = [], []
    for text, zones in (spawn_bases(a.spawns) if os.path.exists(a.spawns) else {}).items():
        key = order.resolve(text)
        if not key:
            out.append(f'{", ".join(zones)}: {text} is not a form id')
            continue
        out.append(f'{", ".join(zones)}: {text} -> {order.name(key)}')
        order.npc(key, out)
        if a.forbid:
            bad += [f'{order.records[key][2] if key in order.records else text}: {h}' for h in order.forbidden(key, a.forbid)]
    for e in a.edids:
        key = order.by_edid.get(e.lower())
        if not key:
            out.append(f'{e}: not in the load order')
            continue
        t = order.records[key][1]
        out.append(f'{e} -> {order.name(key)} {t}')
        if t == 'NPC_':
            order.npc(key, out)
        elif t == 'LVLI':
            order.lvli(key, out, 1, [])
    if a.forbid:
        out.append(f'forbidden ({", ".join(a.forbid)}): {len(bad)}')
        out += ['  ' + b for b in bad]
    print('\n'.join(out))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
