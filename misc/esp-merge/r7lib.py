# Shared paths, input hashes and safety checks for the r7 AlduinakAdditions.esp merge scripts.
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
for _p in (os.path.join(HERE, 'tools'), os.path.join(HERE, '..')):
    if os.path.exists(os.path.join(_p, 'esplib.py')) and _p not in sys.path:
        sys.path.insert(0, _p)

ROOT = 'C:/Users/Administrator/Desktop/alduinak-overnight-2026-09-11/'
ESPFIX = ROOT + 'esp-fix/'
R7 = ESPFIX + 'r7/'
STAGE = R7 + 'stage-data/'
STAGE_SETTINGS = R7 + 'server-settings.stage.json'
DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'
SETTINGS = 'C:/Users/Administrator/Desktop/alduinak/build/dist/server/server-settings.json'
SELF = 'AlduinakAdditions.esp'

INPUTS = {
    'NEW': ('C:/Users/Administrator/Desktop/AlduinakAdditions.esp',
            '6017a624da193621020d2b583d7941a4ad4e51221f487fe302a30b26d00ba1ae'),
    'R4': (ESPFIX + 'r4/AlduinakAdditions.final.esp',
           'b1f185d4eb0b1cd2176788c318b2249b8459f90a7b7bd80d05dc38f4bd3afd72'),
    'LIVE': (ESPFIX + 'proficiency/AlduinakAdditions.esp',
             '5bddcc6854fb229e59172a20377cdc8c814fea47124b45d28261c2a4d1eaa508'),
    'RAW': (ROOT + 'rollback-r3/AlduinakAdditions.data-1537.esp',
            '4d8476c758b83a831fe5f29a99763a95c1ed90fc2d2377e98982d6fb28cc509a'),
}
LIVE_COPIES = ['C:/MO2/mods/Alduinak/AlduinakAdditions.esp', DATA + SELF,
               'C:/Users/Administrator/Desktop/alduinak/build/dist/client/Data/AlduinakAdditions.esp']


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
    # The live copies must still be LIVE and the Desktop file must still be NEW
    for p in LIVE_COPIES:
        assert sha_file(p) == INPUTS['LIVE'][1], f'live copy changed: {p}'
    assert sha_file(INPUTS['NEW'][0]) == INPUTS['NEW'][1], 'the Desktop NEW file changed'
    return [f'untouched: {p} {INPUTS["LIVE"][1][:8]}' for p in LIVE_COPIES] + [f'untouched: {INPUTS["NEW"][0]} {INPUTS["NEW"][1][:8]}']


def live_load_order():
    # Only dataDir and loadOrder are read; the rest of the live settings holds secrets
    s = json.load(open(SETTINGS, encoding='utf-8'))
    return s['dataDir'], [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']]
