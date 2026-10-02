"""Makes every dynamic havok body of the load order's object meshes fixed, arrows aside, so placed and dropped objects never simulate.

python misc/mesh-patches/freeze_havok.py --out <dir> [--data <Skyrim Data>] [--client <client Data>]
"""
import argparse
import glob
import hashlib
import json
import os
import struct
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import fastesp  # noqa: E402
from bsalib import Bsa  # noqa: E402
from niflib import nif_blocks  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA = 'C:/GOG Games/Skyrim Anniversary Edition - Test/Data/'
CLIENT = os.path.join(REPO, 'build', 'dist', 'testclient', 'Data')
# Base records whose world model may carry a havok body; ARMO's MOD2 and MOD4 are the ground models
MODEL_FIELDS = {'MISC': ['MODL'], 'WEAP': ['MODL'], 'ARMO': ['MOD2', 'MOD4'], 'BOOK': ['MODL'], 'INGR': ['MODL'],
                'ALCH': ['MODL'], 'KEYM': ['MODL'], 'SLGM': ['MODL'], 'SCRL': ['MODL'], 'LIGH': ['MODL'],
                'MSTT': ['MODL'], 'ACTI': ['MODL'], 'FURN': ['MODL'], 'CONT': ['MODL'], 'AMMO': ['MODL']}
EXCLUDED = {'AMMO'}
# bhkRigidBody(T) of a version 100 NIF: 250 bytes plus 4 per constraint ref
BODY_SIZE = 250
MASS, MOTION, QUALITY, CONSTRAINTS = 180, 224, 227, 244
MOTION_KEYFRAMED, MOTION_FIXED, QUALITY_FIXED = 4, 5, 0


def model_users(data):
    users = defaultdict(set)
    for path in sorted(glob.glob(os.path.join(data, '*.es[mpl]'))):
        for rec in fastesp.load(path, set(MODEL_FIELDS))['recs']:
            for field in MODEL_FIELDS[rec.type]:
                for value in rec.all(field):
                    model = value.split(b'\0')[0].decode('latin1').lower().replace('/', '\\')
                    if model:
                        users[model if model.startswith('meshes\\') else 'meshes\\' + model].add(rec.type)
    return users


def reader(data, client):
    archives = [Bsa(p) for p in sorted(glob.glob(os.path.join(data, '*.bsa')))]

    def read(mesh):
        for root in (client, data):
            loose = os.path.join(root, mesh)
            if os.path.isfile(loose):
                with open(loose, 'rb') as f:
                    return f.read()
        for archive in reversed(archives):
            hit = archive.read(mesh)
            if hit is not None:
                return bytes(hit)
        return None
    return read


def freeze(nif):
    """The NIF with its dynamic bodies fixed and massless, or None when it holds none."""
    out = bytearray(nif)
    changed = 0
    for kind, off, size in nif_blocks(nif):
        if kind not in ('bhkRigidBody', 'bhkRigidBodyT'):
            continue
        if size != BODY_SIZE + 4 * struct.unpack_from('<I', nif, off + CONSTRAINTS)[0]:
            raise ValueError(f'unexpected {kind} layout at {off}')
        if nif[off + MOTION] in (MOTION_KEYFRAMED, MOTION_FIXED):
            continue
        out[off + MOTION] = MOTION_FIXED
        out[off + QUALITY] = QUALITY_FIXED
        struct.pack_into('<f', out, off + MASS, 0.0)
        changed += 1
    return bytes(out) if changed else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True, help='folder that receives meshes/...; a staging folder or the client Data')
    ap.add_argument('--data', default=DATA, help='Skyrim Data folder, read-only')
    ap.add_argument('--client', default=CLIENT, help='client Data folder whose loose meshes win, read-only')
    args = ap.parse_args()

    read = reader(args.data, args.client)
    stats = Counter()
    manifest = {}
    for mesh, types in sorted(model_users(args.data).items()):
        if types & EXCLUDED:
            stats['arrow'] += 1
            continue
        source = read(mesh)
        if source is None:
            stats['missing'] += 1
            continue
        try:
            patched = freeze(source)
        except ValueError as e:
            stats['unsupported'] += 1
            print(f'skip {mesh}: {e}')
            continue
        if patched is None:
            stats['no dynamic body'] += 1
            continue
        target = os.path.join(args.out, mesh)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, 'wb') as f:
            f.write(patched)
        manifest[mesh] = {'types': sorted(types), 'source': hashlib.sha256(source).hexdigest(),
                          'result': hashlib.sha256(patched).hexdigest()}
        stats['frozen'] += 1
        stats['bytes'] += len(patched)
    with open(os.path.join(args.out, 'freeze_havok.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    print(', '.join(f'{k} {v}' for k, v in sorted(stats.items())))


if __name__ == '__main__':
    main()
