# Fast read-only plugin walker: record headers with group path, lazy subrecord decode.
import struct, zlib

DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'


def subs_of(data):
    out, i, big = [], 0, None
    while i + 6 <= len(data):
        t = data[i:i + 4].decode('latin1')
        sz = struct.unpack_from('<H', data, i + 4)[0]
        i += 6
        if t == 'XXXX':
            big = struct.unpack_from('<I', data, i)[0]
            i += sz
            continue
        if big is not None:
            sz, big = big, None
        out.append((t, data[i:i + sz]))
        i += sz
    return out


class Rec:
    __slots__ = ('type', 'fid', 'flags', 'off', 'size', 'path', 'buf', '_subs')

    def __init__(self, buf, t, fid, flags, off, size, path):
        self.buf, self.type, self.fid, self.flags, self.off, self.size, self.path = buf, t, fid, flags, off, size, path
        self._subs = None

    def data(self):
        d = self.buf[self.off + 24:self.off + 24 + self.size]
        if self.flags & 0x40000:
            d = zlib.decompress(d[4:])
        return d

    def subs(self):
        if self._subs is None:
            self._subs = subs_of(self.data())
        return self._subs

    def sub(self, name):
        for t, v in self.subs():
            if t == name:
                return v
        return None

    def all(self, name):
        return [v for t, v in self.subs() if t == name]

    def edid(self):
        v = self.sub('EDID')
        return v.split(b'\0')[0].decode('latin1') if v else ''

    def cell(self):
        for g, l in reversed(self.path):
            if g in (6, 8, 9, 10):
                return l
        return None


def load(path, types=None):
    buf = open(path, 'rb').read()
    hsz = struct.unpack_from('<I', buf, 4)[0]
    hflags = struct.unpack_from('<I', buf, 8)[0]
    masters = [v.split(b'\0')[0].decode('latin1') for t, v in subs_of(buf[24:24 + hsz]) if t == 'MAST']
    recs = []
    stack = []
    i = 24 + hsz
    while i < len(buf):
        while stack and i >= stack[-1][0]:
            stack.pop()
        t = buf[i:i + 4]
        sz = struct.unpack_from('<I', buf, i + 4)[0]
        if t == b'GRUP':
            label = struct.unpack_from('<I', buf, i + 8)[0]
            gt = struct.unpack_from('<i', buf, i + 12)[0]
            stack.append((i + sz, gt, label))
            i += 24
            continue
        tn = t.decode('latin1')
        if types is None or tn in types:
            fl, fid = struct.unpack_from('<II', buf, i + 8)
            recs.append(Rec(buf, tn, fid, fl, i, sz, tuple((g, l) for _, g, l in stack)))
        i += 24 + sz
    return dict(buf=buf, masters=masters, recs=recs, hflags=hflags, name=path.replace('\\', '/').split('/')[-1])


def origin_index(pl):
    # (objid) -> Rec for records that originate in this plugin (index == master count, or >= for tolerance)
    n = len(pl['masters'])
    out = {}
    for r in pl['recs']:
        if (r.fid >> 24) >= n:
            out[r.fid & 0xFFFFFF] = r
    return out
