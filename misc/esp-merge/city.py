# Load-order scan for the r7 attribution: which plugins carry a record, and detached copies of the ones to compare.
import collections
import functools
import struct
import zlib

import fastesp
from r7lib import SELF, STAGE

LOCALIZED = 0x80


class HView:
    # master-list view of one load-order plugin, enough for form id normalisation
    def __init__(self, name, masters, localized):
        self.tag = self.name = name
        self.m, self.n, self.own = masters, len(masters), len(masters)
        self.localized = localized

    def owner(self, idx):
        if idx < self.n:
            return self.m[idx]
        return self.name if idx == self.own else None

    def nk(self, fid):
        o = self.owner(fid >> 24)
        return (o if o is not None else '?%02X' % (fid >> 24), fid & 0xFFFFFF)


class HRec:
    # detached record shaped like attribute.R for compare()
    __slots__ = ('v', 'type', 'fid', 'flags', 'data', '_subs', 'nk')

    def __init__(self, v, t, fid, flags, data):
        self.v, self.type, self.fid, self.flags, self.data = v, t, fid, flags, data
        self._subs = None
        self.nk = v.nk(fid)

    def subs(self):
        if self._subs is None:
            self._subs = fastesp.subs_of(self.data)
        return self._subs

    def sub(self, t):
        for a, b in self.subs():
            if a == t:
                return b
        return None

    def edid(self):
        v = self.sub('EDID')
        return v.split(b'\0')[0].decode('latin1') if v else ''

    def label(self):
        return f'{self.v.name} {self.type} {self.fid:08X}' + (f' "{self.edid()}"' if self.edid() else '')


def records(name):
    # every record header of a staged plugin as (view, type, form id, flags, data offset, size, buffer)
    buf = open(STAGE + name, 'rb').read()
    hsz, hflags = struct.unpack_from('<II', buf, 4)
    masters = [v.split(b'\0')[0].decode('latin1') for t, v in fastesp.subs_of(buf[24:24 + hsz]) if t == 'MAST']
    v = HView(name, masters, bool(hflags & LOCALIZED))
    i, end = 24 + hsz, len(buf)
    while i < end:
        t = buf[i:i + 4]
        if t == b'GRUP':
            i += 24
            continue
        sz, fl, fid = struct.unpack_from('<III', buf, i + 4)
        yield v, t, fid, fl, i + 24, sz, buf
        i += 24 + sz


def hrec(v, t, fid, fl, o, sz, buf):
    d = buf[o:o + sz]
    return HRec(v, t.decode('latin1'), fid, fl, zlib.decompress(d[4:]) if fl & 0x40000 else bytes(d))


def scan(order, want, keep):
    # want: set of (type, owner, local) keys; returns {key: [plugins in load order]} and {(plugin, key): HRec} for types in keep
    hits, recs = collections.defaultdict(list), {}
    types = {k[0].encode('latin1') for k in want}
    lwant = {(k[0], k[1].lower(), k[2]): k for k in want}
    for name in order:
        if name == SELF:
            break
        for v, t, fid, fl, o, sz, buf in records(name):
            if t not in types:
                continue
            tn = t.decode('latin1')
            ow = v.owner(fid >> 24)
            key = lwant.get((tn, ow.lower() if ow else '', fid & 0xFFFFFF))
            if key is not None:
                hits[key].append(name)
                if tn in keep:
                    recs[(name, key)] = hrec(v, t, fid, fl, o, sz, buf)
    return hits, recs


@functools.lru_cache(maxsize=None)
def own_ids(name):
    # local ids a plugin defines at its own index
    return frozenset(fid & 0xFFFFFF for v, t, fid, *_ in records(name) if (fid >> 24) == v.n)


def carriers(order, keys):
    # (owner, local) -> [(plugin, type, editor id)] for every plugin before AlduinakAdditions that writes that form id
    lk = {(o.lower(), loc): (o, loc) for o, loc in keys}
    out = collections.defaultdict(list)
    for name in order:
        if name == SELF:
            break
        for v, t, fid, fl, o, sz, buf in records(name):
            ow = v.owner(fid >> 24)
            k = lk.get((ow.lower() if ow else '', fid & 0xFFFFFF))
            if k is not None:
                out[k].append((name, t.decode('latin1'), hrec(v, t, fid, fl, o, sz, buf).edid()))
    return out


def read_strings(path):
    d = open(path, 'rb').read()
    count = struct.unpack_from('<I', d, 0)[0]
    base = 8 + count * 8
    out = {}
    for i in range(count):
        sid, off = struct.unpack_from('<II', d, 8 + i * 8)
        out[sid] = d[base + off:d.index(b'\0', base + off)]
    return out
