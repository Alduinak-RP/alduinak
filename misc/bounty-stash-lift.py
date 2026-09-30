# Measures how far each bounty board's strongbox must stand above its visible board's foot to clear the landscape.
# Usage: python misc/bounty-stash-lift.py [server-settings.json]  (default: build/dist/testserver/server-settings.json)
# Prints the winning position of each strongbox anchor (the second ref in bountyBoardSystem.ts BOARDS), the landscape
# under the box footprint from the winning LAND record, and the lift to put in BOARDS or bountyBoardStashLift.
import json
import math
import os
import struct
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fastesp

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANCHORS = {'Whiterun': 0x12cc, 'Riften': 0x9491, 'Windhelm': 0x9477, 'Markarth': 0x94a2, 'Solitude': 0x948f,
           'Dawnstar': 0x94ae, 'Winterhold': 0x94b2, 'Morthal': 0x94aa, 'Falkreath': 0x94a6}
# TreasStrongBox OBND x and y bounds
BOX = (-14, -9, 14, 9)
MARGIN = 2


def gkey(pl, fid):
    idx = fid >> 24
    ms = pl['masters']
    return ((ms[idx] if idx < len(ms) else pl['name']).lower(), fid & 0xFFFFFF)


def group_label(pl, rec, gtype):
    for g, label in rec.path:
        if g == gtype:
            return gkey(pl, label)
    return None


def heights(vhgt):
    off = struct.unpack_from('<f', vhgt, 0)[0]
    g = struct.unpack_from('<1089b', vhgt, 4)
    h, row = [[0.0] * 33 for _ in range(33)], off
    for y in range(33):
        row += g[y * 33]
        col = row
        h[y][0] = col * 8
        for x in range(1, 33):
            col += g[y * 33 + x]
            h[y][x] = col * 8
    return h


def ground(h, lx, ly):
    # Highest of the bilinear value and both triangle splits of the quad
    fx, fy = lx / 128.0, ly / 128.0
    ix, iy = min(int(fx), 31), min(int(fy), 31)
    tx, ty = fx - ix, fy - iy
    z00, z10, z01, z11 = h[iy][ix], h[iy][ix + 1], h[iy + 1][ix], h[iy + 1][ix + 1]
    bil = (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty
    a = z00 + (z10 - z00) * tx + (z11 - z10) * ty if tx >= ty else z00 + (z11 - z01) * tx + (z01 - z00) * ty
    b = z00 + (z10 - z00) * tx + (z01 - z00) * ty if tx + ty <= 1 else z11 + (z01 - z11) * (1 - tx) + (z10 - z11) * (1 - ty)
    return max(bil, a, b)


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, 'build', 'dist', 'testserver', 'server-settings.json')
    settings = json.load(open(path, encoding='utf-8'))
    data = settings['dataDir']
    order = [p.replace('\\', '/').split('/')[-1] for p in settings['loadOrder']]
    anchors, cells, lands = {}, {}, {}
    for name in order:
        pl = fastesp.load(os.path.join(data, name), types={'REFR', 'CELL', 'LAND'})
        for r in pl['recs']:
            if r.flags & 0x20:
                continue
            wrld = group_label(pl, r, 1)
            if r.type == 'REFR':
                k = gkey(pl, r.fid)
                if k[0] == 'missives.esp' and k[1] in ANCHORS.values():
                    anchors[k[1]] = (name, struct.unpack_from('<6f', r.sub('DATA')), wrld)
            elif r.type == 'CELL' and wrld and r.sub('XCLC'):
                cells[(wrld,) + struct.unpack_from('<ii', r.sub('XCLC'))] = gkey(pl, r.fid)
            elif r.type == 'LAND' and r.sub('VHGT'):
                lands[group_label(pl, r, 6)] = (name, r.sub('VHGT'))
    for board, oid in ANCHORS.items():
        if oid not in anchors:
            print(f'{board:10s} anchor {oid:x} not in the load order')
            continue
        src, (x, y, z, _rx, _ry, rz), wrld = anchors[oid]
        c, s = math.cos(rz), math.sin(rz)
        found = []
        for dx, dy in [(0, 0)] + [(dx, dy) for dx in (BOX[0], BOX[2]) for dy in (BOX[1], BOX[3])]:
            wx, wy = x + dx * c + dy * s, y - dx * s + dy * c
            gx, gy = math.floor(wx / 4096), math.floor(wy / 4096)
            land = lands.get(cells.get((wrld, gx, gy)))
            if land:
                found.append((land[0], ground(heights(land[1]), wx - gx * 4096, wy - gy * 4096)))
        line = f'{board:10s} anchor {oid:x} from {src}, foot z {z:.1f}'
        if not found:
            print(f'{line}: no landscape in this worldspace, lift 0')
            continue
        top = max(g for _, g in found)
        lift = max(0, math.ceil(top - z) + MARGIN) if top > z else 0
        print(f'{line}: land from {found[0][0]}, centre {found[0][1] - z:+.1f}, highest under the box {top - z:+.1f}, lift {lift}')


if __name__ == '__main__':
    main()
