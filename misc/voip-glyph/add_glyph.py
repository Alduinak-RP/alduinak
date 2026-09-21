import struct, zlib, sys
SRC_FONT, PNG, OUT, CODE, H = sys.argv[1], sys.argv[2], sys.argv[3], 0xE000, int(sys.argv[4]) if len(sys.argv) > 4 else 36

def read_png(path):
    b = open(path, 'rb').read(); o = 8; idat = b''
    while o < len(b):
        ln, typ = struct.unpack('>I4s', b[o:o+8]); data = b[o+8:o+8+ln]; o += 12 + ln
        if typ == b'IHDR': w, h, depth, ctype = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT': idat += data
    assert depth == 8 and ctype == 6
    raw = zlib.decompress(idat); bpp = 4; stride = w * bpp; rows = []; prev = bytearray(stride); p = 0
    for _ in range(h):
        f = raw[p]; line = bytearray(raw[p+1:p+1+stride]); p += 1 + stride
        for i in range(stride):
            a = line[i-bpp] if i >= bpp else 0; up = prev[i]; c = prev[i-bpp] if i >= bpp else 0
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + up) & 255
            elif f == 3: line[i] = (line[i] + (a + up) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(up - c), abs(a - c), abs(a + up - 2*c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        rows.append(line); prev = line
    return w, h, rows

w, h, rows = read_png(PNG)
alpha = [[r[x*4+3] for x in range(w)] for r in rows]
ys = [y for y in range(h) if max(alpha[y]) > 8]; xs = [x for x in range(w) if any(alpha[y][x] > 8 for y in ys)]
x0, x1, y0, y1 = xs[0], xs[-1] + 1, ys[0], ys[-1] + 1
W = round((x1 - x0) * H / (y1 - y0))
icon = []
for ty in range(H):
    sy0, sy1 = y0 + (y1-y0)*ty//H, y0 + (y1-y0)*(ty+1)//H
    row = []
    for tx in range(W):
        sx0, sx1 = x0 + (x1-x0)*tx//W, x0 + (x1-x0)*(tx+1)//W
        tot = sum(alpha[y][x] for y in range(sy0, sy1) for x in range(sx0, sx1)); n = (sy1-sy0)*(sx1-sx0)
        row.append(tot // n)
    icon.append(row)

f = open(SRC_FONT, 'rb').read(); n = struct.unpack_from('<I', f, 8)[0]; go = 12
glyphs = [struct.unpack_from('<I4i3f', f, go + i*32) for i in range(n)]
o = go + n*32; ls, dc = struct.unpack_from('<fI', f, o); o += 8
tw, th, fmt, stride, trows = struct.unpack_from('<5I', f, o); o += 20
assert fmt == 28 and trows == th and glyphs[-1][0] < CODE
tex = bytearray(f[o:o+stride*th])
pad = 2; nth = th + H + pad
tex += bytearray(stride * (H + pad))
for y in range(H):
    for x in range(W):
        a = icon[y][x]; p = (th + pad + y) * stride + (pad + x) * 4
        tex[p:p+4] = bytes((a, a, a, a))
cap = [g for g in glyphs if g[0] == ord('A')][0]
yoff = cap[6] + (cap[4]-cap[2]) - H + 2
glyphs.append((CODE, pad, th + pad, pad + W, th + pad + H, 0.0, float(yoff), 6.0))
out = b'DXTKfont' + struct.pack('<I', n + 1) + b''.join(struct.pack('<I4i3f', *g) for g in glyphs)
out += struct.pack('<fI', ls, dc) + struct.pack('<5I', tw, nth, fmt, stride, nth) + bytes(tex)
open(OUT, 'wb').write(out)
print('icon', W, 'x', H, 'crop', (x0, y0, x1, y1), 'yoff', yoff, 'tex', tw, nth, 'bytes', len(out))
for r in icon[::3]: print(''.join(' .:-=+*#%@'[v*9//255] for v in r))
