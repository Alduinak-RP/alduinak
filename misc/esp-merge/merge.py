#!/usr/bin/env python3
# Step 2b: runs the Mutagen merge (Program.cs merge) on the padded NEW with R4 and attribution.json.
#   python merge.py
# Writes r7/work/base/AlduinakAdditions.esp and appends the run to r7/build-log.txt.
import os
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import (ATTRIBUTION, INPUTS, REMOVED_NAVM, SELF, STAGE_SETTINGS, STAGE_SETTINGS_SHA, WORK, assert_untouched,  # noqa: E402
                   build_log, check_sha, dotnet, record_output, step_input)
from esplib import Plugin  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'proficiency-patcher'))
from patch import preclean  # noqa: E402

OUT_DIR = WORK + 'base'
R4_CLEAN = WORK + 'r4-preclean/' + SELF
# R4 holds the CK's second LAND in WindhelmPitExterior, which Mutagen refuses; it is one of the 5 LAND Graves removed
R4_DUP_LAND = ['LAND 1A001F7D in cell 0003837D (kept 1A001F7E)']


def main():
    padded, padded_sha = step_input('padded')
    check_sha(*INPUTS['R4'])
    check_sha(*ATTRIBUTION)
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    check_sha(*REMOVED_NAVM)
    os.makedirs(os.path.dirname(R4_CLEAN), exist_ok=True)
    removed = preclean(INPUTS['R4'][0], R4_CLEAN)
    assert removed == R4_DUP_LAND, f'R4 pre-clean removed {removed}'
    r4_sha = record_output('r4-preclean', R4_CLEAN)
    nrec = Plugin(padded).counts()[0]
    code, lines = dotnet(['merge', '--settings', STAGE_SETTINGS, '--new', padded, '--new-sha', padded_sha,
                          '--r4', R4_CLEAN, '--r4-sha', r4_sha, '--attribution', ATTRIBUTION[0],
                          '--attribution-sha', ATTRIBUTION[1], '--removed-navm', REMOVED_NAVM[0], '--records', str(nrec), '--out', OUT_DIR])
    lines = [f'input padded {padded_sha[:8]}, R4 {INPUTS["R4"][1][:8]} pre-cleaned to {r4_sha[:8]} (removed {removed[0]}), attribution {ATTRIBUTION[1][:8]}'] + lines
    out = os.path.join(OUT_DIR, SELF).replace('\\', '/')
    if code == 0:
        b = open(out, 'rb').read()
        assert Plugin(buf=b).serialize() == b, 'esplib round trip of the merged base is not exact'
        lines.append(f'wrote {out} {record_output("base", out)}')
    else:
        lines.append(f'FAILED with exit code {code}')
    build_log('step 2b merge (misc/esp-merge Program.cs merge)', lines + assert_untouched())
    sys.exit(code)


if __name__ == '__main__':
    main()
