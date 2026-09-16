# Shared paths, input hashes and safety checks for the r7 AlduinakAdditions.esp merge scripts.
import hashlib
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(HERE, 'tools'), os.path.join(HERE, '..')):
    if os.path.exists(os.path.join(_p, 'esplib.py')) and _p not in sys.path:
        sys.path.insert(0, _p)
from esplib import Group  # noqa: E402

ROOT = 'C:/Users/Administrator/Desktop/alduinak-overnight-2026-09-11/'
ESPFIX = ROOT + 'esp-fix/'
R7 = ESPFIX + 'r7/'
STAGE = R7 + 'stage-data/'
STAGE_SETTINGS = R7 + 'server-settings.stage.json'
DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'
SETTINGS = 'C:/Users/Administrator/Desktop/alduinak/build/dist/server/server-settings.json'
SELF = 'AlduinakAdditions.esp'

LIVE_COPIES = ['C:/MO2/mods/Alduinak/AlduinakAdditions.esp', DATA + SELF,
               'C:/Users/Administrator/Desktop/alduinak/build/dist/client/Data/AlduinakAdditions.esp']
# What the live copies hold today: the r7 plugin, deployed 2026-09-15. Re-pin after every deploy.
DEPLOYED_SHA = 'be1cb8e313d06877b4e585340cd9fb0659ad843f243b84c6dd4594dc93c726c9'

INPUTS = {
    'NEW': ('C:/Users/Administrator/Desktop/AlduinakAdditions.esp',
            '6017a624da193621020d2b583d7941a4ad4e51221f487fe302a30b26d00ba1ae'),
    'R4': (ESPFIX + 'r4/AlduinakAdditions.final.esp',
           'b1f185d4eb0b1cd2176788c318b2249b8459f90a7b7bd80d05dc38f4bd3afd72'),
    # The pre-r7 proficiency plugin, the frozen reference the marker id checks compare against
    'LIVE': (ESPFIX + 'proficiency/AlduinakAdditions.esp',
             '5bddcc6854fb229e59172a20377cdc8c814fea47124b45d28261c2a4d1eaa508'),
    # The plugin a new r7 output replaces, read back from the first live copy
    'DEPLOYED': (LIVE_COPIES[0], DEPLOYED_SHA),
    'RAW': (ROOT + 'rollback-r3/AlduinakAdditions.data-1537.esp',
            '4d8476c758b83a831fe5f29a99763a95c1ed90fc2d2377e98982d6fb28cc509a'),
}
ATTRIBUTION = (R7 + 'attribution.json', '031388679ed48a92032cd7873302051b28cc37854ff1cd376305d148b44d880c')
STAGE_SETTINGS_SHA = 'f9dce8d45661830ed8eb307542250da6ca1158d4eeb6f42e7b2416611417cb22'
REMOVED_NAVM = (ESPFIX + 'tools/removed-navm.txt', '48763ffc1347aac94e6b35cb7cfe49b0ba20b8b8e1c921df1ef70af304ece7c8')
WORK = R7 + 'work/'
MANIFEST = WORK + 'manifest.json'
BUILD_LOG = R7 + 'build-log.txt'


def sha_bytes(b):
    return hashlib.sha256(b).hexdigest()


def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def read_input(tag):
    path, want = INPUTS[tag]
    b = open(path, 'rb').read()
    got = sha_bytes(b)
    assert got == want, f'{tag} {path}: sha256 {got} is not the expected {want}'
    return b


def assert_untouched():
    # The live copies must still be the deployed plugin and the Desktop file must still be NEW
    for p in LIVE_COPIES:
        assert sha_file(p) == DEPLOYED_SHA, f'live copy changed: {p}'
    assert sha_file(INPUTS['NEW'][0]) == INPUTS['NEW'][1], 'the Desktop NEW file changed'
    return [f'untouched: {p} {DEPLOYED_SHA[:8]}' for p in LIVE_COPIES] + [f'untouched: {INPUTS["NEW"][0]} {INPUTS["NEW"][1][:8]}']


def check_sha(path, want):
    got = sha_file(path)
    assert got == want, f'{path}: sha256 {got} is not the expected {want}'
    return path


def record_output(tag, path):
    # Each step records its output here and the next step asserts it, so every intermediate file is sha-pinned
    m = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else {}
    m[tag] = {'path': path, 'sha256': sha_file(path)}
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(m, f, indent=1)
    return m[tag]['sha256']


def step_input(tag):
    e = json.load(open(MANIFEST, encoding='utf-8'))[tag]
    return check_sha(e['path'], e['sha256']), e['sha256']


def build_log(title, lines):
    with open(BUILD_LOG, 'a', encoding='utf-8') as f:
        f.write(f'== {title}\n' + '\n'.join(lines) + '\n\n')
    print('\n'.join(lines))


def dotnet(args):
    # Runs the esp-merge Mutagen tool next to this file; returns (exit code, output lines)
    r = subprocess.run(['dotnet', 'run', '-c', 'Release', '--project', HERE, '--'] + args,
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    return r.returncode, (r.stdout + r.stderr).splitlines()


def live_load_order(settings=SETTINGS):
    # Only dataDir and loadOrder are read; the rest of the live settings holds secrets
    s = json.load(open(settings, encoding='utf-8'))
    return s['dataDir'], [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']]


def flat(p, skip=()):
    # every node in file order; group headers without their size field
    out = []
    for n, _ in p.walk():
        if isinstance(n, Group):
            h = bytearray(n.hdr)
            h[4:8] = b'\0\0\0\0'
            out.append(bytes(h))
        elif n.fid not in skip:
            out.append(bytes(n.hdr) + bytes(n.raw))
    return out


def norm(masters, name, fid):
    i = fid >> 24
    return (masters[i] if i < len(masters) else name, fid & 0xFFFFFF) if fid else ('', 0)


def canon_subs(masters, rec, name, fid_subs, alt_subs):
    # subrecords with every form id replaced by (plugin, local id); alt_subs hold one inside each alternate texture entry
    out = []
    for t, v in rec.subs():
        if t in fid_subs:
            v = tuple(norm(masters, name, x) for x in struct.unpack(f'<{len(v) // 4}I', v))
        elif t in alt_subs:
            n, o, ents = struct.unpack_from('<I', v, 0)[0], 4, []
            for _ in range(n):
                ln = struct.unpack_from('<I', v, o)[0]
                fid, index = struct.unpack_from('<II', v, o + 4 + ln)
                ents.append((v[o + 4:o + 4 + ln], norm(masters, name, fid), index))
                o += 12 + ln
            assert o == len(v), f'{t} parse overran'
            v = tuple(ents)
        out.append((t, v))
    return out
