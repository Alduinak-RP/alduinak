# NIF reader helpers shared by the misc scripts.
import struct


def nif_blocks(d):
    """(type, offset, size) of every block of a version 20.2.0.7 NIF (Skyrim LE or SE)."""
    p = d.index(b'\n') + 1
    ver, _endian, _uver, count, bsver = struct.unpack_from('<IBIII', d, p)
    if ver != 0x14020007 or bsver not in (83, 100):
        raise ValueError(f'unsupported NIF version {ver:08X} bs {bsver}')
    p += 17
    for _ in range(3):
        p += 1 + d[p]
    ntypes = struct.unpack_from('<H', d, p)[0]
    p += 2
    types = []
    for _ in range(ntypes):
        n = struct.unpack_from('<I', d, p)[0]
        types.append(d[p + 4:p + 4 + n].decode('latin1'))
        p += 4 + n
    index = struct.unpack_from(f'<{count}H', d, p)
    p += 2 * count
    sizes = struct.unpack_from(f'<{count}I', d, p)
    p += 4 * count
    nstrings = struct.unpack_from('<I', d, p)[0]
    p += 8
    for _ in range(nstrings):
        p += 4 + struct.unpack_from('<I', d, p)[0]
    p += 4 + 4 * struct.unpack_from('<I', d, p)[0]
    out = []
    for k in range(count):
        out.append((types[index[k] & 0x7FFF], p, sizes[k]))
        p += sizes[k]
    if p + 4 + 4 * struct.unpack_from('<I', d, p)[0] != len(d):
        raise ValueError('NIF block sizes do not add up to the file')
    return out
