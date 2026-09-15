#!/usr/bin/env python3
# Step 4: strips the enchantment from the 8 crafted Kad_BogBlightMask.esp funerary masks (Program.cs armor-effects) and proves nothing else changed.
#   python masks.py
# Writes r7/work/masks/AlduinakAdditions.esp and appends the run to r7/build-log.txt.
import os
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import (SELF, STAGE, STAGE_SETTINGS, STAGE_SETTINGS_SHA, WORK, assert_untouched, build_log, canon_subs, check_sha, dotnet,  # noqa: E402
                   record_output, step_input)
from esplib import Plugin  # noqa: E402

SOURCE = 'Kad_BogBlightMask.esp'
EFFECT = 0x00081B
MASKS = [0x00081E] + list(range(0x000820, 0x000827))
OUT_DIR = WORK + 'masks'
# ARMO subrecords made of form ids; MO2S-MO5S hold one inside each alternate texture entry
FID_SUBS = {'KWDA', 'EITM', 'ETYP', 'BIDS', 'BAMT', 'RNAM', 'TNAM', 'YNAM', 'ZNAM', 'MODL'}
ALT_TEXTURES = {'MO2S', 'MO3S', 'MO4S', 'MO5S'}


def main():
    prof, prof_sha = step_input('prof')
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    code, lines = dotnet(['armor-effects', '--settings', STAGE_SETTINGS, '--plugin', prof, '--plugin-sha', prof_sha, '--source', SOURCE,
                          '--effect', f'{EFFECT:06X}', '--expect', ','.join(f'{x:06X}' for x in MASKS), '--out', OUT_DIR])
    lines = [f'input prof {prof_sha[:8]}'] + lines
    out = os.path.join(OUT_DIR, SELF).replace('\\', '/')
    if code == 0:
        a, b = Plugin(prof), Plugin(out)
        assert b.serialize() == open(out, 'rb').read(), 'esplib round trip of the masks output is not exact'
        assert a.masters() == b.masters(), 'master list changed'
        ra = {(r.type, r.fid): r for r, _ in a.records()}
        rb = {(r.type, r.fid): r for r, _ in b.records()}
        ki = b.masters().index(SOURCE)
        added = sorted(set(rb) - set(ra))
        assert not set(ra) - set(rb), 'records disappeared'
        assert added == sorted(('ARMO', (ki << 24) | x) for x in MASKS), f'added {added}'
        changed = [k for k in ra if ra[k].serialize() != rb[k].serialize()]
        assert not changed, f'{len(changed)} other records changed, first {changed[:5]}'
        kad = Plugin(STAGE + SOURCE)
        kr = {r.fid: r for r, _ in kad.records() if r.type == 'ARMO'}
        for _, fid in added:
            want = [s for s in canon_subs(kad.masters(), kr[(len(kad.masters()) << 24) | (fid & 0xFFFFFF)], SOURCE, FID_SUBS, ALT_TEXTURES) if s[0] != 'EITM']
            got = canon_subs(b.masters(), rb[('ARMO', fid)], SELF, FID_SUBS, ALT_TEXTURES)
            assert got == want, f'ARMO {fid:08X} is not Kad\'s record minus EITM: {[t for t, _ in got]} vs {[t for t, _ in want]}'
        lines += [f'checked: master list unchanged ({len(b.masters())}), exactly 8 new ARMO overrides, every other record byte-equal to step 3',
                  'checked: each override equals Kad\'s record minus EITM, subrecord by subrecord with form ids normalised',
                  f'wrote {out} {record_output("masks", out)}']
    else:
        lines.append(f'FAILED with exit code {code}')
    build_log('step 4 funerary masks (misc/esp-merge Program.cs armor-effects)', lines + assert_untouched())
    sys.exit(code)


if __name__ == '__main__':
    main()
