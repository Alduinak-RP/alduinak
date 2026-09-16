# BSA archive reader shared by the misc scripts.
import struct


class Bsa:
    """Uncompressed-entry reader for BSA v104/v105 (strings are stored raw)."""

    def __init__(self, path):
        self.path = path
        self.files = {}
        b = open(path, 'rb').read()
        magic, ver, off, aflags, nfold, nfile, _tfold, tfile = struct.unpack_from('<4sIIIIIII', b, 0)
        if magic != b'BSA\0' or ver not in (104, 105):
            raise ValueError(f'{path}: unsupported archive')
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

    def read(self, name):
        hit = self.files.get(name.lower())
        if not hit:
            return None
        pos, size, compressed = hit
        if compressed:
            raise ValueError(f'{self.path}: {name} is compressed')
        return self.buf[pos:pos + size]
