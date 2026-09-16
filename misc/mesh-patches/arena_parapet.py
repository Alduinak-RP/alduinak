# Lowers the invisible north parapet of the Windhelm arena pit so Graves's stairs work both ways (see README.md).
#   python misc/mesh-patches/arena_parapet.py --out <dir> [--data "C:/GOG Games/Skyrim Anniversary Edition/Data"]
import argparse
import hashlib
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bsalib import Bsa  # noqa: E402

DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'
ARCHIVE = 'WindhelmSSE.bsa'
MESH = 'meshes/SurWindhelmCustomMeshes/Experimental/ArenaTestv2Exp.nif'
SOURCE_SHA256 = '8c9b17e7f6284b90373bec046bedf4f8d28d6223098e794aa925f7fe27bdf8f7'
PATCHED_SHA256 = '1664cae02fcce558bd7771cfcac34a48edfc788cce2cb0b7ffdf797f9f4537a1'
HAVOK_SCALE = 69.99125

# temparenaobject1 collision data; chunk 1 triangles 12 and 13 are the parapet quad at world y 43822
BLOCK, CHUNK = 351, 1
PARAPET = {12, 13}
TOP_VERTICES = (104, 106)
BOTTOM_VERTICES = (105, 107)
TOP_OFFSETS = (0x1D4CF2, 0x1D4CFE)
BOTTOM_OFFSETS = (0x1D4CF8, 0x1D4D04)
OLD_TOP, NEW_TOP, BOTTOM = 4003, 2386, 2329


def nif_blocks(d):
    """(type, offset, size) of every block of a version 20.2.0.7 NIF."""
    p = d.index(b'\n') + 1
    ver, _endian, _uver, count, bsver = struct.unpack_from('<IBIII', d, p)
    if ver != 0x14020007 or bsver != 100:
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


def cms_chunk(d, block_offset, want):
    """Wanted chunk of a bhkCompressedMeshShapeData block with its quantization step and transform."""
    q = block_offset + 16
    step = struct.unpack_from('<f', d, q)[0]
    q += 4 + 32 + 2
    for element in (4, 4, 4, 8):
        q += 4 + element * struct.unpack_from('<I', d, q)[0]
    if struct.unpack_from('<I', d, q)[0]:
        raise ValueError('named materials are not supported')
    q += 4
    ntransforms = struct.unpack_from('<I', d, q)[0]
    transforms = [struct.unpack_from('<8f', d, q + 4 + 32 * k) for k in range(ntransforms)]
    q += 4 + 32 * ntransforms
    q += 4 + 16 * struct.unpack_from('<I', d, q)[0]
    q += 4 + 12 * struct.unpack_from('<I', d, q)[0]
    nchunks = struct.unpack_from('<I', d, q)[0]
    q += 4
    for k in range(nchunks):
        origin = struct.unpack_from('<3f', d, q)
        transform = struct.unpack_from('<H', d, q + 22)[0]
        q += 24
        nv = struct.unpack_from('<I', d, q)[0]
        vertex_offset = q + 4
        quantized = struct.unpack_from(f'<{nv}H', d, vertex_offset)
        q += 4 + 2 * nv
        ni = struct.unpack_from('<I', d, q)[0]
        indices = struct.unpack_from(f'<{ni}H', d, q + 4)
        q += 4 + 2 * ni
        ns = struct.unpack_from('<I', d, q)[0]
        strips = struct.unpack_from(f'<{ns}H', d, q + 4)
        q += 4 + 2 * ns
        q += 4 + 2 * struct.unpack_from('<I', d, q)[0]
        if k == want:
            return dict(step=step, transform=transforms[transform] if transform < ntransforms else None, origin=origin,
                        vertex_offset=vertex_offset, quantized=quantized, indices=indices, strips=strips)
    raise ValueError(f'chunk {want} missing')


def triangles(chunk):
    idx, out, o = chunk['indices'], [], 0
    for length in chunk['strips']:
        for s in range(length - 2):
            a, b, c = idx[o + s], idx[o + s + 1], idx[o + s + 2]
            out.append((a, c, b) if s & 1 else (a, b, c))
        o += length
    out += [tuple(idx[k:k + 3]) for k in range(o, len(idx) - 2, 3)]
    return out


def vertex(chunk, v):
    return tuple(chunk['origin'][a] + chunk['quantized'][3 * v + a] * chunk['step'] for a in range(3))


def normal(chunk, tri):
    a, b, c = (vertex(chunk, v) for v in tri)
    u = [b[i] - a[i] for i in range(3)]
    w = [c[i] - a[i] for i in range(3)]
    return (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])


def decode(d):
    blocks = nif_blocks(d)
    kind, offset, _size = blocks[BLOCK]
    if kind != 'bhkCompressedMeshShapeData':
        raise ValueError(f'block {BLOCK} is {kind}')
    chunk = cms_chunk(d, offset, CHUNK)
    return blocks, chunk, triangles(chunk)


def check(ok, message):
    if not ok:
        raise SystemExit(f'FAILED: {message}')


def height(chunk, tris):
    zs = [vertex(chunk, v)[2] for t in tris for v in t]
    return (max(zs) - min(zs)) * HAVOK_SCALE


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='folder that receives meshes/...; an MO2 mod folder or a staging folder')
    ap.add_argument('--data', default=DATA, help='Skyrim Data folder holding WindhelmSSE.bsa, read-only')
    args = ap.parse_args()

    source = Bsa(os.path.join(args.data, ARCHIVE)).read(MESH.replace('/', '\\'))
    check(source is not None, f'{MESH} not in {ARCHIVE}')
    check(hashlib.sha256(source).hexdigest() == SOURCE_SHA256,
          f'{ARCHIVE} ships a different {MESH}; Capital Windhelm Expansion changed, redo the diagnosis before patching')
    blocks, chunk, tris = decode(source)
    transform = chunk['transform']
    check(transform is None or transform[:3] + transform[4:7] == (0.0,) * 6, f'chunk {CHUNK} has a non-identity transform')
    base = chunk['vertex_offset']
    check(tuple(base + 2 * (3 * v + 2) for v in TOP_VERTICES) == TOP_OFFSETS, 'top vertex z offsets moved')
    check(tuple(base + 2 * (3 * v + 2) for v in BOTTOM_VERTICES) == BOTTOM_OFFSETS, 'bottom vertex z offsets moved')
    for off in TOP_OFFSETS:
        check(struct.unpack_from('<H', source, off)[0] == OLD_TOP, f'uint16 at 0x{off:X} is not {OLD_TOP}')
    for off in BOTTOM_OFFSETS:
        check(struct.unpack_from('<H', source, off)[0] == BOTTOM, f'uint16 at 0x{off:X} is not {BOTTOM}')
    users = {k for k, t in enumerate(tris) if set(t) & set(TOP_VERTICES)}
    check(users == PARAPET, f'top vertices are used by triangles {sorted(users)}, expected {sorted(PARAPET)}')
    before_height = height(chunk, [tris[k] for k in PARAPET])

    patched = bytearray(source)
    for off in TOP_OFFSETS:
        struct.pack_into('<H', patched, off, NEW_TOP)
    patched = bytes(patched)

    changed = [k for k in range(len(source)) if source[k] != patched[k]]
    expected = sorted(o + b for o in TOP_OFFSETS for b in (0, 1))
    check(len(source) == len(patched) and changed == expected, f'expected exactly 4 changed bytes, got {len(changed)}')
    blocks2, chunk2, tris2 = decode(patched)
    check([b[:2] for b in blocks2] == [b[:2] for b in blocks] and tris2 == tris, 'block layout or triangle indices changed')
    moved = {k for k, t in enumerate(tris) if [vertex(chunk, v) for v in t] != [vertex(chunk2, v) for v in t]}
    check(moved == PARAPET, f'triangles {sorted(moved)} moved, expected only {sorted(PARAPET)}')
    for k in PARAPET:
        n1, n2 = normal(chunk, tris[k]), normal(chunk2, tris[k])
        check(sum(n2[i] * n2[i] for i in range(3)) > 0, f'triangle {k} became degenerate')
        check(sum(n1[i] * n2[i] for i in range(3)) > 0, f'triangle {k} flipped its facing')
    after_height = height(chunk2, [tris2[k] for k in PARAPET])
    check(0 < after_height < 5, f'parapet is still {after_height:.1f} units tall')
    digest = hashlib.sha256(patched).hexdigest()
    check(digest == PATCHED_SHA256, f'patched sha256 {digest} differs from the pinned result')

    target = os.path.join(args.out, *MESH.split('/'))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'wb') as f:
        f.write(patched)
    check(hashlib.sha256(open(target, 'rb').read()).hexdigest() == digest, f'{target} did not read back identical')

    print(f'source  {ARCHIVE}:{MESH} sha256 {SOURCE_SHA256}')
    print(f'changed 4 bytes: vertices {TOP_VERTICES} z {OLD_TOP} -> {NEW_TOP} at ' + ', '.join(f'0x{o:X}' for o in TOP_OFFSETS))
    print(f'parapet triangles {sorted(PARAPET)}: {before_height:.1f} -> {after_height:.1f} units tall; '
          f'other {len(tris) - len(PARAPET)} triangles of chunk {CHUNK} and all other blocks unchanged')
    print(f'wrote   {target} sha256 {digest}')


if __name__ == '__main__':
    main()
