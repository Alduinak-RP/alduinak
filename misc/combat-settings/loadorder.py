"""Read-only reader of the winning WEAP, ARMO, AMMO, COBJ, KYWD, RACE and ingredient records of a server loadOrder.

Records are keyed by (defining plugin, local id) like libespm; the last plugin of the load order that holds a record
wins, and form ids inside a record resolve against that plugin's own masters. Names come from the plugin's strings
tables (loose, the plugin's own BSA, then Skyrim - Interface.bsa). Returns plain dicts in the shape of the
2026-09-29 combat research dump (items/*.json), so the classifier runs on either.
"""
import json
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from fastesp import Rec, subs_of  # noqa: E402
from bsalib import Bsa  # noqa: E402

TYPES = {'WEAP', 'ARMO', 'AMMO', 'COBJ', 'KYWD', 'RACE', 'SPEL', 'MISC', 'INGR', 'ALCH', 'SLGM', 'LIGH', 'BOOK'}
ANIM = {0: 'HandToHand', 1: 'OneHandSword', 2: 'OneHandDagger', 3: 'OneHandAxe', 4: 'OneHandMace',
        5: 'TwoHandSword', 6: 'TwoHandAxe', 7: 'Bow', 8: 'Staff', 9: 'Crossbow'}
BIPED = {0: 'Head', 1: 'Hair', 2: 'Body', 3: 'Hands', 4: 'Forearms', 5: 'Amulet', 6: 'Ring', 7: 'Feet', 8: 'Calves',
         9: 'Shield', 10: 'Tail', 11: 'LongHair', 12: 'Circlet', 13: 'Ears'}
HAS_SPELL = 264
RACE_UNARMED_DAMAGE = 96


def read_bytes(path, limit=-1):
    with open(path, 'rb') as f:
        return f.read(limit)


def load_plugin(path):
    """fastesp.load for the wanted top groups only (cells and worlds are skipped)."""
    buf = read_bytes(path)
    hsz, hflags = struct.unpack_from('<II', buf, 4)
    masters = [v.split(b'\0')[0].decode('latin1') for t, v in subs_of(buf[24:24 + hsz]) if t == 'MAST']
    recs = []
    i = 24 + hsz
    while i < len(buf):
        sz = struct.unpack_from('<I', buf, i + 4)[0]
        end = i + sz
        if buf[i:i + 4] != b'GRUP' or buf[i + 8:i + 12].decode('latin1') not in TYPES:
            i = end
            continue
        j = i + 24
        while j < end:
            szj = struct.unpack_from('<I', buf, j + 4)[0]
            if buf[j:j + 4] == b'GRUP':
                j += 24
                continue
            tn = buf[j:j + 4].decode('latin1')
            fl, fid = struct.unpack_from('<II', buf, j + 8)
            recs.append(Rec(buf, tn, fid, fl, j, szj, ()))
            j += 24 + szj
        i = end
    return dict(masters=masters, recs=recs, hflags=hflags, name=os.path.basename(path))


def parse_strings(raw):
    count = struct.unpack_from('<I', raw, 0)[0]
    base = 8 + count * 8
    out = {}
    for k in range(count):
        sid, off = struct.unpack_from('<II', raw, 8 + k * 8)
        text = raw[base + off:raw.index(b'\0', base + off)]
        try:
            out[sid] = text.decode('utf-8')
        except UnicodeDecodeError:
            out[sid] = text.decode('cp1252')
    return out


class Strings:
    def __init__(self, data_dir):
        self.data_dir, self.bsas, self.cache = data_dir, {}, {}

    def _bsa(self, name):
        if name not in self.bsas:
            p = os.path.join(self.data_dir, name)
            self.bsas[name] = Bsa(p) if os.path.exists(p) else None
        return self.bsas[name]

    def table(self, plugin):
        key = os.path.splitext(plugin)[0].lower()
        if key not in self.cache:
            name = f'strings\\{key}_english.strings'
            loose = os.path.join(self.data_dir, 'Strings', f'{key}_english.strings')
            raw = read_bytes(loose) if os.path.exists(loose) else None
            for b in (os.path.splitext(plugin)[0] + '.bsa', 'Skyrim - Interface.bsa'):
                if raw:
                    break
                a = self._bsa(b)
                raw = a.read(name) if a else None
            self.cache[key] = parse_strings(raw) if raw else {}
        return self.cache[key]


def read_load_order(settings_path):
    """Only loadOrder is read from the settings file; nothing else in it is touched or printed."""
    with open(settings_path, encoding='utf-8') as f:
        return json.load(f)['loadOrder']


def zstr(b):
    return b.split(b'\0')[0].decode('utf-8', 'replace') if b else ''


class LoadOrder:
    def __init__(self, load_order, substitute=None, data_dir=None, log=print):
        """substitute: {plugin file name: path} read in place of the load order's copy (a staged plugin)."""
        substitute = {k.lower(): v for k, v in (substitute or {}).items()}
        self.paths = [substitute.get(os.path.basename(p).lower(), p) for p in load_order]
        self.names = [os.path.basename(p) for p in load_order]
        self.lower = {n.lower(): i for i, n in enumerate(self.names)}
        self.data_dir = data_dir or os.path.dirname(load_order[0])
        self.strings = Strings(self.data_dir)
        self.plugins = []
        self.slots = []
        nf = nl = 0
        for p in self.paths:
            pl = load_plugin(p)
            light = bool(pl['hflags'] & 0x200)
            self.slots.append((light, nl if light else nf))
            nl, nf = (nl + 1, nf) if light else (nl, nf + 1)
            self.plugins.append(pl)
        self.win, self.hist = {}, {}
        for pi, pl in enumerate(self.plugins):
            masters = [m.lower() for m in pl['masters']]
            own = pl['name'].lower()
            for r in pl['recs']:
                hi = r.fid >> 24
                key = (masters[hi] if hi < len(masters) else own, r.fid & 0xFFFFFF)
                self.win[key] = (r, pi)
                self.hist.setdefault(key, []).append(pi)
        self.by_type = {}
        for key, (r, pi) in self.win.items():
            self.by_type.setdefault(r.type, []).append((key, r, pi))
        self.edid_key = {}
        for key, (r, pi) in self.win.items():
            self.edid_key.setdefault((r.type, r.edid()), key)
        log(f'[combat-settings] read {len(self.plugins)} plugins, {len(self.win)} records of {len(TYPES)} types')

    def plugin_name(self, key):
        i = self.lower.get(key[0])
        return self.names[i] if i is not None else key[0]

    def desc(self, key):
        """The server's FormDesc ("<hex>:<plugin>", FormDesc::FromString and ToFormId)."""
        return f'{key[1]:x}:{self.plugin_name(key)}'

    def form_key(self, key):
        """The patcher's Mutagen FormKey ("XXXXXX:<plugin>", as in spec.json)."""
        return f'{key[1]:06X}:{self.plugin_name(key)}'

    def runtime_id(self, key):
        i = self.lower.get(key[0])
        if i is None:
            return None
        light, s = self.slots[i]
        return (0xFE000000 | (s << 12) | (key[1] & 0xFFF)) if light else ((s << 24) | key[1])

    def resolver(self, pi):
        masters = [m.lower() for m in self.plugins[pi]['masters']]
        own = self.plugins[pi]['name'].lower()

        def gkey(fid):
            if not fid:
                return None
            hi = fid >> 24
            return (masters[hi] if hi < len(masters) else own, fid & 0xFFFFFF)
        return gkey

    def name(self, r, pi):
        v = r.sub('FULL')
        if not v:
            return ''
        if self.plugins[pi]['hflags'] & 0x80:
            return self.strings.table(self.plugins[pi]['name']).get(struct.unpack('<I', v[:4])[0], '')
        return zstr(v)

    def edid(self, key):
        w = self.win.get(key) if key else None
        return w[0].edid() if w else ''

    def plugins_of(self, key):
        return [self.names[i] for i in self.hist.get(key, [])]


def u32(r, name, off=0):
    v = r.sub(name)
    return struct.unpack_from('<I', v, off)[0] if v and len(v) >= off + 4 else 0


def common(lo, key, r, pi):
    return dict(key=key, formid=f'{lo.runtime_id(key) or 0:08X}', desc=lo.desc(key), form_key=lo.form_key(key),
                winning_plugin=lo.names[pi], plugins=lo.plugins_of(key), edid=r.edid(), name=lo.name(r, pi))


def keywords(lo, r, gkey):
    v = r.sub('KWDA')
    return [lo.edid(gkey(x)) for x in struct.unpack(f'<{len(v) // 4}I', v)] if v else []


def weapons(lo):
    out = []
    for key, r, pi in lo.by_type.get('WEAP', []):
        g = lo.resolver(pi)
        d = r.sub('DATA') or b''
        value, weight, damage = struct.unpack_from('<IfH', d) if len(d) >= 10 else (0, 0.0, 0)
        dn = r.sub('DNAM') or b''
        speed = struct.unpack_from('<f', dn, 4)[0] if len(dn) >= 8 else 0.0
        f1 = struct.unpack_from('<H', dn, 12)[0] if len(dn) >= 14 else 0
        tmpl = g(u32(r, 'CNAM'))
        out.append(dict(common(lo, key, r, pi), non_playable=int(bool(f1 & 0x80)), template=lo.edid(tmpl),
                        template_key=tmpl, keywords=' '.join(keywords(lo, r, g)), anim_type=ANIM.get(dn[0] if dn else 0),
                        damage=damage, speed=round(speed, 4), weight=round(weight, 4), value=value,
                        enchantment=lo.edid(g(u32(r, 'EITM')))))
    return out


def armors(lo):
    out = []
    for key, r, pi in lo.by_type.get('ARMO', []):
        g = lo.resolver(pi)
        d = r.sub('DATA') or b''
        value, weight = struct.unpack_from('<if', d) if len(d) >= 8 else (0, 0.0)
        dn = r.sub('DNAM')
        b2, bt = r.sub('BOD2'), r.sub('BODT')
        biped, atype, np_bodt = 0, None, False
        if b2 and len(b2) >= 8:
            biped, atype = struct.unpack_from('<II', b2)
        elif bt:
            biped = struct.unpack_from('<I', bt)[0]
            np_bodt = bool(bt[4] & 0x10) if len(bt) >= 5 else False
            atype = struct.unpack_from('<I', bt, 8 if len(bt) >= 12 else 4)[0] if len(bt) >= 8 else None
        tmpl = g(u32(r, 'TNAM'))
        out.append(dict(common(lo, key, r, pi), non_playable=int(bool(r.flags & 0x4) or np_bodt), template=lo.edid(tmpl),
                        template_key=tmpl, keywords=' '.join(keywords(lo, r, g)),
                        biped_slots=' '.join(f'{30 + b}:{BIPED.get(b, "")}'.rstrip(':') for b in range(32) if biped & (1 << b)),
                        armor_type={0: 'Light', 1: 'Heavy', 2: 'Clothing'}.get(atype, str(atype)),
                        ar=struct.unpack_from('<i', dn)[0] / 100 if dn else None, weight=round(weight, 4), value=value,
                        enchantment=lo.edid(g(u32(r, 'EITM')))))
    return out


def ammo(lo):
    out = []
    for key, r, pi in lo.by_type.get('AMMO', []):
        d = r.sub('DATA') or b''
        flags, dmg = struct.unpack_from('<If', d, 4) if len(d) >= 12 else (0, 0.0)
        out.append(dict(common(lo, key, r, pi), non_playable=int(bool(flags & 0x2)), bolt=int(not (flags & 0x4)),
                        damage=round(dmg, 3)))
    return out


def cobjs(lo):
    """Conditions are kept as (function, param edid, comparison, or-flag) for HasSpell only, which the audit reads."""
    out = []
    for key, r, pi in lo.by_type.get('COBJ', []):
        g = lo.resolver(pi)
        ing = []
        for v in r.all('CNTO'):
            item, cnt = struct.unpack_from('<Ii', v)
            ik = g(item)
            w = lo.win.get(ik) if ik else None
            ing.append(dict(key=ik, edid=lo.edid(ik), name=lo.name(*w) if w else '', type=w[0].type if w else '',
                            desc=lo.desc(ik) if ik else '', count=cnt))
        conds = []
        for v in r.all('CTDA'):
            if len(v) < 32:
                continue
            opf, fn, p1 = v[0], struct.unpack_from('<H', v, 8)[0], struct.unpack_from('<I', v, 12)[0]
            if fn == HAS_SPELL:
                conds.append(f'HasSpell({lo.edid(g(p1))}) == {struct.unpack_from("<f", v, 4)[0]:g}{" OR" if opf & 1 else ""}')
        created = g(u32(r, 'CNAM'))
        ci = lo.win.get(created) if created else None
        out.append(dict(common(lo, key, r, pi), created_key=created, created_edid=lo.edid(created),
                        created_type=ci[0].type if ci else '', bench=lo.edid(g(u32(r, 'BNAM'))), ingredients=ing,
                        conditions=conds, deleted=int(bool(r.flags & 0x20))))
    return out


def races(lo):
    out = {}
    for key, r, pi in lo.by_type.get('RACE', []):
        d = r.sub('DATA') or b''
        out[r.edid()] = dict(common(lo, key, r, pi), unarmed_damage=round(struct.unpack_from('<f', d, RACE_UNARMED_DAMAGE)[0], 4)
                             if len(d) >= RACE_UNARMED_DAMAGE + 4 else None)
    return out


def masters_of(path):
    buf = read_bytes(path, 1 << 16)
    hsz = struct.unpack_from('<I', buf, 4)[0]
    return [v.split(b'\0')[0].decode('latin1') for t, v in subs_of(buf[24:24 + hsz]) if t == 'MAST']
