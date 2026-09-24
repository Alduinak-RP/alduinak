#!/usr/bin/env python3
# Prints what the live spawn bases drop, the way the server rolls it: each base's NPC_ followed through its template
# chain while Use Traits is set, then the death item list of the record it stops at with its flags, chance none and
# entries, sublists included. Editor ids on the command line (NPC_ or LVLI) are printed the same way, so the lists
# spec.json names can be checked before a run, and --plugin reads a patched copy in place of the Data folder's.
#   python dump_death_items.py [--settings build/dist/server/server-settings.json] [--spawns build/dist/server/NPC-Spawns.json] [--plugin out/AlduinakAdditions.esp] [editor id ...]
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
LVLF = {0x01: 'AllLevels', 0x02: 'EachItem', 0x04: 'UseAll', 0x08: 'SpecialLoot'}
# The lists, the actors and every record an entry can name
TYPES = {'NPC_', 'LVLN', 'LVLI', 'GLOB', 'ARMO', 'WEAP', 'AMMO', 'MISC', 'INGR', 'ALCH', 'BOOK', 'SLGM', 'KEYM', 'LIGH', 'SCRL'}


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
        if r.type == 'NPC_':
            acbs, tplt, inam = sub(r, 'ACBS'), sub(r, 'TPLT'), sub(r, 'INAM')
            return {'traits': bool(acbs) and bool(struct.unpack_from('<H', acbs, 18)[0] & USE_TRAITS),
                    'tplt': self.key(struct.unpack('<I', tplt)[0], masters, n) if tplt else None,
                    'inam': self.key(struct.unpack('<I', inam)[0], masters, n) if inam else None}
        if r.type == 'LVLI':
            g = sub(r, 'LVLG')
            entries = [(struct.unpack('<I', v[0:4])[0], self.key(struct.unpack('<I', v[4:8])[0], masters, n), struct.unpack('<I', v[8:12])[0])
                       for t, v in r.subs() if t == 'LVLO' and len(v) >= 12]
            return {'chance': (sub(r, 'LVLD') or b'\0')[0], 'flags': (sub(r, 'LVLF') or b'\0')[0],
                    'global': self.key(struct.unpack('<I', g)[0], masters, n) if g else None, 'entries': entries}
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

    def npc(self, key, out):
        # The record the server reads the death item off: the first of the chain without Use Traits or a template
        chain = [key]
        while True:
            r = self.records.get(key)
            if not r or r[1] != 'NPC_':
                out.append(f'  {self.name(key)} is {r[1] if r else "missing"}, the server cannot resolve this base')
                return
            i = r[3]
            if not i['tplt'] or not i['traits']:
                break
            key = i['tplt']
            if key in chain:
                out.append(f'  template chain loops at {self.name(key)}')
                return
            chain.append(key)
        if len(chain) > 1:
            out.append('  traits from ' + ' -> '.join(self.name(k) for k in chain[1:]))
        if not self.records[key][3]['inam']:
            out.append('  no death item')
        else:
            self.lvli(self.records[key][3]['inam'], out, 1, [])

    def lvli(self, key, out, depth, stack, count=None):
        r = self.records.get(key)
        pad = '  ' * depth
        if not r or r[1] != 'LVLI':
            out.append(f'{pad}{self.name(key)} is not a leveled item list')
            return
        i = r[3]
        names = ','.join(v for f, v in LVLF.items() if i['flags'] & f) or '-'
        line = f'{pad}{count + "x " if count else ""}{self.name(key)} flags {i["flags"]:#04x} [{names}] chanceNone {i["chance"]}'
        if i['global']:
            line += f' global {self.name(i["global"])} (the server rolls it as always empty)'
        out.append(line)
        if key in stack:
            out.append(f'{pad}  (already shown above)')
            return
        for level, ref, n in i['entries']:
            e = self.records.get(ref)
            above = ' (above level 1, never rolled)' if level > 1 else ''
            if e and e[1] == 'LVLI':
                self.lvli(ref, out, depth + 1, stack + [key], count=str(n))
                if above:
                    out[-1] += above
            else:
                out.append(f'{pad}  {n}x {self.name(ref)} {e[1] if e else ""} level {level}{above}')


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
    ap.add_argument('edids', nargs='*', help='NPC_ or LVLI editor ids to print besides the spawn bases')
    a = ap.parse_args()
    s = json.load(open(a.settings, encoding='utf-8'))
    order = LoadOrder(s['dataDir'], [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']], a.plugin)
    out = []
    for text, zones in (spawn_bases(a.spawns) if os.path.exists(a.spawns) else {}).items():
        key = order.resolve(text)
        if not key:
            out.append(f'{", ".join(zones)}: {text} is not a form id')
            continue
        out.append(f'{", ".join(zones)}: {text} -> {order.name(key)}')
        order.npc(key, out)
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
    print('\n'.join(out))


if __name__ == '__main__':
    main()
