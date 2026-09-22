# Downscales the hold and faction seal artwork to skymp5-front/src/img/seals; pure Python, no Pillow on the box.
# python misc/seal-icons.py "C:\Users\Administrator\Desktop\Graphics\Seals" skymp5-front/src/img/seals --size 128
import argparse
import math
import os
import struct
import zlib

# Source file name to faction slug (the id after hold: or faction:)
FILES = {
    'SR-symbol-Solitude.png': 'haafingar',
    'SR-symbol-Markarth.png': 'the-reach',
    'SR-symbol-Falkreath.png': 'falkreath',
    'SR-symbol-Hjaalmarch.png': 'hjaalmarch',
    'SR-symbol-Windhelm.png': 'eastmarch',
    'SR-symbol-Winterhold.png': 'winterhold',
    'SR-symbol-Riften.png': 'the-rift',
    'SR-symbol-Dawnstar.png': 'the-pale',
    'SR-symbol-Whiterun.png': 'whiterun',
    'SR-icon-Imperial.png': 'imperial-legion',
    'SR-icon-College.png': 'college-of-winterhold',
    'SR-book-Dbhand.png': 'dark-brotherhood',
}

SIG = b'\x89PNG\r\n\x1a\n'
CHANNELS = {0: 1, 2: 3, 4: 2, 6: 4}


def paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def unfilter(raw, h, stride, bpp):
    prev, rows = bytearray(stride), []
    for y in range(h):
        at = y * (stride + 1)
        f, cur = raw[at], bytearray(raw[at + 1:at + 1 + stride])
        for i in range(stride):
            a = cur[i - bpp] if i >= bpp else 0
            if f == 1:
                cur[i] = (cur[i] + a) & 255
            elif f == 2:
                cur[i] = (cur[i] + prev[i]) & 255
            elif f == 3:
                cur[i] = (cur[i] + (a + prev[i]) // 2) & 255
            elif f == 4:
                cur[i] = (cur[i] + paeth(a, prev[i], prev[i - bpp] if i >= bpp else 0)) & 255
        rows.append(cur)
        prev = cur
    return rows


# Rows of premultiplied floats r, g, b, a per pixel, so transparent edges average cleanly
def to_rgba(row, channels):
    out = []
    for i in range(0, len(row), channels):
        px = row[i:i + channels]
        if channels < 3:
            px = [px[0]] * 3 + list(px[1:])
        a = px[3] if len(px) == 4 else 255
        out += [px[0] * a, px[1] * a, px[2] * a, a]
    return out


def read_png(path):
    data = open(path, 'rb').read()
    if data[:8] != SIG:
        raise ValueError(f'{path}: not a PNG')
    i, idat, ihdr = 8, [], None
    while i + 8 <= len(data):
        n, kind = struct.unpack('>I4s', data[i:i + 8])
        body = data[i + 8:i + 8 + n]
        i += 12 + n
        if kind == b'IHDR':
            ihdr = struct.unpack('>IIBBBBB', body)
        elif kind == b'IDAT':
            idat.append(body)
        elif kind == b'IEND':
            break
    w, h, depth, ctype, _, _, interlace = ihdr
    channels = CHANNELS.get(ctype)
    if depth != 8 or not channels or interlace:
        raise ValueError(f'{path}: only 8-bit non-interlaced greyscale or RGB(A) is supported')
    rows = unfilter(zlib.decompress(b''.join(idat)), h, w * channels, channels)
    return w, h, [to_rgba(r, channels) for r in rows]


# Box filter taps: each output sample covers an equal span of the input, partial pixels weighted by overlap
def taps(n_in, n_out):
    out = []
    for o in range(n_out):
        lo, hi = o * n_in / n_out, (o + 1) * n_in / n_out
        out.append([(s, (min(hi, s + 1) - max(lo, s)) / (hi - lo)) for s in range(int(lo), min(n_in, math.ceil(hi)))])
    return out


def shrink(rows, w, h, ow, oh):
    across = taps(w, ow)
    rows = [[sum(row[4 * s + c] * wt for s, wt in t) for t in across for c in range(4)] for row in rows]
    down = taps(h, oh)
    return [[sum(rows[s][i] * wt for s, wt in t) for i in range(4 * ow)] for t in down]


def to_bytes(row):
    out = bytearray()
    for i in range(0, len(row), 4):
        a = row[i + 3]
        out += bytes(min(255, round(v / a)) for v in row[i:i + 3]) if a >= 0.5 else b'\0\0\0'
        out.append(min(255, round(a)))
    return bytes(out)


def filtered(f, cur, prev, bpp):
    left = lambda i: cur[i - bpp] if i >= bpp else 0
    if f == 0:
        return cur
    if f == 1:
        return bytes((cur[i] - left(i)) & 255 for i in range(len(cur)))
    if f == 2:
        return bytes((cur[i] - prev[i]) & 255 for i in range(len(cur)))
    if f == 3:
        return bytes((cur[i] - (left(i) + prev[i]) // 2) & 255 for i in range(len(cur)))
    return bytes((cur[i] - paeth(left(i), prev[i], prev[i - bpp] if i >= bpp else 0)) & 255 for i in range(len(cur)))


def write_png(path, w, h, rows):
    def chunk(kind, body):
        return struct.pack('>I', len(body)) + kind + body + struct.pack('>I', zlib.crc32(kind + body))
    prev, out = bytes(4 * w), bytearray()
    for cur in rows:
        # The filter with the smallest signed sum compresses best, the usual heuristic
        f, best = min(((f, filtered(f, cur, prev, 4)) for f in range(5)), key=lambda p: sum(v if v < 128 else 256 - v for v in p[1]))
        out.append(f)
        out += best
        prev = cur
    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)
    with open(path, 'wb') as fh:
        fh.write(SIG + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(bytes(out), 9)) + chunk(b'IEND', b''))


def main():
    ap = argparse.ArgumentParser(description='Downscale the seal PNGs to the front image set, keeping aspect')
    ap.add_argument('src', help='folder with the SR-*.png artwork')
    ap.add_argument('dst', help='output folder, one <faction-slug>.png each')
    ap.add_argument('--size', type=int, default=128, help='pixels on the long side (default 128)')
    args = ap.parse_args()
    os.makedirs(args.dst, exist_ok=True)
    for name, slug in FILES.items():
        w, h, rows = read_png(os.path.join(args.src, name))
        scale = min(args.size / w, args.size / h, 1)
        ow, oh = max(1, round(w * scale)), max(1, round(h * scale))
        out = os.path.join(args.dst, slug + '.png')
        write_png(out, ow, oh, [to_bytes(r) for r in shrink(rows, w, h, ow, oh)])
        print(f'{name} {w}x{h} -> {slug}.png {ow}x{oh} {os.path.getsize(out)} bytes')


if __name__ == '__main__':
    main()
