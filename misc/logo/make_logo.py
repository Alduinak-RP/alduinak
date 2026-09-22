"""Downscales the official Alduinak logo into every size the repo ships. Pure Python, no PIL.

python misc/logo/make_logo.py <AlduinakLogoOfficial.png> misc/logo/assets

Writes logo-1024.png (Discord art asset), menu-title-logo.png (800 px, in-game main menu),
logo-96.png (launcher topbar, dashboard), icon.ico (16-256 px frames) and favicon.ico (16-48 px).
"""
import os, struct, sys, zlib

ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)
FAVICON_SIZES = (16, 32, 48)


def read_png(path):
    b = open(path, 'rb').read(); o = 8; idat = b''
    while o < len(b):
        ln, typ = struct.unpack('>I4s', b[o:o + 8]); data = b[o + 8:o + 8 + ln]; o += 12 + ln
        if typ == b'IHDR': w, h, depth, ctype, _, _, interlace = struct.unpack('>IIBBBBB', data[:13])
        elif typ == b'IDAT': idat += data
    assert depth == 8 and ctype == 6 and interlace == 0, 'need a non-interlaced 8-bit RGBA png'
    raw = zlib.decompress(idat); bpp = 4; stride = w * bpp; rows = []; prev = bytearray(stride); p = 0
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p + 1:p + 1 + stride]); p += 1 + stride
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0; up = prev[i]; c = prev[i - bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + up) & 255
            elif f == 3: line[i] = (line[i] + (a + up) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(up - c), abs(a - c), abs(a + up - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return w, h, rows


def write_png(path, w, h, rows):
    def chunk(typ, data):
        return struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(r) for r in rows)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    open(path, 'wb').write(png)


# Source pixel spans and weights covering each destination cell, for one axis
def spans(src, dst):
    out = []
    for d in range(dst):
        lo, hi = d * src / dst, (d + 1) * src / dst
        cells = []
        i = int(lo)
        while i < hi and i < src:
            cells.append((i, min(hi, i + 1) - max(lo, i))); i += 1
        out.append(cells)
    return out


# Area-averaging resample on premultiplied alpha so transparent pixels never bleed dark edges
def resample(w, h, rows, size):
    pre = []
    for r in rows:
        line = [0.0] * (w * 4)
        for x in range(w):
            a = r[x * 4 + 3]
            line[x * 4] = r[x * 4] * a; line[x * 4 + 1] = r[x * 4 + 1] * a; line[x * 4 + 2] = r[x * 4 + 2] * a; line[x * 4 + 3] = a * 255.0
        pre.append(line)
    xs = spans(w, size); ys = spans(h, size)
    horiz = []
    for line in pre:
        o = [0.0] * (size * 4)
        for dx, cells in enumerate(xs):
            for i, wt in cells:
                o[dx * 4] += line[i * 4] * wt; o[dx * 4 + 1] += line[i * 4 + 1] * wt
                o[dx * 4 + 2] += line[i * 4 + 2] * wt; o[dx * 4 + 3] += line[i * 4 + 3] * wt
        horiz.append(o)
    area = (w / size) * (h / size); out = []
    for cells in ys:
        acc = [0.0] * (size * 4)
        for i, wt in cells:
            src = horiz[i]
            for k in range(size * 4): acc[k] += src[k] * wt
        line = bytearray(size * 4)
        for x in range(size):
            a = acc[x * 4 + 3] / area
            if a > 0.5:
                for c in range(3): line[x * 4 + c] = max(0, min(255, round(acc[x * 4 + c] / area / a * 255.0)))
                line[x * 4 + 3] = max(0, min(255, round(a)))
        out.append(line)
    return out


# 32-bit BMP frames with an AND mask, the layout of the launcher's previous icon
def ico_frame(size, rows):
    pixels = b''.join(bytes((r[x * 4 + 2], r[x * 4 + 1], r[x * 4], r[x * 4 + 3])) for r in reversed(rows) for x in range(size))
    mask_stride = ((size + 31) // 32) * 4; mask = bytearray()
    for r in reversed(rows):
        bits = bytearray(mask_stride)
        for x in range(size):
            if r[x * 4 + 3] == 0: bits[x // 8] |= 0x80 >> (x % 8)
        mask += bits
    head = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return head + pixels + mask


def write_ico(path, frames):
    entries = b''; blobs = b''; offset = 6 + 16 * len(frames)
    for size, rows in frames:
        data = ico_frame(size, rows)
        entries += struct.pack('<BBBBHHII', size % 256, size % 256, 0, 0, 1, 32, len(data), offset + len(blobs))
        blobs += data
    open(path, 'wb').write(struct.pack('<HHH', 0, 1, len(frames)) + entries + blobs)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    w, h, rows = read_png(src)
    assert w == h, 'the lockup must be square'
    scaled = {}
    for size in sorted(set(ICON_SIZES + FAVICON_SIZES + (96, 800, 1024))):
        scaled[size] = resample(w, h, rows, size); print('scaled', size)
    write_png(os.path.join(out, 'logo-1024.png'), 1024, 1024, scaled[1024])
    write_png(os.path.join(out, 'menu-title-logo.png'), 800, 800, scaled[800])
    write_png(os.path.join(out, 'logo-96.png'), 96, 96, scaled[96])
    write_ico(os.path.join(out, 'icon.ico'), [(s, scaled[s]) for s in ICON_SIZES])
    write_ico(os.path.join(out, 'favicon.ico'), [(s, scaled[s]) for s in FAVICON_SIZES])
    for name in sorted(os.listdir(out)): print(name, os.path.getsize(os.path.join(out, name)))


if __name__ == '__main__':
    main()
