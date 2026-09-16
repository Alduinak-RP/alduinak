#!/usr/bin/env python3
# Step 3: re-runs the proficiency generator on the merged base with new ids pinned at 0x201D; the result is accepted only when it reproduces LIVE's marker ids.
#   python proficiency.py
# Writes r7/work/prof/ (patch.py output) and appends the acceptance checks to r7/build-log.txt.
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, 'tools')]
from r7lib import (ESPFIX, SELF, STAGE, STAGE_SETTINGS, STAGE_SETTINGS_SHA, WORK, assert_untouched, build_log, check_sha,  # noqa: E402
                   read_input, record_output, sha_file, step_input)
import fastesp  # noqa: E402

PATCHER = os.path.join(HERE, '..', 'proficiency-patcher')
SPEC = (os.path.join(PATCHER, 'spec.json'), 'dd510ba88a126f1b823c2b56eb3623c35a09ac28797a5f8b79fcfd5c87466512')
LIVE_DIR = ESPFIX + 'proficiency/'
# LIVE_LAST_ID ends the block LIVE shipped; the woodcutter's axe recipe took the next id
NEXT_ID, LIVE_LAST_ID, LAST_ID = 0x201D, 0x2092, 0x2093
OWN_RECORDS, ADDED = 119, 1546
OUT = WORK + 'prof/'


def own_block(path, last):
    # (local id, type, editor id) of every own record in the pinned id block
    pl = fastesp.load(path)
    n = len(pl['masters'])
    return sorted((r.fid & 0xFFFFFF, r.type, r.edid()) for r in pl['recs'] if (r.fid >> 24) == n and NEXT_ID <= (r.fid & 0xFFFFFF) <= last)


def verify_counts(path):
    line = next(x for x in open(path, encoding='utf-8') if x.startswith('records:'))
    return line.strip()


def main():
    base, base_sha = step_input('base')
    check_sha(*SPEC)
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    read_input('LIVE')
    r = subprocess.run([sys.executable, os.path.join(HERE, 'stage.py'), '--slot', base, '--slot-sha', base_sha], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert os.path.samefile(STAGE + SELF, base), 'stage slot is not the merged base'
    lines = [f'input base {base_sha[:8]}, spec {SPEC[1][:8]}; stage slot {SELF} -> merged base']

    cmd = [sys.executable, os.path.join(PATCHER, 'patch.py'), '--plugin', base, '--settings', STAGE_SETTINGS, '--spec', SPEC[0],
           '--out', OUT, '--next-form-id', f'0x{NEXT_ID:X}']
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    lines += ['$ ' + ' '.join(cmd)] + [x for x in (r.stdout + r.stderr).splitlines() if not x.startswith('  rewritten ') and not x.startswith('  added ')]
    out = OUT + SELF
    checks = []

    def check(name, ok, detail=''):
        checks.append((ok, f'{"OK  " if ok else "FAIL"} {name}' + (f': {detail}' if detail else '')))

    check('exit code 0', r.returncode == 0, str(r.returncode))
    if r.returncode == 0:
        text = open(OUT + 'verify.txt', encoding='utf-8').read()
        problems = text.split('\n\n', 1)[1].strip() if '\n\n' in text else text
        check('verify.txt has no problems', problems == '', problems[:300])
        pre = OUT + 'AlduinakAdditions.preclean.esp'
        check('preclean removed nothing', 'pre-clean: removed' not in text and sha_file(pre) == base_sha)
        live_ids, ids = open(LIVE_DIR + 'proficiency-ids.json', 'rb').read(), open(OUT + 'proficiency-ids.json', 'rb').read()
        check('proficiency-ids.json byte-equal to the live one', ids == live_ids, f'sha {sha_file(OUT + "proficiency-ids.json")[:8]}')
        pl = fastesp.load(out)
        hsz = struct.unpack_from('<I', pl['buf'], 4)[0]
        nxt = struct.unpack_from('<I', dict(fastesp.subs_of(pl['buf'][24:24 + hsz]))['HEDR'], 8)[0]
        check(f'header next id above 0x{LAST_ID:X}', nxt > LAST_ID, f'{nxt:X}')
        mine, live = own_block(out, LAST_ID), own_block(LIVE_DIR + SELF, LIVE_LAST_ID)
        types = {}
        for _, t, _ in mine:
            types[t] = types.get(t, 0) + 1
        check(f'{OWN_RECORDS} own records at 0x{NEXT_ID:X}-0x{LAST_ID:X}, LIVE\'s ids unmoved by type, id and editor id',
              mine[:len(live)] == live and len(mine) == OWN_RECORDS, str(types))
        check(f'added records match the spec ({OWN_RECORDS} own + {ADDED - OWN_RECORDS} overrides)', f' added {ADDED}' in verify_counts(OUT + 'verify.txt'),
              f'r7: {verify_counts(OUT + "verify.txt")}; LIVE: {verify_counts(LIVE_DIR + "verify.txt")}')
        lines.append(f'masters: {len(pl["masters"])}')
        lines += [f'  {i:02X} {m}' for i, m in enumerate(pl['masters'])]
    lines += [c for _, c in checks]
    ok = all(o for o, _ in checks)
    if ok:
        lines.append(f'accepted {out} {record_output("prof", out)}')
    else:
        lines.append('REJECTED: see the failed checks')
    build_log('step 3 proficiency re-run (misc/proficiency-patcher/patch.py --next-form-id 0x201D)', lines + assert_untouched())
    sys.exit(0 if ok else 4)


if __name__ == '__main__':
    main()
