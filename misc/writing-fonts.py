# Packs the owner's writing fonts as WOFF for skymp5-front/src/fonts/writing; fonts with thousands of glyphs keep only Latin. Pure Python, no fontTools on the box.
# python misc/writing-fonts.py "C:\Users\Administrator\Desktop\Graphics\writing\Fonts" skymp5-front/src/fonts/writing
import argparse
import os
import struct
import zlib

# Source file to output name; the front's @font-face rules and FONTS table use these names
FILES = {
    'SkyrimBooks_Handwritten_Bold-Regular.ttf': 'handwritten',
    'SkyrimBooks_Gaelic-Regular.ttf': 'gaelic',
    'Daedric.ttf': 'daedric',
    'Dragon_script.ttf': 'dragon',
    'Dwemer.ttf': 'dwemer',
    'Falmer.ttf': 'falmer',
    'Mage Script.ttf': 'mage',
    'SkyrimBooks_Unreadable.ttf': 'unreadable',
    'SkyrimSymbols.ttf': 'symbols',
}

# Code points kept when a font is subset: Basic Latin, Latin-1, Latin Extended-A and common punctuation
KEEP = [(0x20, 0x7e), (0xa0, 0x17f), (0x2010, 0x2027), (0x2030, 0x203a), (0x20ac, 0x20ac), (0x2122, 0x2122)]
SUBSET_ABOVE = 1000
# Tables a subset drops: names of every glyph, FontForge's timestamp and glyph classes no layout table uses
DROPPED = {b'FFTM', b'GDEF', b'GSUB', b'GPOS', b'kern', b'hdmx', b'LTSH', b'VDMX'}


def align4(b):
    return b + b'\0' * (-len(b) % 4)


def checksum(b):
    b = align4(b)
    return sum(struct.unpack(f'>{len(b) // 4}I', b)) & 0xffffffff


def read_tables(data):
    flavor, num = struct.unpack('>IH', data[:6])
    tables = {}
    for i in range(num):
        tag, _, off, length = struct.unpack('>4sIII', data[12 + 16 * i:28 + 16 * i])
        tables[tag] = data[off:off + length]
    return flavor, tables


def cmap_of(tables):
    cmap = tables[b'cmap']
    out = {}
    for i in range(struct.unpack('>H', cmap[2:4])[0]):
        pid, eid, off = struct.unpack('>HHI', cmap[4 + 8 * i:12 + 8 * i])
        if (pid, eid) not in ((3, 1), (0, 3)) or struct.unpack('>H', cmap[off:off + 2])[0] != 4:
            continue
        segs = struct.unpack('>H', cmap[off + 6:off + 8])[0] // 2
        arr = lambda k: struct.unpack(f'>{segs}H', cmap[off + 14 + k * 2 * segs + (2 if k else 0):][:2 * segs])
        ends, starts, deltas = arr(0), arr(1), arr(2)
        ro_at = off + 16 + 6 * segs
        ranges = struct.unpack(f'>{segs}H', cmap[ro_at:ro_at + 2 * segs])
        for s in range(segs):
            for c in range(starts[s], ends[s] + 1):
                if c == 0xffff:
                    continue
                if ranges[s] == 0:
                    g = (c + deltas[s]) & 0xffff
                else:
                    at = ro_at + 2 * s + ranges[s] + 2 * (c - starts[s])
                    g = struct.unpack('>H', cmap[at:at + 2])[0]
                    g = (g + deltas[s]) & 0xffff if g else 0
                if g:
                    out[c] = g
        return out
    raise ValueError('no Unicode BMP cmap')


def build_cmap4(mapping):
    codes = sorted(c for c in mapping if c < 0xffff)
    segs, i = [], 0
    while i < len(codes):
        j = i
        while j + 1 < len(codes) and codes[j + 1] == codes[j] + 1:
            j += 1
        segs.append(codes[i:j + 1])
        i = j + 1
    ends, starts, deltas, ranges, glyphs = [], [], [], [], []
    for run in segs:
        ends.append(run[-1])
        starts.append(run[0])
        if all(mapping[c] - c == mapping[run[0]] - run[0] for c in run):
            deltas.append((mapping[run[0]] - run[0]) & 0xffff)
            ranges.append(None)
        else:
            deltas.append(0)
            ranges.append(len(glyphs))
            glyphs += [mapping[c] for c in run]
    ends.append(0xffff)
    starts.append(0xffff)
    deltas.append(1)
    ranges.append(None)
    n = len(ends)
    # idRangeOffset counts bytes from its own slot to the glyph in glyphIdArray
    range_words = [0 if r is None else 2 * (n - s) + 2 * r for s, r in enumerate(ranges)]
    search = 2 ** (n.bit_length() - 1)
    body = struct.pack('>HHHH', 2 * n, 2 * search, search.bit_length() - 1, 2 * n - 2 * search)
    body += struct.pack(f'>{n}H', *ends) + b'\0\0' + struct.pack(f'>{n}H', *starts)
    body += struct.pack(f'>{n}H', *deltas) + struct.pack(f'>{n}H', *range_words) + struct.pack(f'>{len(glyphs)}H', *glyphs)
    sub = struct.pack('>HHH', 4, 6 + len(body), 0) + body
    # Both Unicode records share the one subtable
    return struct.pack('>HHHHIHHI', 0, 2, 0, 3, 20, 3, 1, 20) + sub


def components(glyph):
    if len(glyph) < 10 or struct.unpack('>h', glyph[:2])[0] >= 0:
        return []
    out, at = [], 10
    while True:
        flags, gid = struct.unpack('>HH', glyph[at:at + 4])
        out.append(gid)
        at += 4 + (4 if flags & 1 else 2)
        at += 2 if flags & 8 else 4 if flags & 0x40 else 8 if flags & 0x80 else 0
        if not flags & 0x20:
            return out


# Keeps glyph ids, so hmtx and the remaining tables stay valid; dropped glyphs become empty
def subset(tables):
    head = tables[b'head']
    num_glyphs = struct.unpack('>H', tables[b'maxp'][4:6])[0]
    long_loca = struct.unpack('>h', head[50:52])[0] == 1
    loca = tables[b'loca']
    offs = struct.unpack(f'>{num_glyphs + 1}{"I" if long_loca else "H"}', loca[:(num_glyphs + 1) * (4 if long_loca else 2)])
    if not long_loca:
        offs = [o * 2 for o in offs]
    glyf = tables[b'glyf']
    glyph = lambda g: glyf[offs[g]:offs[g + 1]]
    full = cmap_of(tables)
    mapping = {c: g for c, g in full.items() if any(lo <= c <= hi for lo, hi in KEEP)}
    keep, todo = {0}, list(mapping.values())
    while todo:
        g = todo.pop()
        if g in keep or g >= num_glyphs:
            continue
        keep.add(g)
        todo += components(glyph(g))
    new_glyf, new_offs = bytearray(), []
    for g in range(num_glyphs):
        new_offs.append(len(new_glyf))
        if g in keep:
            new_glyf += align4(glyph(g))
    new_offs.append(len(new_glyf))
    out = {t: v for t, v in tables.items() if t not in DROPPED}
    out[b'glyf'] = bytes(new_glyf)
    out[b'loca'] = struct.pack(f'>{len(new_offs)}I', *new_offs)
    out[b'head'] = head[:50] + struct.pack('>h', 1) + head[52:]
    out[b'cmap'] = build_cmap4(mapping)
    out[b'post'] = struct.pack('>I', 0x00030000) + tables[b'post'][4:32]
    return out, len(mapping), len(keep)


def build_sfnt(flavor, tables):
    tags = sorted(tables)
    head = bytearray(tables[b'head'])
    head[8:12] = b'\0\0\0\0'
    tables = {**tables, b'head': bytes(head)}
    n = len(tags)
    search = 2 ** (n.bit_length() - 1)
    out = bytearray(struct.pack('>IHHHH', flavor, n, 16 * search, search.bit_length() - 1, 16 * n - 16 * search))
    at = 12 + 16 * n
    body = bytearray()
    for tag in tags:
        data = tables[tag]
        out += struct.pack('>4sIII', tag, checksum(data), at + len(body), len(data))
        body += align4(data)
    font = out + body
    adjust = (0xb1b0afba - checksum(bytes(font))) & 0xffffffff
    head_at = struct.unpack('>I', font[12 + 16 * tags.index(b'head') + 8:][:4])[0]
    font[head_at + 8:head_at + 12] = struct.pack('>I', adjust)
    return bytes(font)


def to_woff(sfnt):
    flavor, tables = read_tables(sfnt)
    num = len(tables)
    meta = []
    for i in range(num):
        tag, check, off, length = struct.unpack('>4sIII', sfnt[12 + 16 * i:28 + 16 * i])
        meta.append((tag, check, sfnt[off:off + length]))
    meta.sort()
    at = 44 + 20 * num
    directory, body = bytearray(), bytearray()
    for tag, check, data in meta:
        packed = zlib.compress(data, 9)
        if len(packed) >= len(data):
            packed = data
        directory += struct.pack('>4sIIII', tag, at + len(body), len(packed), len(data), check)
        body += align4(packed)
    total_sfnt = 12 + 16 * num + sum(len(align4(d)) for _, _, d in meta)
    size = 44 + len(directory) + len(body)
    header = struct.pack('>IIIHHIHHIIIII', 0x774f4646, flavor, size, num, 0, total_sfnt, 1, 0, 0, 0, 0, 0, 0)
    return header + bytes(directory) + bytes(body)


def main():
    ap = argparse.ArgumentParser(description='Pack the writing fonts as WOFF, subsetting the large ones to Latin')
    ap.add_argument('src', help='folder with the owner\'s .ttf files')
    ap.add_argument('dst', help='output folder, one <name>.woff each')
    args = ap.parse_args()
    os.makedirs(args.dst, exist_ok=True)
    for name, slug in FILES.items():
        data = open(os.path.join(args.src, name), 'rb').read()
        flavor, tables = read_tables(data)
        num_glyphs = struct.unpack('>H', tables[b'maxp'][4:6])[0]
        note = f'{num_glyphs} glyphs'
        if num_glyphs > SUBSET_ABOVE:
            tables, codes, kept = subset(tables)
            note = f'{num_glyphs} glyphs, kept {kept} for {codes} code points'
        out = os.path.join(args.dst, slug + '.woff')
        with open(out, 'wb') as fh:
            fh.write(to_woff(build_sfnt(flavor, tables)))
        print(f'{name} {len(data)} bytes ({note}) -> {slug}.woff {os.path.getsize(out)} bytes')


if __name__ == '__main__':
    main()
