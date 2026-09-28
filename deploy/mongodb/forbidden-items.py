#!/usr/bin/env python3
# Lists the items and spells strip-inventories.js removes, as global form ids of the server's load order.
#   python deploy/mongodb/forbidden-items.py [--settings build/dist/server/server-settings.json] [--plugin <staged AlduinakAdditions.esp>] [--out deploy/mongodb/forbidden-items.json]
# --plugin reads that file in place of the Data folder copy of the same name (the staged professions plugin).
import argparse
import hashlib
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, '..', '..')
sys.path.insert(0, os.path.join(REPO, 'misc'))
from esplib import edid, parse_subs, scan, sub, zstr  # noqa: E402

ESL = 0x200
TYPES = {'KYWD', 'ARMO', 'WEAP', 'AMMO', 'BOOK', 'SCRL', 'COBJ', 'SPEL', 'SHOU'}
RANKS = ['Novice', 'Adept', 'Expert', 'Master', 'Legendary']
MAX_RANK = RANKS.index('Adept')
RANK_RE = re.compile(r'^AldProf_[A-Za-z]+_(' + '|'.join(RANKS) + r')$')
HAS_SPELL = 264
# Tempering benches remake nothing, the parking keyword is the patcher's uncraftable bench
NOT_CRAFTING = {'craftingsmithingsharpeningwheel', 'craftingsmithingarmortable', 'mothnest1'}
MATERIAL_RE = re.compile(r'(Weap|Weapon|Armor)Material(Dwarven|Orcish|Elven|Glass|Ebony|Daedric|Dragon|Falmer|Stalhrim|Nordic|Bonemold|Chitin|Scaled)', re.I)
AMMO_RE = re.compile(r'(Dwarven|Dwemer|Orcish|Elven|Glass|Ebony|Daedric|Dragonbone|Falmer|Stalhrim|Nordic|Bonemold|Chitin)', re.I)
JEWELRY = {'clothingring', 'vendoritemjewelry'}
# Mods put cloaks, masks and eyewear on the amulet and circlet slots, so those count only by editor id
JEWELRY_SLOTS = {'clothingnecklace', 'clothingcirclet'}
JEWELRY_RE = re.compile(r'ring|amulet|necklace|circlet|crown|jewel|torc|pendant', re.I)
NOT_JEWELRY_RE = re.compile(r'cloa?ck|cape|mantle|collar|scarf|bandana|eyepatch|goggle|mask|antler|hood', re.I)
# Owner decision: Falmer weapons, helmets and shields stay
FALMER_KEEP_SLOTS = {'armorhelmet', 'armorshield', 'clothinghead'}
# Vanilla Falmer armor carries ArmorMaterialSteel, so its body pieces are found by editor id
FALMER_BODY_SLOTS = {'armorcuirass', 'armorboots', 'armorgauntlets'}
# Named by the owner: forbidden even where an Adept recipe makes them
ALWAYS = {'ebony', 'orcish', 'dwarven', 'falmer'}
STAFF_ANIM = 8
# SPIT types a learned spell is stripped for: spell, power, lesser power, voice; abilities (markers) stay
STRIP_SPELL_TYPES = {0: 'spell', 2: 'power', 3: 'lesser power', 7: 'voice'}


class LoadOrder:
    def __init__(self, data_dir, names, replace=None):
        self.full, self.light, self.recs, self.slot = [], [], {}, {}
        self.files = []
        for n in names:
            path = replace if replace and os.path.basename(replace).lower() == n.lower() else os.path.join(data_dir, n)
            buf = open(path, 'rb').read()
            self.files.append((n, hashlib.sha256(buf).hexdigest()))
            flags = struct.unpack_from('<I', buf, 8)[0]
            head = parse_subs(buf[24:24 + struct.unpack_from('<I', buf, 4)[0]])
            masters = [zstr(v).lower() for t, v in head if t == 'MAST']
            light = bool(flags & ESL) or n.lower().endswith('.esl')
            group = self.light if light else self.full
            self.slot[n.lower()] = (light, len(group))
            group.append(n.lower())
            for r in scan(buf, TYPES):
                key = self.key(r.fid, masters, n)
                self.recs[key] = (r.type, r, masters, n)

    @staticmethod
    def key(fid, masters, name):
        i = fid >> 24
        return (masters[i] if i < len(masters) else name.lower()), fid & 0xFFFFFF

    def ref(self, v, masters, n):
        return self.key(struct.unpack_from('<I', v)[0], masters, n)

    def global_id(self, key):
        slot = self.slot.get(key[0])
        if not slot:
            return None
        light, i = slot
        return (0xFE000000 | (i << 12) | (key[1] & 0xFFF)) if light else ((i << 24) | key[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--settings', default=os.environ.get('ALDUINAK_SERVER_SETTINGS') or os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    ap.add_argument('--plugin')
    ap.add_argument('--out', default=os.path.join(HERE, 'forbidden-items.json'))
    a = ap.parse_args()
    s = json.load(open(a.settings, encoding='utf-8-sig'))
    names = [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']]
    lo = LoadOrder(s['dataDir'], names, a.plugin)

    kw = {}
    for key, (t, r, m, n) in lo.recs.items():
        if t == 'KYWD':
            kw[key] = edid(r)
    ranks, factions = {}, set()
    for key, (t, r, m, n) in lo.recs.items():
        if t == 'SPEL':
            mt = RANK_RE.match(edid(r))
            if mt:
                ranks[key] = RANKS.index(mt.group(1))
            elif edid(r).startswith('AldFaction_'):
                factions.add(key)

    # Lowest rank a recipe of each product needs; -1 is anyone
    best, faction_gear = {}, set()
    for key, (t, r, m, n) in lo.recs.items():
        if t != 'COBJ':
            continue
        subs = r.subs()
        cnam = next((v for x, v in subs if x == 'CNAM'), None)
        bnam = next((v for x, v in subs if x == 'BNAM'), None)
        if not cnam or not bnam or kw.get(lo.ref(bnam, m, n), '').lower() in NOT_CRAFTING:
            continue
        held = [lo.ref(v[12:16], m, n) for x, v in subs if x == 'CTDA' and len(v) >= 16
                and struct.unpack_from('<H', v, 8)[0] == HAS_SPELL and v[0] >> 5 == 0
                and struct.unpack_from('<f', v, 4)[0] == 1.0]
        need = [ranks[k] for k in held if k in ranks]
        rank = min(need) if need else -1
        prod = lo.ref(cnam, m, n)
        if any(k in factions for k in held):
            faction_gear.add(prod)
        best[prod] = min(best.get(prod, 99), rank)

    items, spells = [], []

    def add(key, t, r, reason, extra=None):
        gid = lo.global_id(key)
        if gid is not None:
            row = {'globalId': gid, 'edid': edid(r), 'type': t, 'reason': reason, 'plugin': key[0]}
            items.append({**row, **(extra or {})})

    for key, (t, r, m, n) in sorted(lo.recs.items()):
        if t == 'SCRL':
            add(key, t, r, 'scroll')
            continue
        if t == 'BOOK':
            d = sub(r, 'DATA')
            if d and d[0] & 0x04:
                add(key, t, r, 'spell tome')
            continue
        if t == 'SPEL' or t == 'SHOU':
            spit = sub(r, 'SPIT')
            typ = struct.unpack_from('<I', spit, 8)[0] if t == 'SPEL' and spit and len(spit) >= 12 else (7 if t == 'SHOU' else None)
            gid = lo.global_id(key)
            if typ in STRIP_SPELL_TYPES and gid is not None:
                spells.append({'globalId': gid, 'edid': edid(r), 'type': t, 'kind': STRIP_SPELL_TYPES[typ]})
            continue
        if t not in ('ARMO', 'WEAP', 'AMMO'):
            continue
        kwda = sub(r, 'KWDA') or b''
        kws = {kw.get(lo.ref(kwda[i:i + 4], m, n), '').lower() for i in range(0, len(kwda) - 3, 4)}
        rank = best.get(key)
        craftable = rank is not None and rank <= MAX_RANK
        e = edid(r)
        if t == 'ARMO' and not NOT_JEWELRY_RE.search(e) and (kws & JEWELRY or kws & JEWELRY_SLOTS and JEWELRY_RE.search(e)):
            add(key, t, r, 'jewelry')
        elif sub(r, 'EITM'):
            add(key, t, r, 'enchanted')
        elif t == 'WEAP' and ('weaptypestaff' in kws or (sub(r, 'DNAM') or b'\0')[0] == STAFF_ANIM):
            add(key, t, r, 'staff')
        elif any(MATERIAL_RE.search(k) for k in kws):
            mat = next(MATERIAL_RE.search(k).group(2).lower() for k in kws if MATERIAL_RE.search(k))
            if mat == 'falmer' and (t == 'WEAP' or kws & FALMER_KEEP_SLOTS):
                continue
            if craftable and mat not in ALWAYS:
                continue
            add(key, t, r, 'material', {'material': mat, 'adeptRecipe': craftable})
        elif t == 'ARMO' and 'falmer' in edid(r).lower() and kws & FALMER_BODY_SLOTS:
            add(key, t, r, 'material', {'material': 'falmer', 'adeptRecipe': craftable})
        elif t == 'AMMO' and AMMO_RE.search(edid(r)) and not craftable:
            if re.search('falmer', edid(r), re.I):
                continue
            add(key, t, r, 'material', {'material': AMMO_RE.search(edid(r)).group(1).lower(), 'adeptRecipe': False})
        elif rank is not None and not craftable:
            add(key, t, r, 'rank', {'rank': RANKS[rank], 'factionGear': key in faction_gear})

    out = {
        'loadOrder': names,
        'plugins': [{'name': nm, 'light': lo.slot[nm.lower()][0], 'sha256': h} for nm, h in lo.files],
        'replacedPlugin': os.path.abspath(a.plugin) if a.plugin else None,
        'items': items,
        'spells': spells,
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1)
    counts = {}
    for it in items:
        counts[it['reason']] = counts.get(it['reason'], 0) + 1
    print(f'{len(items)} items ({", ".join(f"{k} {v}" for k, v in sorted(counts.items()))}), {len(spells)} spells -> {a.out}')


if __name__ == '__main__':
    main()
