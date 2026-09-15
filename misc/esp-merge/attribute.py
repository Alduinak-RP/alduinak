#!/usr/bin/env python3
# Step 1: attribution manifest for the r7 merge (read-only). Classifies every NEW own-index record and every R4 record NEW lacks.
#   python attribute.py
# Writes r7/attribution.json and r7/attribution.txt; exits 2 when a record is unclassified or a count does not reconcile.
import collections
import json
import math
import os
import pickle
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, 'tools')]
from r7lib import ESPFIX, INPUTS, R7, SELF, STAGE, assert_untouched, live_load_order, read_input, sha_bytes, sha_file  # noqa: E402
from esplib import Plugin, Record, zstr  # noqa: E402
import city  # noqa: E402

NEW_OWN = 0x0E
REF_TYPES = {'REFR', 'ACHR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON', 'PFLA'}
CELL_CHILD_GROUPS = (6, 8, 9, 10)
DUP_RE = re.compile(r'DUPLICATE\d*$', re.I)
COMPRESSED, DELETED, LOCALIZED = 0x40000, 0x20, 0x80
ESMS = ('Skyrim.esm', 'Update.esm', 'Dawnguard.esm', 'HearthFires.esm', 'Dragonborn.esm')
STRINGS_DIR = ESPFIX + 'r4/strings/strings/'
PRIOR = {'match.pkl': None, 'paired.pkl': None}
# Form id layout per subrecord: (entry size or 0 for one entry, form id offsets, padding offsets)
FID_LAYOUT = {
    'NAME': (0, (0,), ()), 'XTEL': (0, (0,), ()), 'XNDP': (0, (0,), (6, 7)), 'XESP': (0, (0,), (5, 6, 7)),
    'XOWN': (0, (0,), ()), 'XLCN': (0, (0,), ()), 'XEZN': (0, (0,), ()), 'XLRL': (0, (0,), ()), 'XPWR': (8, (0,), ()),
    'XAPR': (8, (0,), ()), 'XMBR': (0, (0,), ()), 'XEMI': (0, (0,), ()), 'XATR': (0, (0,), ()), 'XLIB': (0, (0,), ()),
    'LTMP': (0, (0,), ()), 'XCWT': (0, (0,), ()), 'XILL': (0, (0,), ()), 'XCAS': (0, (0,), ()), 'XCIM': (0, (0,), ()),
    'XCMO': (0, (0,), ()), 'XCCM': (0, (0,), ()), 'CNTO': (8, (0,), ()), 'KWDA': (4, (0,), ()), 'XLRT': (4, (0,), ()),
    'XLKR': (8, (0, 4), ()), 'XPOD': (4, (0,), ()), 'XLRM': (0, (0,), ()), 'XLTW': (0, (0,), ()),
    'XLOC': (0, (4,), (1, 2, 3, 9, 10, 11)), 'XCLR': (4, (0,), ()), 'ATXT': (0, (0,), (5,)), 'BTXT': (0, (0,), (5,)),
    'CTDA': (0, (12, 16, 24), (1, 2, 3, 10, 11)), 'XHOR': (0, (0,), ()), 'XCZC': (0, (0,), ()),
}
TYPE_LAYOUT = {('COBJ', 'CNAM'): (0, (0,), ()), ('COBJ', 'BNAM'): (0, (0,), ()),
               ('WEAP', 'CRDT'): (0, (16,), (2, 3, 9, 10, 11, 12, 13, 14, 15, 20, 21, 22, 23))}
RAW_PAD = {'XCLC': (9, 10, 11)}
FLOAT_SUBS = {'XSCL', 'XRDS', 'XCLW'}
# CK noise that stays as NEW has it: bounds and ragdolls are recomputed, location ref lists regenerated
NOISE_SUBS = {'OBND', 'XRGD', 'XRGB'}
TYPE_NOISE = {('LCTN', t) for t in ('ACSR', 'ACID', 'LCSR', 'LCID', 'ACPR', 'LCPR', 'ACEP', 'LCEP', 'ACUN', 'LCUN')}
NAV_SUBS = {'NVNM', 'NVMI', 'NVPP'}
PLAN = {'own': 7204, 'reowned_total': 873, 'reowned': {'COBJ': 358, 'REFR': 502, 'CELL': 6, 'NAVM': 3, 'ACTI': 1, 'FURN': 1, 'ACHR': 1},
        'collision_slots': [0x0012CC, 0x001328, 0x001384, 0x00138F, 0x0018F6, 0x0018F7, 0x001902, 0x001EE8, 0x001EE9, 0x001EEA, 0x001EEB],
        'renumbered_cells': {0x825: 0x726A, 0x826: 0x726D, 0x83B: 0x726E, 0x847: 0x726F, 0x85D: 0x719C}, 'renumbered_refs': 386,
        'broken': 0x0E04B2AB, 'lost': 111, 'lost_navm': 0x090C434A, 'lost_nvmi': 14, 'removed_own': 312,
        'removed_land': [0x001F7D, 0x001F7E, 0x001F85, 0x001F86, 0x001F87],
        'skyrim_navm': [0x079BDB, 0x0E807E, 0x0E8601, 0x0EA083, 0x0EA089, 0x0EA08A, 0x0EA091, 0x0EA094, 0x0EA09C], 'drop_navm': 0x0EA093,
        'xlcn_cells': [0x0095B8, 0x0095D7, 0x0095D8, 0x0095F7], 'new_cells': 84, 'city_refs': {'REFR': 304, 'ACHR': 30}, 'q449': 449,
        'q449_split': {'renumbered own (slot collision)': 306, 'renumbered override (slot collision)': 7, 'master ref, in place': 9,
                       'master ref, moved': 37, 'non-R4-master ref, moved': 5, 'non-R4-master ref, renumbered copy': 5, 'doubled copy': 1,
                       'genuinely new': 79},
        'copied_interiors': {'The Great City of Falkreath.esp': [0x0022CA], 'City of Dawnstar.esp': [0x006679, 0x010358, 0x015FC0, 0x07F4B6],
                             'Warbirds Whiterun Metropolis.esp': [0x1261EE, 0x21F472],
                             'Winterhold Restored.esp': [0x30948F, 0x33CA2F, 0x8D4981, 0xD7128E, 0xD7B4BB]}}


def strip_dup(e):
    return DUP_RE.sub('', e).lower()


def edid_dup(a, b):
    # NEW renamed an editor id to <name>DUPLICATEnnn, sometimes replacing trailing digits
    if not DUP_RE.search(b):
        return False
    stem = DUP_RE.sub('', b).lower()
    if DUP_RE.search(a):
        return DUP_RE.sub('', a).lower() == stem
    return a.lower() == stem or a.lower().rstrip('0123456789') == stem.rstrip('0123456789')


def hk(nk):
    return f'{nk[0]}:{nk[1]:06X}' if nk and nk[0] else '0'


def negzero(b):
    return b.replace(b'\x00\x00\x00\x80', b'\x00\x00\x00\x00')


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


class R:
    __slots__ = ('v', 'node', 'type', 'fid', 'flags', 'cellg', 'gtype', 'world', '_subs', '_edid', 'nk')

    def __init__(self, v, node, par):
        self.v, self.node = v, node
        self.type, self.fid, self.flags = node.type, node.fid, node.flags
        self.cellg = self.gtype = self.world = None
        for g in reversed(par):
            if g.gtype in CELL_CHILD_GROUPS and self.cellg is None:
                self.cellg, self.gtype = g.label, g.gtype
            if g.gtype == 1 and self.world is None:
                self.world = g.label
        self._subs = self._edid = None
        self.nk = v.nk(self.fid)

    def subs(self):
        if self._subs is None:
            self._subs = self.node.subs()
        return self._subs

    def sub(self, t):
        for a, b in self.subs():
            if a == t:
                return b
        return None

    def edid(self):
        if self._edid is None:
            v = self.sub('EDID')
            self._edid = zstr(v) if v else ''
        return self._edid

    def pos(self):
        d = self.sub('DATA')
        return struct.unpack_from('<6f', d) if d and len(d) >= 24 and self.type in REF_TYPES else None

    def base(self):
        b = self.sub('NAME')
        return u32(b, 0) if b and self.type in REF_TYPES else None

    def label(self):
        return f'{self.type} {self.fid:08X}' + (f' "{self.edid()}"' if self.edid() else '')


class View:
    def __init__(self, tag, buf, name=SELF, own=None):
        p = Plugin(buf=buf)
        assert p.serialize() == buf, f'{tag}: esplib round trip is not exact'
        self.tag, self.name, self.p = tag, name, p
        self.m = p.masters()
        self.n = len(self.m)
        self.own = self.n if own is None else own
        self.localized = bool(p.header.flags & LOCALIZED)
        self.recs, self.by_key, self.by_fid = [], collections.defaultdict(list), collections.defaultdict(list)
        for node, par in p.walk():
            if isinstance(node, Record):
                r = R(self, node, par)
                self.recs.append(r)
                self.by_key[(r.type,) + r.nk].append(r)
                self.by_fid[r.fid].append(r)

    def owner(self, idx):
        if idx < self.n:
            return self.m[idx]
        return self.name if idx == self.own else None

    def nk(self, fid):
        o = self.owner(fid >> 24)
        return (o if o is not None else '?%02X' % (fid >> 24), fid & 0xFFFFFF)

    def one(self, key):
        v = self.by_key.get(key, [])
        assert len(v) <= 1, f'{self.tag}: duplicate key {key}'
        return v[0] if v else None


# ---------------------------------------------------------------------------------------------------------------------
# Form id normalisation: (owner, local) in merge space, SELF meaning AlduinakAdditions in R4 numbering
class Canon:
    def __init__(s, new, dropped, origin):
        s.new, s.dropped = new, set(dropped)
        s.selfmap, s.renum_r4 = {}, set()
        s.newself = {r.fid & 0xFFFFFF for r in new.recs if (r.fid >> 24) == NEW_OWN}
        owners = collections.defaultdict(set)
        for m, recs in origin.items():
            for (t, loc) in recs:
                owners[loc].add(m)
        s.selfq_owner = {loc: next(iter(ms)) for loc, ms in owners.items() if len(ms) == 1}
        s.selfq_seen = collections.defaultdict(set)

    def of(s, v, fid):
        if fid == 0:
            return ('', 0)
        o = v.owner(fid >> 24)
        loc = fid & 0xFFFFFF
        if v is s.new and o == SELF:
            if loc in s.selfmap:
                return s.selfmap[loc]
            return ('SELF', loc) if loc in s.newself else ('SELF?', loc)
        if o is None:
            return ('?BAD', fid)
        return ('SELF', loc) if o == SELF else (o, loc)

    def eq(s, ca, cb):
        if ca == cb:
            return True
        return (ca[0] == 'SELF?' and cb[0] in s.dropped and ca[1] == cb[1]) or (cb[0] == 'SELF?' and ca[0] in s.dropped and ca[1] == cb[1])

    def lostable(s, c):
        return c[0] in s.dropped or (c[0] == 'SELF' and c[1] in s.renum_r4)

    def broken(s, c):
        return c[0] in ('', 'SELF?', '?BAD')


def layout(rtype, t):
    return TYPE_LAYOUT.get((rtype, t)) or FID_LAYOUT.get(t)


def entries(vals, lay, rec, canon, remapped):
    # canonical (form ids, other bytes) per list entry; a NEW dangling self link to a dropped-master id is mapped and noted
    size, slots, pads = lay
    out = []
    for val in vals:
        n = size or len(val)
        for i in range(0, max(len(val) - n + 1, 1), n):
            e = val[i:i + n]
            fids = []
            for s in slots:
                if s + 4 > len(e):
                    continue
                c = canon.of(rec.v, u32(e, s))
                if c[0] == 'SELF?' and c[1] in canon.selfq_owner:
                    canon.selfq_seen[c[1]].add(canon.selfq_owner[c[1]])
                    remapped.append(c)
                    c = (canon.selfq_owner[c[1]], c[1])
                fids.append(c)
            rest = bytearray(e)
            for s in slots:
                rest[s:s + 4] = b'\0' * len(rest[s:s + 4])
            for p in pads:
                if p < len(rest):
                    rest[p] = 0
            out.append((tuple(fids), negzero(bytes(rest))))
    return out


def list_diff(t, la, lb, ra, rb, canon, out):
    lay = layout(ra.type, t)
    remapped = []
    ea, eb = entries(la, lay, ra, canon, []), entries(lb, lay, rb, canon, remapped)
    ca, cb = collections.Counter(ea), collections.Counter(eb)
    only_a, only_b = list((ca - cb).elements()), list((cb - ca).elements())
    for nb in list(only_b):
        for na in only_a:
            if na[1] == nb[1] and len(na[0]) == len(nb[0]) and all(
                    x == y or (canon.lostable(x) and (canon.broken(y) or x[1] == y[1])) or (x[0] and y == ('', 0)) for x, y in zip(na[0], nb[0])):
                out.append(('artifact', t, 'link lost ' + ','.join(hk(x) for x, y in zip(na[0], nb[0]) if x != y)))
                only_a.remove(na)
                only_b.remove(nb)
                break
    for na in only_a:
        live = [x for x in na[0] if x[0]]
        # the CK drops a whole list entry (keyword plus ref, item plus count) when one of its links does not resolve
        if not live or any(canon.lostable(x) for x in live):
            out.append(('artifact', t, 'entry lost' + (' ' + ','.join(hk(x) for x in live) if live else ' (null entry)')))
        elif t == 'XLRL':
            out.append(('noise', t, 'location ref removed'))
        else:
            out.append(('edit', t, 'entry removed ' + ','.join(hk(x) for x in live)))
    for nb in only_b:
        out.append(('noise', t, 'location ref added') if t == 'XLRL' else ('edit', t, 'entry added ' + ','.join(hk(x) for x in nb[0] if x[0])))
    if not only_a and not only_b and ea != eb and ca == cb:
        out.append(('noise', t, 'entries reordered'))
    if remapped:
        out.append(('artifact', t, 'dangling self link to a dropped-master id ' + ','.join(f'{c[1]:06X}' for c in remapped)))


# ---- VMAD (scripts only; a quest's fragment and alias tail is compared as bytes) ----
def wstr(b, o):
    n = struct.unpack_from('<H', b, o)[0]
    return b[o + 2:o + 2 + n], o + 2 + n


def vmad_value(b, o, t, fmt):
    if t == 1:
        if fmt == 1:
            fid, alias = struct.unpack_from('<Ih', b, o)
        else:
            alias, fid = struct.unpack_from('<hI', b, o + 2)
        return ('obj', alias, fid), o + 8
    if t == 2:
        s, o = wstr(b, o)
        return ('s', s), o
    if t in (3, 4):
        return ('n', b[o:o + 4]), o + 4
    if t == 5:
        return ('b', b[o]), o + 1
    if t in (11, 12, 13, 14, 15):
        n = u32(b, o)
        o += 4
        items = []
        for _ in range(n):
            val, o = vmad_value(b, o, t - 10, fmt)
            items.append(val)
        return ('list', tuple(items)), o
    raise ValueError(f'VMAD property type {t}')


def vmad_scripts(b):
    ver, fmt, n = struct.unpack_from('<hhH', b, 0)
    o, out = 6, []
    for _ in range(n):
        name, o = wstr(b, o)
        st = 0
        if ver >= 4:
            st, o = b[o], o + 1
        pc = struct.unpack_from('<H', b, o)[0]
        o += 2
        props = []
        for _ in range(pc):
            pn, o = wstr(b, o)
            pt = b[o]
            o += 1
            ps = 0
            if ver >= 4:
                ps, o = b[o], o + 1
            val, o = vmad_value(b, o, pt, fmt)
            props.append((pn, pt, ps, val))
        out.append((name, st, props))
    return out, b[o:]


def vmad_fids(val):
    if val[0] == 'obj':
        yield val[2]
    elif val[0] == 'list':
        for x in val[1]:
            yield from vmad_fids(x)


def vmad_canon(val, rec, canon):
    if val[0] == 'obj':
        return ('obj', val[1], canon.of(rec.v, val[2]))
    if val[0] == 'list':
        return ('list', tuple(vmad_canon(x, rec, canon) for x in val[1]))
    return val


def vmad_diff(x, y, ra, rb, canon, out):
    if sorted(x) == sorted(y):
        out.append(('noise', 'VMAD', 'same bytes reordered'))
        return
    try:
        (sa, ta), (sb, tb) = vmad_scripts(x), vmad_scripts(y)
    except (ValueError, struct.error, IndexError):
        out.append(('edit', 'VMAD', 'unparsed'))
        return
    da = {n: (st, {p[0]: (p[1], p[2], vmad_canon(p[3], ra, canon)) for p in pr}) for n, st, pr in sa}
    db = {n: (st, {p[0]: (p[1], p[2], vmad_canon(p[3], rb, canon)) for p in pr}) for n, st, pr in sb}
    for n in sorted(set(da) | set(db), key=lambda z: z.lower()):
        if n not in db or n not in da:
            out.append(('edit', 'VMAD', f'script {n.decode("latin1")} ' + ('removed' if n in da else 'added')))
            continue
        pa, pb = da[n][1], db[n][1]
        if da[n][0] != db[n][0]:
            out.append(('edit', 'VMAD', f'script {n.decode("latin1")} status'))
        for p in sorted(set(pa) | set(pb)):
            if pa.get(p) == pb.get(p):
                continue
            objs_a = [v for v in flat_objs(pa[p][2])] if p in pa else []
            objs_b = [v for v in flat_objs(pb[p][2])] if p in pb else []
            cleared = p in pb and objs_a and len(objs_a) == len(objs_b) and all(b == a or b == ('', 0) for a, b in zip(objs_a, objs_b)) and \
                [x for x in pa[p][:2]] == [x for x in pb[p][:2]]
            if cleared or (p in pa and objs_a and all(canon.lostable(c) for c in objs_a) and (p not in pb or all(canon.broken(c) or c[1] == a[1] for c, a in zip(objs_b, objs_a)))):
                out.append(('artifact', 'VMAD', f'{n.decode("latin1")}.{p.decode("latin1")} link lost {",".join(hk(c) for c in objs_a)}'))
            else:
                out.append(('edit', 'VMAD', f'{n.decode("latin1")}.{p.decode("latin1")}'))
    if ta != tb:
        out.append(('noise', 'VMAD', 'fragment tail reordered') if sorted(ta) == sorted(tb) else ('edit', 'VMAD', 'fragment or alias tail'))


def flat_objs(val):
    if val[0] == 'obj':
        yield val[2]
    elif val[0] == 'list':
        for x in val[1]:
            yield from flat_objs(x)


STRINGS = {}


def full_text(rec, val):
    if rec.v.localized and len(val) == 4:
        stem = os.path.splitext(rec.v.name)[0].lower()
        if stem not in STRINGS:
            p = STRINGS_DIR + stem + '_english.strings'
            STRINGS[stem] = city.read_strings(p) if os.path.exists(p) else {}
        return STRINGS[stem].get(u32(val, 0))
    return val.split(b'\0')[0]


def raw_diff(t, x, y, ra, rb, canon, out):
    rt = ra.type
    if t == 'EDID':
        a, b = zstr(x), zstr(y)
        out.append(('artifact', t, f'{a} -> {b}') if edid_dup(a, b) else ('edit', t, f'{a} -> {b}'))
        return
    if t == 'FULL':
        a, b = full_text(ra, x), full_text(rb, y)
        if a is None or b is None:
            out.append(('edit', t, 'localized name unresolved'))
        elif a != b:
            out.append(('edit', t, f'{a!r} -> {b!r}'))
        return
    if t in NOISE_SUBS or (rt, t) in TYPE_NOISE:
        out.append(('noise', t, 'recomputed'))
        return
    if t == 'VMAD':
        vmad_diff(x, y, ra, rb, canon, out)
        return
    if t == 'DATA' and rt in REF_TYPES and len(x) == len(y) == 24:
        pa, pb = struct.unpack('<6f', x), struct.unpack('<6f', y)
        dp = max(abs(p - q) for p, q in zip(pa[:3], pb[:3]))
        dr = max(min(abs(p - q) % (2 * math.pi), 2 * math.pi - abs(p - q) % (2 * math.pi)) for p, q in zip(pa[3:], pb[3:]))
        if dp < 0.01 and dr < 1e-4:
            out.append(('noise', t, 'rotation normalised'))
        else:
            out.append(('edit', t, f'moved {math.dist(pa[:3], pb[:3]):.1f} units' + (f', rotated {dr:.3f} rad' if dr >= 1e-4 else '')))
        return
    if t in FLOAT_SUBS and len(x) == len(y) and len(x) % 4 == 0:
        fa = struct.unpack(f'<{len(x) // 4}f', x)
        fb = struct.unpack(f'<{len(y) // 4}f', y)
        if all(abs(p - q) <= 1e-4 * max(1.0, abs(p)) for p, q in zip(fa, fb)):
            out.append(('noise', t, 'float rounding'))
        else:
            out.append(('edit', t, f'{fa} -> {fb}'))
        return
    if t in RAW_PAD and len(x) == len(y):
        xa, ya = bytearray(x), bytearray(y)
        for p in RAW_PAD[t]:
            if p < len(xa):
                xa[p] = ya[p] = 0
        if xa == ya:
            out.append(('noise', t, 'padding'))
            return
    if negzero(x) == negzero(y):
        out.append(('noise', t, '-0.0'))
        return
    if t in NAV_SUBS:
        out.append(('edit', t, 'navmesh data'))
        return
    out.append(('edit', t, f'{x.hex()[:40]} -> {y.hex()[:40]}' if len(x) <= 20 and len(y) <= 20 else f'len {len(x)} -> {len(y)}'))


def compare(ra, rb, canon):
    # ra is the reference side (R4, RAW or a load-order plugin), rb the side being judged; returns (noise|artifact|edit, subrecord, detail)
    out = []
    if (ra.flags & ~COMPRESSED) != (rb.flags & ~COMPRESSED):
        out.append(('edit', '', f'record flags {ra.flags:08X} -> {rb.flags:08X}'))
    elif ra.flags != rb.flags:
        out.append(('noise', '', 'compression flag'))
    if ra.flags & DELETED and rb.flags & DELETED:
        return out
    sa, sb = ra.subs(), rb.subs()
    ga, gb = collections.defaultdict(list), collections.defaultdict(list)
    for t, v in sa:
        ga[t].append(v)
    for t, v in sb:
        gb[t].append(v)
    if [t for t, _ in sa] != [t for t, _ in sb] and sorted(t for t, _ in sa) == sorted(t for t, _ in sb):
        out.append(('noise', '', 'subrecord order'))
    cnto_art = False
    for t in dict.fromkeys([t for t, _ in sa] + [t for t, _ in sb]):
        la, lb = ga.get(t, []), gb.get(t, [])
        if la == lb or t == 'COCT':
            continue
        if layout(ra.type, t):
            n0 = len(out)
            list_diff(t, la, lb, ra, rb, canon, out)
            if t == 'CNTO' and all(c == 'artifact' for c, _, _ in out[n0:]):
                cnto_art = True
            continue
        if not lb or not la:
            out.append(('edit', t, 'subrecord ' + ('removed' if la else 'added')))
            continue
        if len(la) != len(lb):
            out.append(('edit', t, f'count {len(la)} -> {len(lb)}'))
            continue
        for x, y in zip(la, lb):
            if x != y:
                raw_diff(t, x, y, ra, rb, canon, out)
    if ga.get('COCT') != gb.get('COCT'):
        out.append(('artifact', 'COCT', 'item count follows the lost CNTO entries') if cnto_art else ('edit', 'COCT', 'item count'))
    return out


def nvnm_links(v):
    # edge-link navmesh ids and door ref ids; the edge entry size is tried both ways and kept when every door carries the pathing-door CRC
    for esz in (12, 11, 10):
        try:
            nv = u32(v, 16)
            o = 20 + 12 * nv
            nt = u32(v, o)
            o += 4 + 16 * nt
            ne = u32(v, o)
            edges = [u32(v, o + 4 + esz * k + 4) for k in range(ne)]
            o += 4 + esz * ne
            nd = u32(v, o)
            if nd > 5000 or o + 4 + 10 * nd > len(v):
                continue
            doors = [struct.unpack_from('<hII', v, o + 4 + 10 * k) for k in range(nd)]
            if all(c == 0xE48B73F3 for _, c, _ in doors):
                return edges, [d for _, _, d in doors]
        except struct.error:
            continue
    return None


def nvnm_geometry(v):
    nv = u32(v, 16)
    o = 20 + 12 * nv
    nt = u32(v, o)
    tris = v[o + 4:o + 4 + 16 * nt]
    return nv, nt, v[20:20 + 12 * nv], b''.join(tris[i:i + 6] for i in range(0, len(tris), 16))


def close(p, q, tol=0.05):
    return p is not None and q is not None and all(abs(x - y) <= tol for x, y in zip(p[:3], q[:3])) and all(abs(x - y) <= 0.002 for x, y in zip(p[3:], q[3:]))


# ---------------------------------------------------------------------------------------------------------------------
class Attr:
    def __init__(s, new, r4, raw, dm, origin, dropped, canon, srcs):
        s.new, s.r4, s.raw, s.dm, s.origin, s.dropped, s.canon = new, r4, raw, dm, origin, dropped, canon
        # every plugin before AlduinakAdditions that NEW does not have as a master; the CK wrote Graves's overrides of them at the own index
        s.srcs = srcs
        s.entries, s.cp, s.r4taken = {}, {}, {}
        s.own = [r for r in new.recs if (r.fid >> 24) >= 8]
        assert all((r.fid >> 24) == NEW_OWN for r in s.own), 'own records at an index other than 0x0E'
        assert max(collections.Counter(r.fid & 0xFFFFFF for r in s.own).values()) == 1, 'NEW reuses a local id across own records'
        s.unclassified, s.problems = [], []
        # a slot where R4 has more than one own or dropped-master record (any type) holds only one of them in NEW
        by_loc = collections.defaultdict(list)
        for x in r4.recs:
            if x.nk[0] == SELF or x.nk[0] in dropped:
                by_loc[x.fid & 0xFFFFFF].append(x)
        s.collide = {k: v for k, v in by_loc.items() if len(v) > 1}
        s.same_type_slots = {k for k, v in s.collide.items() if len({x.type for x in v}) < len(v)}
        s.holder = {r.fid & 0xFFFFFF: r for r in s.own}

    # ---- helpers ----
    def r4own(s, t, loc):
        return s.r4.one((t, SELF, loc))

    def r4ovr(s, t, loc):
        return [(m, s.r4.one((t, m, loc))) for m in s.dropped if s.r4.one((t, m, loc))]

    def dmdef(s, t, loc):
        return [(m, s.origin[m][(t, loc)]) for m in s.srcs if (t, loc) in s.origin[m]]

    def src_tag(s, m):
        return 'master' if m in s.dropped else 'non-R4-master'

    def cellkey(s, r):
        return s.canon.of(r.v, r.cellg) if r.cellg is not None else None

    def same_ref(s, n, x, strict=True):
        c = s.canon
        if n.type != x.type or not c.eq(c.of(n.v, n.base()), c.of(x.v, x.base())):
            return False
        if not strict:
            return True
        cn, cx = s.cellkey(n), s.cellkey(x)
        return cn is not None and cx is not None and c.eq(cn, cx) and close(n.pos(), x.pos())

    def set_self(s, loc, target):
        s.canon.selfmap[loc] = target

    def take(s, x, why):
        assert x.fid not in s.r4taken, f'R4 {x.label()} used twice ({s.r4taken[x.fid]}, {why})'
        s.r4taken[x.fid] = why

    def slot_note(s, loc):
        if loc not in s.collide:
            return ''
        h = s.holder.get(loc)
        return f'; slot {loc:06X} is shared in R4 by ' + ', '.join(f'{x.nk[0]} {x.type}' for x in s.collide[loc]) + f' and NEW holds {h.label() if h else "nothing"} there'

    def put(s, src, r, cls, sub=None, master=None, cp=None, target=None, action=None, note=None):
        key = (src, r.fid)
        assert key not in s.entries, f'{src} {r.label()} classified twice'
        e = {'src': src, 'fid': f'{r.fid:08X}', 'type': r.type, 'class': cls}
        if r.edid():
            e['edid'] = r.edid()
        if sub:
            e['subtype'] = sub
        if master:
            e['master'] = master
        if cp is not None:
            e['counterpart'] = f'{cp.v.tag}:{cp.fid:08X}'
            s.cp[key] = cp
        ck = s.cellkey(r)
        if ck:
            e['cell'] = hk(ck)
        if r.world is not None and r.type != 'CELL':
            e['world'] = hk(s.canon.of(r.v, r.world))
        if target:
            e['target'] = target
        if action:
            e['action'] = action
        if note:
            e['note'] = note.lstrip('; ')
        s.entries[key] = e
        return e

    def own_target(s, r):
        return f'{SELF}:{r.fid & 0xFFFFFF:06X}'

    # ---- phase 1: cells ----
    def cells(s):
        pend = []
        for r in s.own:
            if r.type != 'CELL':
                continue
            loc = r.fid & 0xFFFFFF
            a, b = s.r4own('CELL', loc), s.r4ovr('CELL', loc)
            d = [(m, x) for m, x in s.dmdef('CELL', loc) if strip_dup(x.edid()) == strip_dup(r.edid())]
            if (a and b) or len(b) > 1:
                s.unclassified.append(f'CELL {r.label()}: more than one R4 record on the slot')
            elif not a and not b and len(d) > 1:
                s.unclassified.append(f'CELL {r.label()}: defined by {[m for m, _ in d]}')
            elif a:
                s.set_self(loc, ('SELF', loc))
                s.take(a, 'own')
                s.put('NEW', r, 'OWN', cp=a, target=s.own_target(r), action='keep')
            elif b:
                m, x = b[0]
                s.set_self(loc, (m, loc))
                s.take(x, 'reowned')
                s.put('NEW', r, 'REOWNED', master=m, cp=x, target=f'{m}:{loc:06X}')
            elif d:
                m, x = d[0]
                s.set_self(loc, (m, loc))
                s.put('NEW', r, 'REOWNED', sub='MASTER-DEFINED', master=m, cp=x, target=f'{m}:{loc:06X}')
            else:
                pend.append(r)
        miss = [x for x in s.r4.recs if x.type == 'CELL' and x.nk[0] == SELF and x.fid not in s.r4taken]
        for r in pend:
            hits = [x for x in miss if x.edid() == r.edid() and x.fid not in s.r4taken]
            if len(hits) == 1:
                x = hits[0]
                s.set_self(r.fid & 0xFFFFFF, ('SELF', x.fid & 0xFFFFFF))
                s.take(x, 'renumbered')
                s.put('NEW', r, 'RENUMBERED', cp=x, target=s.own_target(r), action='keep',
                      note=f'R4 id {x.fid & 0xFFFFFF:06X} -> NEW id {r.fid & 0xFFFFFF:06X}' + s.slot_note(x.fid & 0xFFFFFF))
            elif not hits and not s.raw.one(('CELL', SELF, r.fid & 0xFFFFFF)):
                s.set_self(r.fid & 0xFFFFFF, ('SELF', r.fid & 0xFFFFFF))
                s.put('NEW', r, 'OWN', sub='NEW', target=s.own_target(r), action='keep')
            else:
                s.unclassified.append(f'CELL {r.label()}: {len(hits)} renumber candidates')

    # ---- phase 2: every own type other than cells and refs ----
    def others(s):
        for r in s.own:
            if r.type in REF_TYPES or r.type == 'CELL':
                continue
            loc = r.fid & 0xFFFFFF
            a, b = s.r4own(r.type, loc), s.r4ovr(r.type, loc)
            if r.type in ('NAVM', 'LAND'):
                d = [(m, x) for m, x in s.dmdef(r.type, loc) if s.canon.eq(s.cellkey(r), s.canon.of(x.v, x.cellg))]
            else:
                d = [(m, x) for m, x in s.dmdef(r.type, loc) if strip_dup(x.edid()) == strip_dup(r.edid())]
            if (a and b) or len(b) > 1:
                s.unclassified.append(f'{r.label()}: more than one R4 record on the slot')
            elif not a and not b and len(d) > 1:
                s.unclassified.append(f'{r.label()}: defined by {[m for m, _ in d]}')
            elif a:
                s.set_self(loc, ('SELF', loc))
                s.take(a, 'own')
                s.put('NEW', r, 'OWN', cp=a, target=s.own_target(r), action='keep')
            elif b:
                m, x = b[0]
                s.set_self(loc, (m, loc))
                s.take(x, 'reowned')
                s.put('NEW', r, 'REOWNED', master=m, cp=x, target=f'{m}:{loc:06X}')
            elif d:
                m, x = d[0]
                s.set_self(loc, (m, loc))
                s.put('NEW', r, 'REOWNED', sub='MASTER-DEFINED', master=m, cp=x, target=f'{m}:{loc:06X}')
            elif s.raw.one((r.type, SELF, loc)):
                s.unclassified.append(f'{r.label()}: in RAW but not R4 (an r3/r4 removal came back)')
            else:
                s.set_self(loc, ('SELF', loc))
                s.put('NEW', r, 'OWN', sub='NEW', target=s.own_target(r), action='keep')

    # ---- phase 3: refs ----
    def refs(s):
        pend = []
        for r in s.own:
            if r.type not in REF_TYPES:
                continue
            loc = r.fid & 0xFFFFFF
            b0 = r.base()
            if b0 is not None and 8 <= (b0 >> 24) < NEW_OWN:
                s.set_self(loc, ('BROKEN', loc))
                s.put('NEW', r, 'BROKEN', action='delete', note=f'NAME {b0:08X} uses index {b0 >> 24:02X}, past the master list')
                continue
            a, b = s.r4own(r.type, loc), s.r4ovr(r.type, loc)
            if len(b) > 1:
                s.unclassified.append(f'{r.label()}: R4 overrides of two dropped masters share the slot')
            elif a and b:
                pend.append((r, 'collision', a, b))
            elif a:
                if s.same_ref(r, a, strict=False):
                    s.set_self(loc, ('SELF', loc))
                    s.take(a, 'own')
                    s.put('NEW', r, 'OWN', cp=a, target=s.own_target(r), action='keep')
                else:
                    pend.append((r, 'own-mismatch', a, b))
            elif b:
                m, x = b[0]
                if s.same_ref(r, x, strict=False):
                    s.set_self(loc, (m, loc))
                    s.take(x, 'reowned')
                    s.put('NEW', r, 'REOWNED', master=m, cp=x, target=f'{m}:{loc:06X}')
                else:
                    pend.append((r, 'override-mismatch', a, b))
            else:
                pend.append((r, 'unmatched', a, b))
        # collisions: the survivor is whichever R4 record NEW's content matches; the CK renumbered the other one
        rest = []
        for r, why, a, b in pend:
            if why != 'collision':
                rest.append((r, why, a, b))
                continue
            loc = r.fid & 0xFFFFFF
            m, x = b[0]
            ma, mb = s.same_ref(r, a), s.same_ref(r, x)
            if ma and not mb:
                s.set_self(loc, ('SELF', loc))
                s.take(a, 'own')
                s.put('NEW', r, 'OWN', cp=a, target=s.own_target(r), action='keep')
            elif mb and not ma:
                s.set_self(loc, (m, loc))
                s.take(x, 'reowned')
                s.put('NEW', r, 'REOWNED', master=m, cp=x, target=f'{m}:{loc:06X}')
            else:
                s.unclassified.append(f'{r.label()}: collision content matches own={ma} override={mb}')
        losers = {x.fid: x for xs in s.collide.values() for x in xs if x.fid not in s.r4taken}
        # renumber pool: R4 own refs and R4 dropped-master override refs that no NEW record holds by key
        pool = [x for x in s.r4.recs if x.type in REF_TYPES and x.fid not in s.r4taken and (x.nk[0] == SELF or x.nk[0] in s.dropped)]
        by_base = collections.defaultdict(list)
        for m in s.srcs:
            for (t, _), x in s.origin[m].items():
                if t in REF_TYPES:
                    by_base[s.canon.of(x.v, x.base())].append(x)

        def near(r):
            k = s.canon.of(r.v, r.base())
            return by_base.get(k, []) if k[0] != 'SELF?' else [x for xs in by_base.values() for x in xs]
        s.q449 = collections.Counter()
        s.q449_total = len(rest)
        s.q449_fids = [r.fid for r, _, _, _ in rest]
        for r, why, a, b in rest:
            loc = r.fid & 0xFFFFFF
            keynote = ''
            if why == 'override-mismatch':
                keynote = f'; R4 {b[0][0]} override {b[0][1].fid:08X} shares the id but is a different ref (it is LOST)'
            elif why == 'own-mismatch':
                keynote = f'; R4 own {a.fid:08X} shares the id but is a different ref'
            ren = [x for x in pool if x.fid not in s.r4taken and s.same_ref(r, x)]
            if r.edid():
                ren = [x for x in ren if x.edid() == r.edid()] or [x for x in pool if x.fid not in s.r4taken and x.edid() == r.edid() and x.type == r.type]
            dmx = [(m, x) for m, x in s.dmdef(r.type, loc) if s.same_ref(r, x)]
            dml = [(m, x) for m, x in s.dmdef(r.type, loc) if s.same_ref(r, x, strict=False)]
            # a plugin ref whose id an own record already holds: the CK gave Graves's override of it the next free id
            mren = [(x.v.name, x) for x in near(r) if (x.fid & 0xFFFFFF) != loc and (x.fid & 0xFFFFFF) in s.holder and s.same_ref(r, x)
                    and not s.same_ref(s.holder[x.fid & 0xFFFFFF], x, strict=False) and all(y.nk != x.nk for y in ren)]
            if (ren and dmx) or (ren and mren) or ((dmx or dml) and mren):
                s.unclassified.append(f'{r.label()}: matches more than one of R4 {[x.label() for x in ren[:1]]}, '
                                      f'same id {[f"{m} {x.label()}" for m, x in (dmx or dml)[:1]]}, renumbered {[f"{m} {x.label()}" for m, x in mren[:1]]}')
                continue
            if not ren and (len(dmx or dml) > 1 or len(mren) > 1):
                s.unclassified.append(f'{r.label()}: matches refs in several plugins {[f"{m} {x.label()}" for m, x in (dmx or dml or mren)]}')
                continue
            if ren:
                x = ren[0]
                xl = x.fid & 0xFFFFFF
                extra = s.slot_note(xl) + (f'; {len(ren)} identical candidates' if len(ren) > 1 else '') + keynote
                same = x.fid in losers and xl in s.same_type_slots
                tag = ' (slot collision)' if x.fid in losers else ''
                if x.nk[0] == SELF:
                    s.set_self(loc, ('SELF', xl))
                    s.put('NEW', r, 'COLLISION' if same else 'RENUMBERED', sub='LOSER-RENUMBERED' if same else None, cp=x,
                          target=s.own_target(r), action='keep', note=f'R4 own {xl:06X} -> NEW id {loc:06X}' + extra)
                    s.q449['renumbered own' + tag] += 1
                else:
                    m = x.nk[0]
                    s.set_self(loc, (m, xl))
                    s.put('NEW', r, 'COLLISION' if same else 'REOWNED', sub='LOSER-RENUMBERED' if same else 'RENUMBERED', master=m, cp=x,
                          target=f'{m}:{xl:06X}', note=f'R4 {m} override {xl:06X}; the CK renumbered it to {loc:06X}' + extra)
                    s.q449['renumbered override' + tag] += 1
                s.take(x, 'renumbered')
            elif dmx or dml:
                m, x = (dmx or dml)[0]
                s.set_self(loc, (m, loc))
                moved = '' if dmx else f'; moved {math.dist(r.pos()[:3], x.pos()[:3]):.1f} units' + (
                    '' if s.canon.eq(s.cellkey(r), s.canon.of(x.v, x.cellg)) else f' into cell {hk(s.cellkey(r))} from {hk(s.canon.of(x.v, x.cellg))}')
                s.put('NEW', r, 'REOWNED', sub='MASTER-DEFINED', master=m, cp=x, target=f'{m}:{loc:06X}',
                      note=f'same id and base as the {m} ref' + ('' if m in s.dropped else ' (not an R4 master)') +
                      '; left own it would be a second copy of it' + moved + keynote)
                s.q449[s.src_tag(m) + ' ref, ' + ('in place' if dmx else 'moved')] += 1
            elif mren:
                m, x = mren[0]
                xl = x.fid & 0xFFFFFF
                s.set_self(loc, (m, xl))
                s.put('NEW', r, 'REOWNED', sub='MASTER-RENUMBERED', master=m, cp=x, target=f'{m}:{xl:06X}',
                      note=f'same base, cell and position as the {m} ref {xl:06X}' + ('' if m in s.dropped else ' (not an R4 master)') +
                      f', whose id NEW gives to {s.holder[xl].label()}; the CK renumbered the override to {loc:06X}' + keynote)
                s.q449[s.src_tag(m) + ' ref, renumbered copy'] += 1
            else:
                dup = [x for x in pool + near(r) if close(r.pos(), x.pos()) and s.same_ref(r, x)]
                s.set_self(loc, ('SELF', loc))
                if dup:
                    x = dup[0]
                    s.put('NEW', r, 'OWN', sub='DOUBLED', cp=x, target=s.own_target(r), action='keep',
                          note=f'new id, exact copy (cell, base, position) of {x.v.tag} {x.label()} ({x.nk[0]}); owner review' + keynote)
                    s.q449['doubled copy'] += 1
                else:
                    same_id = [f'{m} {x.label()}' for m, x in s.dmdef(r.type, loc)]
                    s.put('NEW', r, 'OWN', sub='NEW', target=s.own_target(r), action='keep',
                          note=(f'id also used by {same_id} with another base' if same_id else '') + keynote)
                    s.q449['genuinely new'] += 1
        for fid, x in losers.items():
            loc = x.fid & 0xFFFFFF
            if fid not in s.r4taken and loc in s.same_type_slots:
                s.take(x, 'collision-loser')
                s.put('R4', x, 'COLLISION', sub='LOSER-LOST', master=x.nk[0] if x.nk[0] != SELF else None, target=f'{x.nk[0]}:{loc:06X}',
                      action='restore-r4', note='not in NEW under any id' + s.slot_note(loc))
        s.canon.renum_r4 = {xl for loc, (o, xl) in s.canon.selfmap.items() if o == 'SELF' and loc != xl}

    def collision_survivors(s):
        s.empty_slots = []
        for loc, xs in s.collide.items():
            h = s.holder.get(loc)
            e = s.entries.get(('NEW', h.fid)) if h else None
            if e is None:
                s.empty_slots.append(loc)
                continue
            others = [x for x in xs if f'{x.v.tag}:{x.fid:08X}' != e.get('counterpart')]
            e['slot_shared_with'] = [f'R4:{x.fid:08X} {x.nk[0]} {x.type}' for x in others]
            if loc in s.same_type_slots:
                if e['class'] in ('OWN', 'REOWNED') and not e.get('subtype'):
                    e['class'], e['subtype'] = 'COLLISION', 'SURVIVOR-' + e['class']
                else:
                    s.unclassified.append(f'collision slot {loc:06X}: NEW holder is {e["class"]}/{e.get("subtype")}')

    # ---- phase 4: overrides of masters NEW kept ----
    def masters_pairs(s):
        s.master_pairs, s.master_new = [], []
        for r in s.new.recs:
            if (r.fid >> 24) >= 8:
                continue
            x = s.r4.one((r.type,) + r.nk)
            if x is not None:
                s.take(x, 'master-pair')
                s.cp[('NEW', r.fid)] = x
                s.master_pairs.append(r)
            else:
                s.master_new.append(r)

    # ---- phase 5: R4 records NEW lacks ----
    def r4_missing(s):
        s.r4_gone = [x for x in s.r4.recs if x.fid not in s.r4taken]
        for x in s.r4_gone:
            loc = x.fid & 0xFFFFFF
            h = s.holder.get(loc)
            reuse = f'; NEW reuses id {loc:06X} for {h.label()}' if h is not None and (x.nk[0] in s.dropped or x.nk[0] == SELF) else ''
            if x.nk[0] == SELF:
                s.put('R4', x, 'GRAVES-REMOVED', sub=x.type, action='absent', note='own record absent from NEW under any id' + reuse)
            elif x.nk[0] in s.dropped:
                s.put('R4', x, 'LOST', master=x.nk[0], target=f'{x.nk[0]}:{loc:06X}', action='restore-r4',
                      note=('deleted-flag override; ' if x.flags & DELETED else '') + 'absent from NEW under any id' + reuse + s.slot_note(loc))
            else:
                s.put('R4', x, 'GRAVES-REMOVED', sub='MASTER-OVERRIDE', action='absent', note='override absent from NEW')

    # ---- phase 6: content of every pair ----
    def decide(s):
        s.pair_stats = collections.Counter()
        s.reverted = []
        rekey = {'REOWNED', 'COLLISION'}
        for r in s.master_pairs:
            key = ('NEW', r.fid)
            d = compare(s.cp[key], r, s.canon)
            cats = {c for c, _, _ in d}
            if not d:
                s.pair_stats[(r.type, 'IDENTICAL')] += 1
                continue
            edits = sorted({t or 'flags' for c, t, _ in d if c == 'edit'})
            arts = sorted({t for c, t, _ in d if c == 'artifact'})
            if not edits and not arts:
                s.pair_stats[(r.type, 'CK-NOISE')] += 1
                s.put('NEW', r, 'MASTER-OVERRIDE', sub='CK-NOISE', cp=s.cp[key], target=hk(r.nk), action='keep')
            elif arts and not edits:
                s.pair_stats[(r.type, 'FIELD-ARTIFACT')] += 1
                s.put('NEW', r, 'FIELD-ARTIFACT', sub='MASTER-OVERRIDE', cp=s.cp[key], target=hk(r.nk), action='take-r4')
            else:
                s.pair_stats[(r.type, 'GRAVES-EDIT' if not arts else 'GRAVES-EDIT+ARTIFACT')] += 1
                e = s.put('NEW', r, 'MASTER-OVERRIDE', sub='GRAVES-EDIT', cp=s.cp[key], target=hk(r.nk), action='keep')
                if arts:
                    e['restore_fields'] = arts
                    e['action'] = 'keep+restore-r4-fields'
            s.entries[key]['diffs'] = [f'{c}:{t}:{det}'[:160] for c, t, det in d]
            if 'edit' in cats:
                s.three_way(r, s.cp[key])
        for key, e in list(s.entries.items()):
            if key[0] != 'NEW' or e['class'] == 'MASTER-OVERRIDE' or key not in s.cp or e['class'] == 'FIELD-ARTIFACT':
                continue
            r, cp = s.new.by_fid[key[1]][0], s.cp[key]
            d = compare(cp, r, s.canon)
            e['diffs'] = [f'{c}:{t}:{det}'[:160] for c, t, det in d]
            edits = sorted({t or 'flags' for c, t, _ in d if c == 'edit'})
            arts = sorted({t for c, t, _ in d if c == 'artifact'})
            if e['class'] in rekey and e.get('master') or (e['class'] == 'REOWNED'):
                src = 'master' if e.get('subtype') in ('MASTER-DEFINED', 'MASTER-RENUMBERED') else 'r4'
                e['edit'] = 'EDITED' if edits else 'ARTIFACT-ONLY'
                e['content'] = 'NEW' if edits else src.upper()
                e['action'] = 'rekey-new' if edits else f'rekey-{src}'
                if edits and arts:
                    e['restore_fields'] = arts
                    e['action'] = f'rekey-new+restore-{src}-fields'
                if edits:
                    e['edited_fields'] = edits
            elif e['class'] in ('OWN', 'RENUMBERED', 'COLLISION'):
                if e.get('subtype') == 'DOUBLED':
                    continue
                if arts and not edits:
                    e['base_class'], e['class'] = e['class'], 'FIELD-ARTIFACT'
                    e['action'] = 'take-r4'
                elif arts:
                    e['edit'], e['edited_fields'], e['restore_fields'] = 'EDITED', edits, arts
                    e['action'] = 'keep+restore-r4-fields'
                elif edits:
                    e['edit'], e['edited_fields'] = 'EDITED', edits
                if edits:
                    s.three_way(r, cp)

    def three_way(s, r, cp):
        # NEW matching RAW where R4 does not means Graves's copy reverted an r3/r4 patch
        rw = s.raw.one((cp.type,) + cp.nk) if cp.v is s.r4 else None
        if rw is None:
            return
        dn = [x for x in compare(rw, r, s.canon) if x[0] != 'noise']
        d4 = [x for x in compare(rw, cp, s.canon) if x[0] == 'edit']
        if not dn and d4:
            s.reverted.append(f'{r.label()}: NEW equals RAW, R4 differs from RAW in {sorted({t or "flags" for _, t, _ in d4})}')
            e = s.entries.get(('NEW', r.fid))
            if e is not None:
                e['r4_patch'] = 'REVERTED-BY-NEW'

    # ---- phase 7: navmeshes ----
    def navmesh(s, recs):
        s.nav = {'pairs': [], 'nvmi': {}, 'drop': []}
        for key, e in s.entries.items():
            if key[0] != 'NEW' or e['type'] != 'NAVM' or key not in s.cp:
                continue
            r, cp = s.new.by_fid[key[1]][0], s.cp[key]
            if r.sub('NVNM') == cp.sub('NVNM'):
                continue
            ga, gb = nvnm_geometry(cp.sub('NVNM')), nvnm_geometry(r.sub('NVNM'))
            same_geo = ga[2] == gb[2] and ga[3] == gb[3]
            s.nav['pairs'].append(f'{r.label()} vs {cp.v.tag} {cp.fid:08X}: verts {ga[0]}/{gb[0]} tris {ga[1]}/{gb[1]} geometry byte-equal={same_geo}')
            if same_geo:
                if e['class'] == 'MASTER-OVERRIDE' or e['class'] == 'FIELD-ARTIFACT':
                    e.update({'class': 'FIELD-ARTIFACT', 'subtype': 'MASTER-OVERRIDE', 'action': 'take-r4'})
                    e.pop('restore_fields', None)
                else:
                    e.update({'edit': 'ARTIFACT-ONLY', 'content': 'R4', 'action': 'rekey-r4'})
                    e.pop('restore_fields', None)
                    e.pop('edited_fields', None)
                e['note'] = 'vertices and triangle vertex indices byte-equal to R4; only flags, edge and door links changed'
            else:
                s.problems.append(f'{r.label()}: navmesh geometry differs from R4 (Graves navmesh work)')
        navi_n = [r for r in s.new.recs if r.type == 'NAVI']
        for r in navi_n:
            cp = s.cp.get(('NEW', r.fid))
            ka = {hk(s.canon.of(cp.v, u32(v, 0))): v for t, v in cp.subs() if t == 'NVMI'}
            kb = {hk(s.canon.of(r.v, u32(v, 0))): v for t, v in r.subs() if t == 'NVMI'}
            s.nav['nvmi'] = {'r4': len(ka), 'new': len(kb), 'only_r4': sorted(set(ka) - set(kb)), 'only_new': sorted(set(kb) - set(ka)),
                             'changed': sorted(k for k in set(ka) & set(kb) if ka[k] != kb[k])}
            e = s.entries.get(('NEW', r.fid))
            if e is not None:
                e.update({'class': 'FIELD-ARTIFACT', 'subtype': 'MASTER-OVERRIDE', 'action': 'take-r4',
                          'note': f'R4 {len(ka)} NVMI, NEW {len(kb)}; R4 only {len(set(ka) - set(kb))}, NEW only {len(set(kb) - set(ka))}'})
                e.pop('restore_fields', None)
        for r in s.master_new:
            if r.type != 'NAVM':
                continue
            key = ('NAVM',) + r.nk
            chain = s.chains.get(key, [])
            van = next((recs[(p, key)] for p in reversed(chain) if p in ESMS and (p, key) in recs), None)
            gv = nvnm_geometry(van.sub('NVNM')) if van else None
            gb = nvnm_geometry(r.sub('NVNM'))
            winners = [(p, nvnm_geometry(recs[(p, key)].sub('NVNM'))[:2]) for p in chain if (p, key) in recs]
            vanilla = gv is not None and gv[2] == gb[2] and gv[3] == gb[3]
            info = f'NEW verts {gb[0]} tris {gb[1]}; load order {winners}; equals vanilla geometry: {vanilla}'
            s.nav['drop'].append(f'{r.label()}: {info}')
            s.put('NEW', r, 'MASTER-OVERRIDE', sub='DROP' if vanilla else 'NEW', target=hk(r.nk), action='drop' if vanilla else 'keep',
                  note=('vanilla geometry would revert the later plugins\' navmesh; ' if vanilla else '') + info)

    # ---- phase 8: NEW-only master overrides (the city review) ----
    def city_review(s, order, hits, recs):
        s.city_cells, s.city_refs = [], collections.Counter()
        s.forward_masters = collections.Counter()
        lower_masters = {m.lower() for m in s.new.m}
        for r in s.master_new:
            key = (r.type,) + r.nk
            if r.type in REF_TYPES:
                chain = hits.get(key, [])
                mods = [p for p in chain if p.lower() not in lower_masters]
                s.city_refs[(r.type, 'also overridden by a non-master plugin' if mods else 'only masters')] += 1
                s.put('NEW', r, 'MASTER-OVERRIDE', sub='NEW', target=hk(r.nk), action='keep',
                      note=f'other overrides: {mods}' if mods else '')
                continue
            if r.type != 'CELL':
                continue
            chain = hits.get(key, [])
            esm = [p for p in chain if p.lower() in lower_masters]
            vp, pp = (esm[-1] if esm else None), (chain[-1] if chain else None)
            van, pri = recs.get((vp, key)), recs.get((pp, key))
            info = {'cell': hk(r.nk), 'edid': r.edid(), 'fid': f'{r.fid:08X}', 'vanilla': vp, 'prior': pp, 'chain': chain}
            if van is None:
                info.update(decision='KEEP', why='no master record found')
                s.city_cells.append(info)
                s.put('NEW', r, 'MASTER-OVERRIDE', sub='NEW', target=hk(r.nk), action='keep', note='city review: no master record found')
                continue
            def fields(d, cats=('edit', 'artifact')):
                return {t or 'flags' for c, t, _ in d if c in cats}
            dv = compare(van, r, s.canon)
            nv = fields(dv)
            later = pri is not None and pp != vp
            npr = fields(compare(pri, r, s.canon)) if later else nv
            mv = fields(compare(van, pri, s.canon)) if later else set()
            # a field is Graves's only when NEW's value matches no plugin in the chain, masters and mods alike
            per = {p: fields(compare(recs[(p, key)], r, s.canon)) for p in chain if (p, key) in recs}
            mine = set.intersection(*per.values()) if per else nv
            forward = sorted(npr - mine)
            graves = sorted(mine - mv)
            conflict = sorted(mine & mv)
            carried = {t: [p for p in chain if t not in per.get(p, {t})] for t in sorted(nv - mine)}
            info.update(graves_fields=graves + conflict, mod_fields=sorted(mv), carried_fields=carried,
                        graves_diffs=[f'{c}:{t}:{d}'[:120] for c, t, d in dv if c != 'noise' and (t or 'flags') in mine])
            if not later:
                info['decision'], info['why'] = 'KEEP', 'no later plugin changes the cell'
            elif not npr:
                info['decision'], info['why'] = 'KEEP', 'NEW already equals the prior winner apart from CK noise'
            elif not graves and not conflict:
                src = ', '.join(f'{t} from {carried[t]}' if t in carried else f'{t} vanilla' for t in forward)
                info['decision'], info['why'] = 'FORWARD', f'NEW differs from {pp} only where it keeps an earlier plugin\'s value ({src}); forward the prior winner, keep NEW\'s children'
                info['forward_fields'] = 'all'
            elif not forward and not conflict:
                info['decision'], info['why'] = 'KEEP', f'Graves edited {graves}, which {pp} leaves vanilla; nothing to forward'
                info['keep_new_fields'] = graves
            else:
                info['decision'] = 'CONFLICT' if conflict else 'MERGE'
                info['why'] = (f'Graves and {pp} both changed {conflict}; keep NEW there') if conflict else f'Graves edited {graves}, which {pp} leaves vanilla'
                info['keep_new_fields'] = graves + conflict
                info['forward_fields'] = forward
            if info['decision'] in ('FORWARD', 'MERGE', 'CONFLICT') and pri is not None:
                fw = None if info.get('forward_fields') == 'all' else set(info['forward_fields'])
                for t, v in pri.subs():
                    lay = layout('CELL', t)
                    if not lay or (fw is not None and t not in fw):
                        continue
                    for fids, _ in entries([v], lay, pri, s.canon, []):
                        for c in fids:
                            if c[0] and c[0].lower() not in lower_masters and c[0] != 'SELF':
                                info.setdefault('extra_masters', set()).add(c[0])
                info['extra_masters'] = sorted(info.get('extra_masters', []))
                for m in info['extra_masters']:
                    s.forward_masters[m] += 1
            s.city_cells.append(info)
            action = {'KEEP': 'keep', 'FORWARD': 'forward-prior', 'MERGE': 'merge-prior-fields', 'CONFLICT': 'merge-prior-fields'}[info['decision']]
            s.put('NEW', r, 'MASTER-OVERRIDE', sub='NEW-CELL', target=hk(r.nk), action=action,
                  note=f'city review {info["decision"]}: {info["why"]}')

    def later_overrides(s, hits):
        for key, e in s.entries.items():
            if key[0] != 'NEW' or not e.get('master') or not e.get('target'):
                continue
            loc = int(e['target'].split(':')[1], 16)
            chain = hits.get((e['type'], e['master'], loc), [])
            later = [p for p in chain if p != e['master']]
            if later:
                e['later_overrides'] = later

    # ---- checks ----
    def index_scan(s):
        # form ids that use a raw index between the master count and the own index
        hits = []
        for r in s.new.recs:
            for t, v in r.subs():
                lay = layout(r.type, t)
                vals = []
                if lay:
                    size, slots, _ = lay
                    n = size or len(v)
                    vals = [u32(v, i + o) for i in range(0, max(len(v) - n + 1, 1), n) for o in slots if i + o + 4 <= len(v)]
                elif t == 'VMAD':
                    try:
                        sc, _ = vmad_scripts(v)
                        vals = [f for _, _, pr in sc for p in pr for f in flat_objs(p[3])]
                    except (ValueError, struct.error, IndexError):
                        vals = []
                elif t == 'NVNM':
                    links = nvnm_links(v)
                    if links is None:
                        hits.append(f'{r.label()} NVNM could not be decoded')
                    else:
                        vals = links[0] + links[1]
                elif t == 'NVMI':
                    vals = [u32(v, 0)]
                for f in vals:
                    if 8 <= (f >> 24) < NEW_OWN:
                        hits.append(f'{r.label()} {t} -> {f:08X}')
        return hits


# ---------------------------------------------------------------------------------------------------------------------
def prior_reconcile(at, new, r4):
    # record-level reconciliation with the two earlier diff reports (their pickled pairing results)
    out, bad = {}, []
    pdir = R7 + 'prior/'
    try:
        m = pickle.load(open(pdir + 'match.pkl', 'rb'))
        p = pickle.load(open(pdir + 'paired.pkl', 'rb'))
    except OSError as ex:
        return {'error': str(ex)}, [f'prior reports missing: {ex}']
    out['sha256'] = {f: sha_file(pdir + f) for f in ('match.pkl', 'paired.pkl')}
    lower = {x.lower(): x for x in r4.m + new.m}

    def nfid(k):
        t, o, loc, occ = k
        if o.startswith('?'):
            return (int(o[1:], 16) << 24) | loc
        return (new.m.index(lower[o]) << 24) | loc

    def rfid(k):
        t, o, loc, occ = k
        return ((len(r4.m) if o == 'SELF' else r4.m.index(lower[o])) << 24) | loc

    def ncls(k):
        f = nfid(k)
        e = at.entries.get(('NEW', f))
        if e is None:
            if (f >> 24) < 8 and f in new.by_fid:
                return 'MASTER-OVERRIDE/IDENTICAL-or-noise'
            bad.append(f'prior NEW key {k} has no record')
            return 'NONE'
        return e['class'] + ('/' + e['subtype'] if e.get('subtype') else '')

    def rcls(k):
        f = rfid(k)
        e = at.entries.get(('R4', f))
        if e:
            return e['class'] + ('/' + e['subtype'] if e.get('subtype') else '')
        if f in at.r4taken:
            return 'paired:' + at.r4taken[f]
        bad.append(f'prior R4 key {k} unaccounted')
        return 'NONE'

    reown = collections.Counter()
    for a, b in p['pairs'].items():
        if a != b and lower.get(b[1]) in at.dropped:
            reown[(a[0], ncls(a))] += 1
    out['prior_reowned_pairs'] = {f'{t} as {c}': n for (t, c), n in sorted(reown.items())}
    out['prior_reowned_total'] = sum(reown.values())
    out['prior_renumbered'] = dict(collections.Counter(f'{a[0]} as {ncls(a)} ({"same id" if a[2] == b[2] else "new id"})' for a, b in m['renum']))
    out['prior_genuine_add'] = dict(collections.Counter(f'{k[0]} {("own" if k[1].startswith("?") else k[1])} as {ncls(k)}' for k in m['genuine_add']))
    out['prior_genuine_rem'] = dict(collections.Counter(f'{k[0]} as {rcls(k)}' for k in m['genuine_rem']))
    return out, bad


def main():
    bufs = {t: read_input(t) for t in ('NEW', 'R4', 'RAW')}
    new = View('NEW', bufs['NEW'], own=NEW_OWN)
    r4 = View('R4', bufs['R4'])
    raw = View('RAW', bufs['RAW'])
    assert r4.m == raw.m, 'R4 and RAW master lists differ'
    dropped = [m for m in r4.m if m not in new.m]
    added_masters = [m for m in new.m if m not in r4.m]
    data_dir, order = live_load_order()
    before = order[:order.index(SELF)]
    spell = {m.lower(): m for m in dropped}
    srcs = [spell.get(p.lower(), p) for p in before if p.lower() not in {m.lower() for m in new.m}]
    assert set(dropped) <= set(srcs), 'a dropped master does not load before AlduinakAdditions'
    dm, dm_sha = {}, {}
    for m in srcs:
        b = open(STAGE + m, 'rb').read()
        dm_sha[m] = sha_bytes(b)
        dm[m] = View(m, b, name=m)
    origin = {m: {} for m in srcs}
    for m, v in dm.items():
        for r in v.recs:
            if (r.fid >> 24) == v.n:
                origin[m][(r.type, r.fid & 0xFFFFFF)] = r
    canon = Canon(new, dropped, {m: origin[m] for m in dropped})
    at = Attr(new, r4, raw, dm, origin, dropped, canon, srcs)
    at.order = order
    at.cells()
    at.others()
    at.refs()
    at.collision_survivors()
    at.masters_pairs()
    at.r4_missing()

    want = {(r.type,) + r.nk for r in at.master_new}
    want |= {(e['type'], e['master'], int(e['target'].split(':')[1], 16)) for e in at.entries.values() if e.get('master') and e.get('target')}
    want |= {('NAVM', 'Skyrim.esm', x) for x in PLAN['skyrim_navm'] + [PLAN['drop_navm']]}
    hits, recs = city.scan(order, want, keep={'CELL', 'NAVM'})
    at.chains = hits
    at.decide()
    at.navmesh(recs)
    at.city_review(order, hits, recs)
    at.later_overrides(hits)
    idx = at.index_scan()
    prior, prior_bad = prior_reconcile(at, new, r4)
    report(at, new, r4, raw, dropped, added_masters, dm_sha, idx, prior, prior_bad)


def report(at, new, r4, raw, dropped, added_masters, dm_sha, idx, prior, prior_bad):
    E = at.entries
    ents = sorted(E.values(), key=lambda e: (e['src'], e['type'], e['fid']))
    own_new = [e for (src, f), e in E.items() if src == 'NEW' and (f >> 24) == NEW_OWN]
    c_own = collections.Counter(e['class'] for e in own_new)
    c_r4 = collections.Counter(e['class'] for (src, f), e in E.items() if src == 'R4')
    mp = collections.Counter(f'{e["type"]} {e["class"]}/{e.get("subtype", "")}' for (src, f), e in E.items() if src == 'NEW' and (f >> 24) < 8)
    for (t, k), n in at.pair_stats.items():
        if k == 'IDENTICAL':
            mp[f'{t} IDENTICAL'] += n
    checks, fails = [], []

    def check(name, ok, detail=''):
        checks.append(f'{"OK  " if ok else "FAIL"} {name}' + (f': {detail}' if detail else ''))
        if not ok:
            fails.append(name)

    check('every NEW own-index record classified once', len(own_new) == len(at.own) == PLAN['own'], f'{len(own_new)} of {len(at.own)} (plan {PLAN["own"]})')
    master_entries = sum(1 for (src, f), e in E.items() if src == 'NEW' and (f >> 24) < 8)
    check('every NEW record accounted', len(at.own) + len(at.master_pairs) + len(at.master_new) == len(new.recs),
          f'{len(at.own)} own + {len(at.master_pairs)} master pairs + {len(at.master_new)} master-only = {len(new.recs)}')
    r4_entries = {f for (src, f), e in E.items() if src == 'R4'}
    check('every R4 record paired or classified', set(at.r4taken) | r4_entries == {x.fid for x in r4.recs} and
          not (r4_entries - {f for f, w in at.r4taken.items() if w == 'collision-loser'}) & set(at.r4taken),
          f'{len(at.r4taken)} paired or consumed, {len(r4_entries)} R4 entries, R4 has {len(r4.recs)}')
    check('no unclassified record', not at.unclassified, '; '.join(at.unclassified[:10]))

    re_r4 = collections.Counter(e['type'] for e in E.values() if e['src'] == 'NEW' and e.get('master') and e.get('subtype') != 'MASTER-DEFINED')
    prior_reown = prior.get('prior_reowned_pairs', {})
    pr_by_type = collections.Counter()
    for k, n in prior_reown.items():
        pr_by_type[k.split(' ')[0]] += n
    check('873 re-owned records reconcile with the prior pairing', prior.get('prior_reowned_total') == PLAN['reowned_total'],
          f'prior pairing {prior.get("prior_reowned_total")} = {dict(pr_by_type)}; the plan\'s 358 COBJ is 359 in the report it quotes')
    same_slots = sorted(at.same_type_slots)
    check('11 collision slots', same_slots == PLAN['collision_slots'], ' '.join(f'{x:06X}' for x in same_slots))
    ren_cells = {int(e['note'].split()[2], 16): int(e['fid'], 16) & 0xFFFFFF for e in E.values() if e['class'] == 'RENUMBERED' and e['type'] == 'CELL'}
    check('5 renumbered cells', ren_cells == PLAN['renumbered_cells'], str({f'{a:X}': f'{b:X}' for a, b in ren_cells.items()}))
    broken = [e['fid'] for e in E.values() if e['class'] == 'BROKEN']
    check('one broken ref 0E04B2AB', broken == [f'{PLAN["broken"]:08X}'], str(broken))
    lost = [e for e in E.values() if e['class'] == 'LOST']
    lost_ovr = [e for e in lost if e['type'] != 'NAVM']
    loser_lost = [e for e in E.values() if e.get('subtype') == 'LOSER-LOST']
    reused = [e for e in lost_ovr if 'NEW reuses id' in e.get('note', '')]
    check('lost overrides reconcile with the plan\'s 111', len(lost_ovr) + len(loser_lost) - len(reused) == PLAN['lost'],
          f'{len(lost_ovr)} LOST + {len(loser_lost)} collision loser - {len(reused)} whose id NEW reuses for another ref (the prior pairing paired those) = {len(lost_ovr) + len(loser_lost) - len(reused)}')
    check('LOST NAVM 090C434A', [e['fid'] for e in lost if e['type'] == 'NAVM'] == [f'{PLAN["lost_navm"]:08X}'])
    nv = at.nav.get('nvmi', {})
    wb_only = [k for k in nv.get('only_r4', []) if k.startswith('Warbirds')]
    check('14 Warbirds NVMI only in R4', len(wb_only) == PLAN['lost_nvmi'], f'R4-only NVMI {nv.get("only_r4")}; NEW-only {nv.get("only_new")}')
    gone_own = [x for x in r4.recs if x.nk[0] == SELF and not any(r.type == x.type for r in new.by_fid.get((NEW_OWN << 24) | (x.fid & 0xFFFFFF), []))]
    ren_of_gone = sum(1 for x in gone_own if at.r4taken.get(x.fid) == 'renumbered')
    removed = sorted(e['fid'][2:] for e in E.values() if e['class'] == 'GRAVES-REMOVED')
    check('312 own ids absent from NEW under their id', len(gone_own) == PLAN['removed_own'],
          f'{len(gone_own)} = {ren_of_gone} renumbered by the CK + {len(gone_own) - ren_of_gone} removed ({removed})')
    check('Graves removed exactly the 5 Windhelm LAND', removed == [f'{x:06X}' for x in PLAN['removed_land']], str(removed))
    ci = collections.defaultdict(list)
    for e in E.values():
        if e['type'] == 'CELL' and e.get('master') and e['src'] == 'NEW':
            ci[e['master']].append(int(e['target'].split(':')[1], 16))
    check('12 copied interiors re-owned', {k: sorted(v) for k, v in ci.items()} == PLAN['copied_interiors'], str({k: [f'{x:06X}' for x in sorted(v)] for k, v in ci.items()}))
    new_cells = [e for e in E.values() if e.get('subtype') == 'NEW-CELL' and e.get('target', '').startswith('Skyrim.esm')]
    check('84 new Skyrim CELL overrides reviewed', len(new_cells) == PLAN['new_cells'], str(len(new_cells)))
    cr = collections.Counter()
    for (t, k), n in at.city_refs.items():
        if t in ('REFR', 'ACHR'):
            cr[t] += n
    check('304 REFR and 30 ACHR new Skyrim overrides reviewed', cr.get('REFR', 0) - 3 == PLAN['city_refs']['REFR'] and cr.get('ACHR', 0) == PLAN['city_refs']['ACHR'],
          f'{dict(at.city_refs)} (REFR includes 2 Lux Via and 1 Update.esm)')
    check('449 own refs settled record by record', at.q449_total == PLAN['q449'] and sum(at.q449.values()) == at.q449_total and at.q449 == PLAN['q449_split'],
          str(dict(at.q449)))
    ren_mod = sorted(int(e['fid'], 16) & 0xFFFFFF for e in E.values() if e.get('subtype') == 'MASTER-RENUMBERED')
    block = sorted(int(e['fid'], 16) & 0xFFFFFF for e in E.values()
                   if e['src'] == 'NEW' and (e['class'] == 'RENUMBERED' or e.get('subtype') in ('RENUMBERED', 'LOSER-RENUMBERED')))
    past = [x for x in ren_mod if x > block[-1]]
    check('renumbered plugin refs continue the CK renumber block', all(x >= block[0] for x in ren_mod) and past == list(range(block[-1] + 1, block[-1] + 1 + len(past))),
          f'{" ".join(f"{x:06X}" for x in ren_mod)}; block of R4 records the CK renumbered {block[0]:06X}..{block[-1]:06X}')
    tg = collections.Counter(e['target'] for e in E.values() if e['src'] == 'NEW' and e.get('master'))
    check('no two NEW records re-own the same target', all(n == 1 for n in tg.values()), str([t for t, n in tg.items() if n > 1]))
    pos = {p.lower(): i for i, p in enumerate(at.order)}
    reown_m = {e['master'] for e in E.values() if e['src'] == 'NEW' and e.get('master')}
    beyond = sorted((set(new.m) | reown_m | set(at.forward_masters)) - set(r4.m), key=lambda m: pos.get(m.lower(), 999))
    check('every master the merge adds loads before AlduinakAdditions', all(pos.get(m.lower(), 999) < pos[SELF.lower()] for m in beyond),
          ', '.join(f'{m} ({pos.get(m.lower())})' for m in beyond))
    check('prior report keys all map to classified records', not prior_bad, '; '.join(prior_bad[:5]))
    fa9 = sorted(int(e['fid'], 16) & 0xFFFFFF for e in E.values() if e['type'] == 'NAVM' and e['class'] == 'FIELD-ARTIFACT')
    check('9 Skyrim NAVM take R4', fa9 == sorted(PLAN['skyrim_navm']), ' '.join(f'{x:06X}' for x in fa9))
    drop = [e for e in E.values() if e.get('action') == 'drop']
    check('NAVM 0EA093 dropped', [int(e['fid'], 16) & 0xFFFFFF for e in drop] == [PLAN['drop_navm']], str([e.get('note') for e in drop]))
    xl = sorted(int(e['fid'], 16) & 0xFFFFFF for e in E.values() if e['type'] == 'CELL' and e['class'] == 'FIELD-ARTIFACT'
                and e.get('target', '').startswith('Skyrim.esm'))
    check('XLCN field artifacts on the 4 Skyrim cells', xl == PLAN['xlcn_cells'], ' '.join(f'{x:06X}' for x in xl))
    check('no navmesh geometry edits', not at.problems, '; '.join(at.problems))

    remap = {f'{SELF}:{loc:06X}': f'{sorted(ms)[0]}:{loc:06X}' for loc, ms in at.canon.selfq_seen.items()}
    renum = {f'{xl:06X}': f'{loc:06X}' for loc, (o, xl) in at.canon.selfmap.items() if o == 'SELF' and loc != xl}
    rekey_map = {f'{SELF}:{loc:06X}': f'{o}:{xl:06X}' for loc, (o, xl) in at.canon.selfmap.items() if o not in ('SELF', 'BROKEN')}
    retired = sorted({e['fid'][2:] for e in E.values() if e['src'] == 'R4' and e['class'] == 'GRAVES-REMOVED'} | set(renum) |
                     {e['fid'][2:] for e in E.values() if e.get('subtype') == 'MASTER-RENUMBERED'})
    ren_cells_r4 = sorted(k for k, v in renum.items() if any(e['type'] == 'CELL' and e['fid'][2:] == v for e in E.values() if e['src'] == 'NEW'))
    changeform_query = {'worldOrCellDesc': [f'{int(x, 16):x}:{SELF}' for x in ren_cells_r4],
                        'formDesc': [f'{int(x, 16):x}:{SELF}' for x in retired + [f'{PLAN["broken"] & 0xFFFFFF:06X}']]}
    owner_review = [f'{e["fid"]} {e.get("edid", "")}: {e.get("note", "")}' for e in ents if e.get('subtype') == 'DOUBLED']
    mod_masters = sorted({e['master'] for e in E.values() if e['src'] == 'NEW' and e.get('master')} - set(r4.m) - set(new.m))
    if mod_masters:
        owner_review.append(f're-owning Graves\'s overrides of plugins that are not R4 masters adds masters {mod_masters}: '
                            + '; '.join(f'{e["fid"]} -> {e["target"]}' for e in ents if e.get('master') in mod_masters))
    owner_review += [f'{c["cell"]} {c["edid"]}: {c["why"]}' for c in at.city_cells if c['decision'] == 'CONFLICT']
    owner_review += [f'city cell {c["cell"]} {c["edid"]}: Graves edited {c["graves_fields"]} ({c["decision"]})' for c in at.city_cells
                     if c.get('graves_fields') and c['decision'] != 'CONFLICT']
    if idx:
        owner_review.append(f'{len(idx)} form ids use raw indices 08-0D (step 2a assumes only 0E04B2AB NAME): {idx}')

    doc = {
        'generated_by': 'misc/esp-merge/attribute.py', 'plan': 'reports/r7-esp-merge-plan.md step 1',
        'inputs': {t: {'path': INPUTS[t][0], 'sha256': INPUTS[t][1]} for t in ('NEW', 'R4', 'RAW')},
        'dropped_masters': {m: dm_sha[m] for m in dropped}, 'searched_plugins': {m: h for m, h in dm_sha.items() if m not in dropped},
        'added_masters': added_masters, 'new_masters': new.m,
        'counts': {'new_own': dict(c_own), 'r4_missing': dict(c_r4),
                   'reowned_by_type': dict(collections.Counter(e['type'] for e in own_new if e.get('master'))),
                   'reowned_edit': dict(collections.Counter(f'{e["type"]} {e.get("edit")}' for e in own_new if e.get('master'))),
                   'master_records': dict(mp),
                   'q449': dict(at.q449), 'actions': dict(collections.Counter(e.get('action', '') for e in ents))},
        'checks': checks, 'failed': fails, 'unclassified': at.unclassified,
        'prior_reconcile': prior, 'owner_review': owner_review, 'index_08_0D': idx,
        'reverted_r4_patches': at.reverted, 'navmesh': at.nav,
        'city_cells': [{k: v for k, v in c.items()} for c in at.city_cells], 'city_refs': {f'{t} {k}': n for (t, k), n in at.city_refs.items()},
        'city_cells_graves_edited': [f'{c["cell"]} {c["edid"]!r} {c["decision"]}: {c["graves_fields"]}' for c in at.city_cells if c.get('graves_fields')],
        'forward_extra_masters': dict(at.forward_masters),
        'q449_records': [f'{f:08X} {e["class"]}/{e.get("subtype", "")} {e.get("master", "")} {e.get("action", "")}: {e.get("note", "")}'
                         for f, e in ((f, E.get(('NEW', f), {'class': 'UNCLASSIFIED'})) for f in at.q449_fids)],
        'rekey_map': rekey_map, 'dangling_self_links': remap, 'renumber_map_r4_to_new': renum, 'retired_own_ids': retired,
        'changeform_query': changeform_query, 'masters_beyond_r4': beyond,
        'collision_slots_all': {f'{k:06X}': [f'{x.nk[0]} {x.type} {x.fid:08X}' for x in v] for k, v in sorted(at.collide.items())},
        'entries': ents,
    }
    with open(R7 + 'attribution.json', 'w', encoding='utf-8') as f:
        json.dump(doc, f, indent=1, default=sorted)
    write_text(doc, at, ents)
    untouched = assert_untouched()
    print('\n'.join(checks))
    print('\n'.join(untouched))
    print(f'wrote {R7}attribution.json ({sha_file(R7 + "attribution.json")[:8]}) and attribution.txt')
    sys.exit(2 if fails else 0)


def write_text(doc, at, ents):
    L = ['r7 attribution manifest (step 1)', '']
    L += [f'{k}: {v["path"]} {v["sha256"][:8]}' for k, v in doc['inputs'].items()]
    L += ['', 'CHECKS'] + doc['checks'] + ['', 'COUNTS']
    for k, v in doc['counts'].items():
        L.append(f'{k}:')
        L += [f'  {n:6d}  {c}' for c, n in sorted(v.items(), key=lambda z: (-z[1], str(z[0])))]
    L += ['', 'PRIOR REPORTS (record-level reconciliation)']
    for k, v in doc['prior_reconcile'].items():
        L.append(f'{k}:')
        if isinstance(v, dict):
            L += [f'  {n}  {c}' for c, n in sorted(v.items(), key=lambda z: -z[1] if isinstance(z[1], int) else 0)]
        else:
            L.append(f'  {v}')
    L += ['', 'OWNER REVIEW'] + [f'  {x}' for x in doc['owner_review']]
    L += ['', 'R4 PATCHES NEW REVERTED (NEW equals RAW)'] + [f'  {x}' for x in doc['reverted_r4_patches']]
    L += ['', 'NAVMESH'] + [f'  {x}' for x in doc['navmesh']['pairs'] + doc['navmesh']['drop']] + [f'  NVMI {doc["navmesh"]["nvmi"]}']
    L += ['', 'CITY CELLS (84 Skyrim + Lux Via; a field is Graves\'s only when NEW\'s value is in no plugin of the chain)']
    for c in doc['city_cells']:
        L.append(f'  {c["decision"]:8s} {c["cell"]} {c["edid"]!r} prior={c["prior"]} graves={c.get("graves_fields")} mod={c.get("mod_fields")}'
                 + (f' carried={c["carried_fields"]}' if c.get('carried_fields') else '')
                 + (f' forward={c.get("forward_fields")}' if c.get('forward_fields') else '') + (f' masters+={c["extra_masters"]}' if c.get('extra_masters') else ''))
    L.append(f'  cells Graves edited: {doc["city_cells_graves_edited"] or "none"}')
    L += ['  city refs: ' + str(doc['city_refs']), '  extra masters from forwarding: ' + str(doc['forward_extra_masters'])]
    L += ['', f'THE {len(doc["q449_records"])} OWN REFS WITH NO R4 RECORD UNDER THEIR ID (new, doubled or re-owned, record by record)']
    L += [f'  {x}' for x in doc['q449_records']]
    L += ['', 'ENTRIES (not identical to their counterpart)']
    for e in ents:
        if e['class'] == 'MASTER-OVERRIDE' and e.get('subtype') == 'CK-NOISE':
            continue
        if e['class'] in ('OWN', 'RENUMBERED') and not e.get('diffs') and not e.get('note') and not e.get('subtype'):
            continue
        extra = ' '.join(f'{k}={e[k]}' for k in ('subtype', 'master', 'edit', 'action', 'target', 'counterpart', 'cell') if e.get(k))
        L.append(f'{e["src"]} {e["type"]} {e["fid"]} {e.get("edid", "")!r} {e["class"]} {extra}')
        if e.get('note'):
            L.append(f'      note: {e["note"]}')
        for d in [x for x in e.get('diffs', []) if not x.startswith('noise')][:6]:
            L.append(f'      {d}')
    with open(R7 + 'attribution.txt', 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')


if __name__ == '__main__':
    main()
