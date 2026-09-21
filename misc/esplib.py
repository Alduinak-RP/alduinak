# Lossless TES5/SSE plugin reader and writer: unmodified records and groups serialize to their original bytes.
import struct
import zlib

HDR = struct.Struct('<4sIIIIHH')
GHDR = struct.Struct('<4sI4siIHH')
COMPRESSED = 0x00040000


def parse_subs(data):
    out, i, big = [], 0, None
    while i < len(data):
        if i + 6 > len(data):
            raise ValueError(f'trailing {len(data) - i} bytes in subrecord area')
        t = data[i:i + 4].decode('latin1')
        sz = struct.unpack_from('<H', data, i + 4)[0]
        i += 6
        if t == 'XXXX':
            big = struct.unpack_from('<I', data, i)[0]
            i += sz
            continue
        if big is not None:
            sz, big = big, None
        if i + sz > len(data):
            raise ValueError(f'subrecord {t} size {sz} overruns record')
        out.append((t, data[i:i + sz]))
        i += sz
    return out


def encode_subs(subs):
    parts = []
    for t, v in subs:
        if len(v) > 0xFFFF:
            parts.append(b'XXXX' + struct.pack('<HI', 4, len(v)))
            parts.append(t.encode('latin1') + struct.pack('<H', 0) + v)
        else:
            parts.append(t.encode('latin1') + struct.pack('<H', len(v)) + v)
    return b''.join(parts)


class Record:
    def __init__(self, hdr, raw):
        self.hdr = bytearray(hdr)
        self.raw = raw
        self._data = None
        self.new_raw = None

    @property
    def type(self):
        return bytes(self.hdr[0:4]).decode('latin1')

    @property
    def flags(self):
        return struct.unpack_from('<I', self.hdr, 8)[0]

    @flags.setter
    def flags(self, v):
        struct.pack_into('<I', self.hdr, 8, v)

    @property
    def fid(self):
        return struct.unpack_from('<I', self.hdr, 12)[0]

    @property
    def compressed(self):
        return bool(self.flags & COMPRESSED)

    def data(self):
        if self._data is None:
            raw = self.new_raw if self.new_raw is not None else self.raw
            if self.compressed:
                want = struct.unpack_from('<I', raw, 0)[0]
                d = zlib.decompress(raw[4:])
                if len(d) != want:
                    raise ValueError(f'{self.type} {self.fid:08X}: inflated {len(d)} != {want}')
                self._data = d
            else:
                self._data = bytes(raw)
        return self._data

    def subs(self):
        return parse_subs(self.data())

    def set_subs(self, subs):
        body = encode_subs(subs)
        self._data = body
        self.new_raw = struct.pack('<I', len(body)) + zlib.compress(body) if self.compressed else body

    def serialize(self):
        raw = self.new_raw if self.new_raw is not None else self.raw
        struct.pack_into('<I', self.hdr, 4, len(raw))
        return bytes(self.hdr) + bytes(raw)


class Group:
    def __init__(self, hdr, children):
        self.hdr = bytearray(hdr)
        self.children = children

    @property
    def gtype(self):
        return struct.unpack_from('<i', self.hdr, 12)[0]

    @property
    def label(self):
        return struct.unpack_from('<I', self.hdr, 8)[0]

    @property
    def label_str(self):
        return bytes(self.hdr[8:12]).decode('latin1')

    def serialize(self):
        body = b''.join(c.serialize() for c in self.children)
        struct.pack_into('<I', self.hdr, 4, 24 + len(body))
        return bytes(self.hdr) + body


def _walk(buf, start, end):
    out = []
    i = start
    while i < end:
        if i + 24 > end:
            raise ValueError(f'@{i:#x}: truncated header before {end:#x}')
        t = buf[i:i + 4]
        sz = struct.unpack_from('<I', buf, i + 4)[0]
        if t == b'GRUP':
            if sz < 24 or i + sz > end:
                raise ValueError(f'@{i:#x}: GRUP size {sz} overruns {end:#x}')
            out.append(Group(buf[i:i + 24], _walk(buf, i + 24, i + sz)))
            i += sz
        else:
            if i + 24 + sz > end:
                raise ValueError(f'@{i:#x}: record size {sz} overruns {end:#x}')
            out.append(Record(buf[i:i + 24], buf[i + 24:i + 24 + sz]))
            i += 24 + sz
    return out


class Plugin:
    def __init__(self, path=None, buf=None):
        self.buf = open(path, 'rb').read() if buf is None else buf
        b = self.buf
        if b[0:4] != b'TES4':
            raise ValueError('not a TES4 plugin')
        hsz = struct.unpack_from('<I', b, 4)[0]
        self.header = Record(b[0:24], b[24:24 + hsz])
        self.top = _walk(b, 24 + hsz, len(b))

    def serialize(self):
        return self.header.serialize() + b''.join(g.serialize() for g in self.top)

    def masters(self):
        return [v.rstrip(b'\0').decode('latin1') for t, v in self.header.subs() if t == 'MAST']

    def walk(self):
        # yields (node, parents) depth first, parents = list of Group
        def rec(nodes, parents):
            for n in nodes:
                yield n, parents
                if isinstance(n, Group):
                    yield from rec(n.children, parents + [n])
        yield from rec(self.top, [])

    def records(self):
        return [(n, p) for n, p in self.walk() if isinstance(n, Record)]

    def counts(self):
        nrec = ngrp = 0
        for n, p in self.walk():
            if isinstance(n, Group):
                ngrp += 1
            else:
                nrec += 1
        return nrec, ngrp


class Header:
    # A record found by scan(): a view into the plugin buffer, its body inflated on demand
    __slots__ = ('buf', 'type', 'fid', 'flags', 'off', 'size', 'path')

    def __init__(self, buf, t, fid, flags, off, size, path):
        self.buf, self.type, self.fid, self.flags, self.off, self.size, self.path = buf, t, fid, flags, off, size, path

    def data(self):
        d = self.buf[self.off + 24:self.off + 24 + self.size]
        return zlib.decompress(d[4:]) if self.flags & COMPRESSED else d

    def subs(self):
        return parse_subs(self.data())


def scan(buf, types=None):
    # Read-only walk of a large plugin: yields a Header per record of the given types, path = ((group type, label), ...)
    i = 24 + struct.unpack_from('<I', buf, 4)[0]
    stack, path = [], ()
    while i < len(buf):
        while stack and i >= stack[-1][0]:
            stack.pop()
            path = path[:-1]
        t = buf[i:i + 4]
        sz = struct.unpack_from('<I', buf, i + 4)[0]
        if t == b'GRUP':
            stack.append((i + sz,))
            path += ((struct.unpack_from('<i', buf, i + 12)[0], struct.unpack_from('<I', buf, i + 8)[0]),)
            i += 24
            continue
        name = t.decode('latin1')
        if types is None or name in types:
            flags, fid = struct.unpack_from('<II', buf, i + 8)
            yield Header(buf, name, fid, flags, i, sz, path)
        i += 24 + sz


def zstr(b):
    return b.split(b'\0')[0].decode('latin1')


def edid(rec):
    for t, v in rec.subs():
        if t == 'EDID':
            return zstr(v)
    return ''


def sub(rec, name):
    for t, v in rec.subs():
        if t == name:
            return v
    return None
