# BSA archive reader shared by the misc scripts.
import mmap
import struct
import zlib


def lz4_block(src, out, limit=None):
    """Appends one LZ4 block to `out`; stops early once `out` holds `limit` bytes."""
    i, n = 0, len(src)
    while i < n:
        token = src[i]
        i += 1
        length = token >> 4
        if length == 15:
            b = 255
            while b == 255:
                b = src[i]
                i += 1
                length += b
        out += src[i:i + length]
        i += length
        if i >= n or (limit and len(out) >= limit):
            break
        dist = src[i] | src[i + 1] << 8
        i += 2
        length = token & 15
        if length == 15:
            b = 255
            while b == 255:
                b = src[i]
                i += 1
                length += b
        length += 4
        start = len(out) - dist
        if dist >= length:
            out += out[start:start + length]
        else:
            out += (out[start:] * (length // dist + 1))[:length]


def lz4_frame(data, limit=None):
    if data[:4] != b'\x04\x22\x4d\x18':
        raise ValueError('not an LZ4 frame')
    flags = data[4]
    i = 7 + (8 if flags & 0x08 else 0) + (4 if flags & 0x01 else 0)
    out = bytearray()
    while not (limit and len(out) >= limit):
        size = struct.unpack_from('<I', data, i)[0]
        i += 4
        if size == 0:
            break
        block = data[i:i + (size & 0x7FFFFFFF)]
        i += size & 0x7FFFFFFF
        if size & 0x80000000:
            out += block
        else:
            lz4_block(block, out, limit)
        if flags & 0x10:
            i += 4
    return bytes(out)


class Bsa:
    """Reader for BSA v104/v105; entries are memory-mapped and inflated on read."""

    def __init__(self, path):
        self.path = path
        self.files = {}
        with open(path, 'rb') as f:
            b = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
        magic, ver, off, aflags, nfold, nfile, _tfold, tfile = struct.unpack_from('<4sIIIIIII', b, 0)
        if magic != b'BSA\0' or ver not in (104, 105):
            raise ValueError(f'{path}: unsupported archive')
        self.ver, self.aflags = ver, aflags
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

    def read(self, name, limit=None):
        """Entry bytes, or None when absent; with `limit` a compressed entry may stop after that many bytes."""
        hit = self.files.get(name.lower())
        if not hit:
            return None
        pos, size, compressed = hit
        data = self.buf[pos:pos + size]
        if self.aflags & 0x100:
            data = data[1 + data[0]:]
        if not compressed:
            return data
        if self.ver == 105:
            return lz4_frame(data[4:], limit)
        return zlib.decompressobj().decompress(data[4:], limit or 0)
