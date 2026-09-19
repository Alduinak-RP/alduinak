# Shared paths, input hashes and safety checks for the AlduinakAdditions.esp merge scripts; ESP_MERGE_RUN picks the run (default r7).
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
R11 = ESPFIX + 'r11/'
DATA = 'C:/GOG Games/Skyrim Anniversary Edition/Data/'
SETTINGS = 'C:/Users/Administrator/Desktop/alduinak/build/dist/server/server-settings.json'
SELF = 'AlduinakAdditions.esp'

LIVE_COPIES = ['C:/MO2/mods/Alduinak/AlduinakAdditions.esp', DATA + SELF,
               'C:/Users/Administrator/Desktop/alduinak/build/dist/client/Data/AlduinakAdditions.esp']
# What the live copies hold today: the r14 plugin, deployed 2026-09-18. Re-pin after every deploy.
DEPLOYED_SHA = '44b09ceac80703a9ec87ad879d7af850e656b4932abf22368227009f55992fb4'
# The r7 plugin, which the r11 run merged from and still pins
R7_SHA = 'be1cb8e313d06877b4e585340cd9fb0659ad843f243b84c6dd4594dc93c726c9'

_R7_RUN = {
    'dir': R7,
    # stage-data, server-settings.stage.json and stage-log.txt live in this folder
    'stage': R7,
    'stage_sha': 'f9dce8d45661830ed8eb307542250da6ca1158d4eeb6f42e7b2416611417cb22',
    # Graves's 2026-09-14 CK save; the Desktop copy was overwritten on 2026-09-16
    'NEW': ('C:/Users/Administrator/Desktop/AlduinakAdditions.esp', '6017a624da193621020d2b583d7941a4ad4e51221f487fe302a30b26d00ba1ae'),
    # The plugin NEW was edited from
    'R4': (ESPFIX + 'r4/AlduinakAdditions.final.esp', 'b1f185d4eb0b1cd2176788c318b2249b8459f90a7b7bd80d05dc38f4bd3afd72'),
    'RAW': (ROOT + 'rollback-r3/AlduinakAdditions.data-1537.esp', '4d8476c758b83a831fe5f29a99763a95c1ed90fc2d2377e98982d6fb28cc509a'),
    'attribution': (R7 + 'attribution.json', '031388679ed48a92032cd7873302051b28cc37854ff1cd376305d148b44d880c'),
    # The padded copy is the only surviving copy of NEW, so it is the file every step checks is untouched
    'frozen': (R7 + 'work/padded/AlduinakAdditions.esp', 'db02e960afd166a5243634231c0cdbc5e51982dc5ad3e2cb612a2f5a0814da88'),
    'spec': '267ec7447c0d667cf8408e1bfd7d1ace46b777d2a44a9b949036e23435cc9bab',
    'live_last_id': 0x2092, 'last_id': 0x2092, 'own_records': 118, 'added': 767,
    # The plugin's full slot in the staged load order, which proficiency-ids.json carries
    'slot': 0x2B,
}
_R11_RUN = {
    'dir': R11,
    'stage': R11,
    'stage_sha': '57ea2a7da9bec479775d4574533cfa52098662ab251ed36818ac17be67db9c8a',
    # Graves's 2026-09-16 CK save, frozen from the Desktop
    'NEW': (R11 + 'input/AlduinakAdditions.esp', 'f8cefed985c9f35c06d4cb8d0c687f746bcf88e44665580e9791b2a5298157e9'),
    # The live r7 plugin he started from, which is also the attribution's RAW
    'R4': (R7 + 'AlduinakAdditions.esp', R7_SHA),
    'RAW': (R7 + 'AlduinakAdditions.esp', R7_SHA),
    'attribution': (R11 + 'attribution.json', '8be205420aa2cf909e17679010fd081428d78396c3db6d9a59a8b7c3e38dfcaa'),
    # The records attribute.py found to be Graves's own work; delta.py writes exactly these
    'delta': (R11 + 'delta.json', 'b76a9e758bed4876b30e9d3ff510375f537199662b5821fdfad65d1c1194f92c'),
    'frozen': (R11 + 'input/AlduinakAdditions.esp', 'f8cefed985c9f35c06d4cb8d0c687f746bcf88e44665580e9791b2a5298157e9'),
    # The r7 merged base the replay writes onto, and the staged r10 plugin the replay check compares with
    'BASE': (R7 + 'work/base/AlduinakAdditions.esp', '15ecf7a40cb3539da169045d77a6180d01a551966986ab98f11df5c0372fecc4'),
    'R10': (ESPFIX + 'r10/AlduinakAdditions.esp', 'ad651b18d2b068ca30267dc75ea929abb7807539a847e594b658949169ef47a9'),
    'spec': '84a4eb15ddfb888151acf848a49c9884e0bf528c6512a0db871e4e779acf4b6d',
    'live_last_id': 0x2092, 'last_id': 0x20B4, 'own_records': 152, 'added': 1591,
    # Stages the Creation Club plugins of the patcher spec and builds AlduinakCreations.esp in step 3
    'creations': True,
    # The two ESM-flagged Creations take full slots before the plugin; the ESL ones take light slots
    'slot': 0x2D,
}
RUNS = {
    'r7': _R7_RUN,
    # r7's merged base re-run through steps 3-5 with the woodcutter's axe spec; it used r7's stage folder
    'r10': dict(_R7_RUN, dir=ESPFIX + 'r10/', chain='r7', spec='dd510ba88a126f1b823c2b56eb3623c35a09ac28797a5f8b79fcfd5c87466512',
                last_id=0x2093, own_records=119, added=1546),
    # Graves's 2026-09-16 records replayed onto r7's merged base (delta.py), then steps 3-5 with the integrated r11 spec
    'r11': _R11_RUN,
    # The replay check: r11's replayed base through steps 3-5 with the r10 spec, compared with r10 by verify_replay.py
    'r11-graves': dict(_R11_RUN, dir=R11 + 'graves-replay/', stage=R11 + 'graves-replay/', chain='r11', creations=False, slot=0x2B,
                       stage_sha='619a0967dd4444cb4e3d33fbbb5278d9c5057832b6b01bd9771dfb40109c670d',
                       spec='dd510ba88a126f1b823c2b56eb3623c35a09ac28797a5f8b79fcfd5c87466512', last_id=0x2093, own_records=119, added=1546),
    # r11's replayed base through steps 3-5 with the charcoal spec; 'merge' adds step 4c, which folds AlduinakCreations.esp
    # into the plugin, and makes step 5 read the 'combined' tag and ship one plugin with AlduinakAdditions.inputs.json.
    # PLACEHOLDERS to re-pin from the run before it is trusted: 'spec' (sha256 of proficiency-patcher/spec.json as it sits
    # on disk, line endings included), 'added', 'own_records' and 'last_id' (step 3 prints the values it saw when a check
    # fails, and work/prof/verify.txt has the counts), 'hedr_offset' (step 5 prints the offset it saw). The values below
    # are r11's plus the offset of a trial merge of the r11 outputs, so a wrong one stops the run instead of shipping.
    # added is r11's 1591 plus the two Novice ore recipes (iron, corundum) the charcoal rule now overrides
    'r12': dict(_R11_RUN, dir=ESPFIX + 'r12/', chain='r11', merge=True, hedr_offset=51,
                spec='7fa5937bc041cbd6045e4ad824857203fc804bddd6ab9f874b624986b05214c4',
                last_id=0x20B4, own_records=152, added=1593),
    # r12's pipeline with the professions spec: bench routing, the Anyone tier, the tools and instruments,
    # the crafting categories, and the race and faction gates. Same base, stage and step 4c as r12.
    'r13': dict(_R11_RUN, dir=ESPFIX + 'r13/', chain='r11', merge=True, hedr_offset=51,
                spec='4ed169367aa1f3e3171ee859054ff13f5835126410385260c797096c6ec132a3',
                last_id=0x2100, own_records=190, added=2848,
                # Ale, wine and Nord mead left the alchemy table for the meadery keyword, as AldRecipeMead_*
                dropped=('AldRecipeAlchemy_Ale', 'AldRecipeAlchemy_FoodMead', 'AldRecipeAlchemy_FoodWineBottle02')),
    # The owner's 2026-09-18 mod additions (Immersive Armors and Weapons, beards, eyewear, antlers, salt deposits)
    # and a re-sorted load order: 79 base plugins instead of 71, its own stage, and the full slot at 0x32.
    # PLACEHOLDERS to re-pin from the run: 'stage_sha' (step 0 prints it), 'added', 'own_records', 'last_id'.
    'r14': dict(_R11_RUN, dir=ESPFIX + 'r14/', stage=ESPFIX + 'r14/', chain='r11', merge=True, hedr_offset=51,
                stage_sha='2b62c107bbb92cbfb732802fe18d99988cd3a3afe8c478dc511587e48e25f3de', base_plugins=79, slot=0x32,
                spec='75bf111ac95047e28a8ab7c3d6aad4be5e8e643868dba7b2e12118212308a27b',
                last_id=0x2100, own_records=191, added=5775,
                dropped=('AldRecipeAlchemy_Ale', 'AldRecipeAlchemy_FoodMead', 'AldRecipeAlchemy_FoodWineBottle02')),
}
RUN_NAME = os.environ.get('ESP_MERGE_RUN', 'r7')
assert RUN_NAME in RUNS, f'ESP_MERGE_RUN {RUN_NAME} is not one of {sorted(RUNS)}'
RUN = RUNS[RUN_NAME]
RUN_DIR = RUN['dir']
STAGE = RUN['stage'] + 'stage-data/'
STAGE_SETTINGS = RUN['stage'] + 'server-settings.stage.json'
STAGE_SETTINGS_SHA = RUN['stage_sha']

INPUTS = {
    'NEW': RUN['NEW'],
    'R4': RUN['R4'],
    # The pre-r7 proficiency plugin, the frozen reference the marker id checks compare against
    'LIVE': (ESPFIX + 'proficiency/AlduinakAdditions.esp',
             '5bddcc6854fb229e59172a20377cdc8c814fea47124b45d28261c2a4d1eaa508'),
    # The plugin a new output replaces, read back from the first live copy
    'DEPLOYED': (LIVE_COPIES[0], DEPLOYED_SHA),
    'RAW': RUN['RAW'],
}
INPUTS.update({k: RUN[k] for k in ('BASE', 'R10') if k in RUN})
ATTRIBUTION = RUN['attribution']
REMOVED_NAVM = (ESPFIX + 'tools/removed-navm.txt', '48763ffc1347aac94e6b35cb7cfe49b0ba20b8b8e1c921df1ef70af304ece7c8')
WORK = RUN_DIR + 'work/'
MANIFEST = WORK + 'manifest.json'
BUILD_LOG = RUN_DIR + 'build-log.txt'


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
    # The live copies must still be the deployed plugin and the run's frozen input must still be unchanged
    for p in LIVE_COPIES:
        assert sha_file(p) == DEPLOYED_SHA, f'live copy changed: {p}'
    path, want = RUN['frozen']
    assert sha_file(path) == want, f'the frozen input changed: {path}'
    return [f'untouched: {p} {DEPLOYED_SHA[:8]}' for p in LIVE_COPIES] + [f'untouched: {path} {want[:8]}']


def check_sha(path, want):
    got = sha_file(path)
    assert got == want, f'{path}: sha256 {got} is not the expected {want}'
    return path


def record_output(tag, path):
    # Each step records its output here and the next step asserts it, so every intermediate file is sha-pinned
    m = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else {}
    m[tag] = {'path': path, 'sha256': sha_file(path)}
    os.makedirs(WORK, exist_ok=True)
    with open(MANIFEST, 'w', encoding='utf-8') as f:
        json.dump(m, f, indent=1)
    return m[tag]['sha256']


def manifests():
    # this run's manifest, then those of the runs it chains to
    run, out = RUN, []
    while True:
        path = run['dir'] + 'work/manifest.json'
        out.append(json.load(open(path, encoding='utf-8')) if os.path.exists(path) else {})
        if 'chain' not in run:
            return out
        run = RUNS[run['chain']]


def step_input(tag):
    # A step missing from this run's manifest comes from the run it chains to
    e = next((m[tag] for m in manifests() if tag in m), None)
    assert e, f'no {tag} output in the manifests of run {RUN_NAME}'
    return check_sha(e['path'], e['sha256']), e['sha256']


def build_log(title, lines):
    os.makedirs(RUN_DIR, exist_ok=True)
    with open(BUILD_LOG, 'a', encoding='utf-8') as f:
        f.write(f'== {title} ({RUN_NAME})\n' + '\n'.join(lines) + '\n\n')
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
