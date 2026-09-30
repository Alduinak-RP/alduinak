"""Checks MOPP compressed-mesh collision for bad keys, unaligned chunk jumps and unreachable triangles: python misc/mopp-check.py [-v] <nif|folder|bsa>..."""
import argparse
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from bsalib import Bsa  # noqa: E402
from niflib import nif_blocks  # noqa: E402

MARK = b'bhkCompressedMeshShapeData'
SNIFF = 16384
ALIGN = 16
PADDING = (0x00, 0xCD)
THIN = 0.002  # Havok units; slivers thinner than this get no MOPP leaf
STATES = 1 << 20
LENGTH = {0x00: 1, 0x05: 2, 0x06: 3, 0x07: 4, 0x08: 5, 0x09: 2, 0x0A: 3, 0x0B: 5, 0x50: 2, 0x51: 3, 0x52: 4, 0x53: 5,
          0x70: 5}
for first, last, n in ((0x01, 0x04, 4), (0x10, 0x1C, 4), (0x20, 0x22, 3), (0x23, 0x25, 7), (0x26, 0x28, 3),
                       (0x29, 0x2B, 7), (0x30, 0x4F, 1), (0x60, 0x63, 2), (0x64, 0x67, 3), (0x68, 0x6B, 5)):
    LENGTH.update((op, n) for op in range(first, last + 1))


def u32(d, p):
    return struct.unpack_from('<I', d, p)[0]


def cms_data(d, off, size):
    """The arrays of a bhkCompressedMeshShapeData block that the engine reads for a key."""
    bpi, bpwi, wmask, imask, step = struct.unpack_from('<4If', d, off)
    q = off + 16 + 4 + 32
    welding = d[q]
    q += 2
    for _ in range(3):
        q += 4 + 4 * u32(d, q)
    q += 4 + 8 * u32(d, q)
    if u32(d, q):
        raise ValueError('named materials are not supported')
    q += 4
    ntrans = u32(d, q)
    q += 4 + 32 * ntrans
    nbv = u32(d, q)
    bigverts = [struct.unpack_from('<3f', d, q + 4 + 16 * k) for k in range(nbv)]
    q += 4 + 16 * nbv
    nbt = u32(d, q)
    big = [struct.unpack_from('<3HIH', d, q + 4 + 12 * k) for k in range(nbt)]
    q += 4 + 12 * nbt
    chunks, nch = [], u32(d, q)
    q += 4
    for _ in range(nch):
        ref, trans = struct.unpack_from('<HH', d, q + 20)
        q += 24
        nv = u32(d, q)
        verts = struct.unpack_from(f'<{nv}H', d, q + 4)
        q += 4 + 2 * nv
        idx = struct.unpack_from(f'<{u32(d, q)}H', d, q + 4)
        q += 4 + 2 * len(idx)
        strips = struct.unpack_from(f'<{u32(d, q)}H', d, q + 4)
        q += 4 + 2 * len(strips)
        nw = u32(d, q)
        q += 4 + 2 * nw
        chunks.append(dict(ref=ref, trans=trans, verts=[verts[k:k + 3] for k in range(0, nv - 2, 3)], idx=idx,
                           strips=strips, nw=nw))
    convex = u32(d, q)
    if not convex and q + 4 != off + size:
        raise ValueError(f'compressed mesh data parsed to {q + 4 - off} of {size} bytes')
    return dict(bpi=bpi, bpwi=bpwi, wmask=wmask, imask=imask, step=step, welding=welding, ntrans=ntrans, nbv=nbv,
                bigverts=bigverts, big=big, chunks=chunks, convex=convex)


def source_chunk(c, k):
    """Chunk whose indices and vertices chunk k uses, following its reference."""
    ch = c['chunks'][k]
    return ch if ch['ref'] == 0xFFFF else c['chunks'][ch['ref']] if ch['ref'] < len(c['chunks']) else None


def data_problems(c):
    """Out-of-range indices in the arrays that getChildShape reads without checks."""
    out = []
    bad = [k for k, t in enumerate(c['big']) if max(t[:3]) >= c['nbv']]
    if bad:
        out.append(f'big triangles {bad[:8]} index a vertex past {c["nbv"]}')
    for k, ch in enumerate(c['chunks']):
        src = source_chunk(c, k)
        if src is None:
            out.append(f'chunk {k} references chunk {ch["ref"]} of {len(c["chunks"])}')
            continue
        if ch['trans'] != 0xFFFF and ch['trans'] >= c['ntrans']:
            out.append(f'chunk {k} uses transform {ch["trans"]} of {c["ntrans"]}')
        if src['idx'] and max(src['idx']) >= len(src['verts']):
            out.append(f'chunk {k} indexes vertex {max(src["idx"])} of {len(src["verts"])}')
        if c['welding'] != 6 and src['nw'] < len(src['idx']):
            out.append(f'chunk {k} has {src["nw"]} welding entries for {len(src["idx"])} indices')
    return out


def key_problem(c, key):
    """Why the engine would read out of bounds for this key, or None."""
    section, top = key >> c['bpwi'], (1 << (32 - c['bpwi'])) - 1
    if section == 0:
        k = key & c['wmask']
        return None if k < len(c['big']) else f'big triangle {k} of {len(c["big"])}'
    if section == top:
        k = key & c['wmask']
        return None if k < c['convex'] else f'convex piece {k} of {c["convex"]}'
    if section > len(c['chunks']):
        return f'chunk {section - 1} of {len(c["chunks"])}'
    src = source_chunk(c, section - 1)
    k = key & c['imask']
    if src is None or k + 2 >= len(src['idx']):
        return f'chunk {section - 1} index {k} of {len(src["idx"]) if src else 0}'
    return None


def thin(p, q, r):
    longest = max(math.dist(p, q), math.dist(q, r), math.dist(r, p))
    u, w = [q[a] - p[a] for a in range(3)], [r[a] - p[a] for a in range(3)]
    cross = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
    return longest == 0 or math.hypot(*cross) / longest < THIN


def triangle_keys(c):
    """Keys of every triangle slot, and of the slots that are not slivers, as the MOPP should emit them."""
    slots, solid = set(), set()
    tris = [(k, t[:3], c['bigverts']) for k, t in enumerate(c['big'])]
    for k in range(len(c['chunks'])):
        src = source_chunk(c, k)
        if src is None:
            continue
        idx, section, p = src['idx'], (k + 1) << c['bpwi'], 0
        verts = [[x * c['step'] for x in v] for v in src['verts']]
        for n in src['strips']:
            tris += [(section | (t & 1) << c['bpi'] | (p + t), idx[p + t:p + t + 3], verts) for t in range(n - 2)]
            p += n
        tris += [(section | q, idx[q:q + 3], verts) for q in range(p, len(idx) - 2, 3)]
    for key, tri, verts in tris:
        slots.add(key)
        if max(tri) < len(verts) and not thin(*(verts[i] for i in tri)):
            solid.add(key)
    convex = {((1 << (32 - c['bpwi'])) - 1) << c['bpwi'] | k for k in range(c['convex'])}
    return slots | convex, solid | convex


def run_mopp(code):
    """Every key any path of the MOPP code can emit (key -> leaf offset), its chunk jumps, faults and executed bytes."""
    keys, jumps, faults, seen, cover = {}, [], [], set(), bytearray(len(code))
    todo = [(0, 0)]
    while todo:
        pc, off = todo.pop()
        while (pc, off) not in seen:
            seen.add((pc, off))
            if len(seen) > STATES:
                faults.append(f'more than {STATES} code states, the offsets never settle')
                return keys, sorted(set(jumps)), faults, cover
            if not 0 <= pc < len(code):
                faults.append(f'path leaves the code at 0x{pc:X}')
                break
            op = code[pc]
            n = LENGTH.get(op)
            if n is None or pc + n > len(code):
                faults.append(f'unknown opcode 0x{op:02X} at 0x{pc:X}')
                break
            cover[pc:pc + n] = b'\1' * n
            arg = int.from_bytes(code[pc + 1:pc + n], 'big')
            if op == 0x00:
                break
            if 0x05 <= op <= 0x08:
                pc += n + arg
            elif op in (0x09, 0x0A):
                off, pc = off + arg, pc + n
            elif op == 0x0B:
                off, pc = arg, pc + n
            elif 0x10 <= op <= 0x1C:
                todo.append((pc + n + code[pc + 3], off))
                pc += n
            elif 0x20 <= op <= 0x22:
                todo.append((pc + n + code[pc + 2], off))
                pc += n
            elif 0x23 <= op <= 0x25:
                todo.append((pc + n + (code[pc + 5] << 8 | code[pc + 6]), off))
                pc += n + (code[pc + 3] << 8 | code[pc + 4])
            elif 0x30 <= op <= 0x4F:
                keys.setdefault((off + op - 0x30) & 0xFFFFFFFF, pc)
                break
            elif 0x50 <= op <= 0x53:
                keys.setdefault((off + arg) & 0xFFFFFFFF, pc)
                break
            elif op == 0x70:
                jumps.append((pc, arg))
                pc = arg
            else:
                pc += n
    return keys, sorted(set(jumps)), faults, cover


def orphan_code(code, cover):
    """(start, end) of never-executed runs that hold more than padding."""
    out, start = [], None
    for p in range(len(code) + 1):
        if p < len(code) and not cover[p]:
            start = p if start is None else start
            continue
        if start is not None:
            body = [q for q in range(start, p) if code[q] not in PADDING]
            if body:
                out.append((body[0], p))
            start = None
    return out


def verdict(c, code):
    keys, jumps, faults, cover = run_mopp(code)
    slots, solid = triangle_keys(c)
    bad = {k: (pc, key_problem(c, k)) for k, pc in keys.items() if key_problem(c, k)}
    stray = sorted(k for k in keys if k not in bad and k not in slots)
    unreachable = sorted(solid - set(keys))
    unaligned = [(pc, t) for pc, t in jumps if t % ALIGN]
    return dict(keys=keys, bad=bad, stray=stray, unaligned=unaligned, unreachable=unreachable, faults=faults,
                orphans=orphan_code(code, cover))


def restore_byte(c, code, build, base):
    """(file offset, old, new) that restores the last code byte from the build-type byte, if that cleans the shape."""
    if not code or code[-1] == build:
        return None
    w = verdict(c, code[:-1] + bytes([build]))
    if w['bad'] or w['stray'] or w['unaligned'] or w['unreachable'] or w['faults']:
        return None
    return base + len(code) - 1, code[-1], build


def mopp_shapes(d):
    """(block, shape block, compressed mesh data or None, code, build type, code file offset) of each MOPP shape."""
    blocks = nif_blocks(d)
    for k, (kind, off, _size) in enumerate(blocks):
        if kind != 'bhkMoppBvTreeShape':
            continue
        ref = struct.unpack_from('<i', d, off)[0]
        if not 0 <= ref < len(blocks) or blocks[ref][0] != 'bhkCompressedMeshShape':
            continue
        data = struct.unpack_from('<i', d, blocks[ref][1] + 52)[0]
        if not 0 <= data < len(blocks) or blocks[data][0] != 'bhkCompressedMeshShapeData':
            yield k, ref, None, None, None, None
            continue
        size, base = u32(d, off + 20), off + 41
        yield k, ref, cms_data(d, blocks[data][1], blocks[data][2]), d[base:base + size], d[off + 40], base


def check_nif(d):
    """Report lines for the problem shapes of a NIF, and its count of MOPP compressed-mesh shapes."""
    lines, shapes = [], 0
    for k, ref, c, code, build, base in mopp_shapes(d):
        shapes += 1
        if c is None:
            lines.append(f'block {k}: shape {ref} has no compressed mesh data')
            continue
        v = verdict(c, code)
        out = [f'DATA {p}' for p in data_problems(c)] + [f'FAULT {f}' for f in v['faults']]
        for key, (pc, why) in sorted(v['bad'].items()):
            out.append(f'BAD KEY 0x{key:X} ({why}) from the leaf at code 0x{pc:X}')
        if v['stray']:
            out.append(f'STRAY {len(v["stray"])} keys in range that start no triangle, e.g. '
                       + ' '.join(f'0x{x:X}' for x in v['stray'][:6]))
        for pc, target in v['unaligned']:
            out.append(f'UNALIGNED JUMP at code 0x{pc:X} (file 0x{base + pc:X}) to 0x{target:X}')
        if v['unreachable']:
            orphans = ', '.join(f'0x{s:X}-0x{e - 1:X}' for s, e in v['orphans']) or 'none'
            out.append(f'UNREACHABLE {len(v["unreachable"])} triangles, e.g. '
                       + ' '.join(f'0x{x:X}' for x in v['unreachable'][:6]) + f'; orphan code {orphans}')
        fix = restore_byte(c, code, build, base) if out else None
        if fix:
            out.append(f'HINT set file byte 0x{fix[0]:X} from {fix[1]:02X} to {fix[2]:02X} (the build-type byte '
                       f'holds the last code byte): no bad key, stray, unaligned jump or unreachable triangle is left')
        if out:
            lines.append(f'block {k}: {len(c["big"])} big triangles, {len(c["chunks"])} chunks, {len(v["keys"])} keys, '
                         f'build type 0x{build:02X}')
            lines += ['  ' + line for line in out]
    return lines, shapes


def sources(path):
    """(label, reader) of every NIF under a path; the reader takes an optional byte limit."""
    if path.lower().endswith('.bsa'):
        bsa = Bsa(path)
        for name in sorted(bsa.files):
            if name.endswith('.nif'):
                yield f'{os.path.basename(path)}:{name}', lambda limit=None, name=name: bsa.read(name, limit)
    elif os.path.isdir(path):
        for root, _dirs, files in os.walk(path):
            for f in sorted(files):
                if f.lower().endswith('.nif'):
                    full = os.path.join(root, f)
                    yield full, lambda limit=None, full=full: open(full, 'rb').read(limit or -1)
    else:
        yield path, lambda limit=None: open(path, 'rb').read(limit or -1)


def scan(path):
    """(label, report lines or None without compressed mesh data, shape count, read error) of every NIF under a path."""
    for label, read in sources(path):
        try:
            if MARK not in read(SNIFF):
                yield label, None, 0, None
                continue
            lines, n = check_nif(read())
        except (ValueError, IndexError, struct.error) as e:
            yield label, [], 0, str(e)
            continue
        yield label, lines, n, None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('paths', nargs='+', help='NIF files, folders searched for NIFs, or BSA archives')
    ap.add_argument('-v', '--verbose', action='store_true', help='also list unreadable NIFs')
    args = ap.parse_args()
    nifs = with_cms = shapes = flagged = unreadable = 0
    for path in args.paths:
        for label, lines, n, error in scan(path):
            nifs += 1
            if lines is None:
                continue
            with_cms += 1
            if error:
                unreadable += 1
                if args.verbose:
                    print(f'{label}: unreadable: {error}')
                continue
            shapes += n
            if lines:
                flagged += 1
                print(label)
                print('\n'.join('  ' + line for line in lines), flush=True)
    print(f'{nifs} NIFs, {with_cms} with compressed mesh data, {shapes} MOPP shapes, {flagged} flagged, '
          f'{unreadable} unreadable')
    return 1 if flagged else 0


if __name__ == '__main__':
    sys.exit(main())
