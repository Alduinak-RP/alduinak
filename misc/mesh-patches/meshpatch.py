"""Steps every mesh patch script shares: read the pinned original from its BSA and write the pinned result loose."""
import argparse
import hashlib
import os
import sys

# misc holds bsalib, niflib and mopp-check
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bsalib import Bsa  # noqa: E402

DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'


def check(ok, message):
    if not ok:
        raise SystemExit(f'FAILED: {message}')


def arguments(archive):
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True,
                    help='folder that receives meshes/...; build/dist/testclient/Data or a staging folder')
    ap.add_argument('--data', default=DATA, help=f'Skyrim Data folder holding {archive}, read-only')
    return ap.parse_args()


def read_source(data, archive, mesh, sha256):
    path = os.path.join(data, archive)
    check(os.path.isfile(path), f'{archive} not in {data}')
    source = Bsa(path).read(mesh.replace('/', '\\'))
    check(source is not None, f'{mesh} not in {archive}')
    check(hashlib.sha256(source).hexdigest() == sha256,
          f'{archive} ships a different {mesh}; the mod changed, redo the diagnosis before patching')
    return source


def write_loose(out, mesh, patched, sha256):
    """Path of the loose NIF written under out, once the result matches its pinned sha256."""
    digest = hashlib.sha256(patched).hexdigest()
    check(digest == sha256, f'patched sha256 {digest} differs from the pinned result')
    target = os.path.join(out, *mesh.split('/'))
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, 'wb') as f:
        f.write(patched)
    check(hashlib.sha256(open(target, 'rb').read()).hexdigest() == digest, f'{target} did not read back identical')
    return target
