#!/usr/bin/env python3
# Step 5: checks the header and masters of the r7 plugin, copies it to r7/AlduinakAdditions.esp, keeps a rollback copy of LIVE and closes the build log.
#   python finalise.py
import json
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import ATTRIBUTION, INPUTS, MANIFEST, R7, SELF, assert_untouched, build_log, check_sha, live_load_order, read_input, step_input  # noqa: E402
from esplib import Plugin  # noqa: E402

OUT = R7 + SELF
ROLLBACK = R7 + 'rollback/' + SELF


def main():
    src, sha = step_input('masks')
    b = open(src, 'rb').read()
    p = Plugin(buf=b)
    assert p.serialize() == b, 'round trip is not exact'
    masters = p.masters()
    hedr = dict(p.header.subs())['HEDR']
    count, nxt = struct.unpack_from('<II', hedr, 4)
    recs, grps = p.counts()
    _, order = live_load_order()
    pos = {x.lower(): i for i, x in enumerate(order)}
    own = [r.fid & 0xFFFFFF for r, _ in p.records() if (r.fid >> 24) == len(masters)]
    assert p.header.flags == 0, f'TES4 flags {p.header.flags:X}'
    assert struct.unpack_from('<H', b, 20)[0] == 44, 'form version is not 44'
    assert hedr[:4] == struct.pack('<f', 1.71), 'HEDR version is not 1.71'
    live = Plugin(buf=read_input('LIVE'))
    live_offset = sum(live.counts()) - struct.unpack_from('<I', dict(live.header.subs())['HEDR'], 4)[0]
    # Mutagen's record count leaves out the same number of groups in every plugin it writes, LIVE included
    assert recs + grps - count == live_offset, f'HEDR count {count} vs {recs} records + {grps} groups, LIVE offset {live_offset}'
    assert all(pos.get(m.lower(), 999) < pos[SELF.lower()] for m in masters), 'a master is not in the server loadOrder before AlduinakAdditions'
    assert all((r.fid >> 24) <= len(masters) for r, _ in p.records()), 'a record uses an index past the master list'
    assert max(own) < nxt, f'next id {nxt:X} is not above the highest own id {max(own):X}'
    with open(OUT, 'wb') as f:
        f.write(b)
    check_sha(OUT, sha)
    os.makedirs(os.path.dirname(ROLLBACK), exist_ok=True)
    with open(ROLLBACK, 'wb') as f:
        f.write(read_input('LIVE'))
    check_sha(ROLLBACK, INPUTS['LIVE'][1])

    at = json.load(open(check_sha(*ATTRIBUTION), encoding='utf-8'))
    chain = json.load(open(MANIFEST, encoding='utf-8'))
    lines = [f'output {OUT}', f'sha256 {sha}', f'size {len(b)} bytes; {recs} records, {grps} groups; HEDR 1.71, count {count} (records + groups - {live_offset}, as LIVE), next id {nxt:X}; TES4 flags 0, form version 44',
             f'masters ({len(masters)}), each in the server loadOrder before AlduinakAdditions (position {pos[SELF.lower()]}):']
    lines += [f'  {i:02X} {m} (load order {pos[m.lower()]})' for i, m in enumerate(masters)]
    lines += ['step chain:'] + [f'  {k}: {v["path"]} {v["sha256"]}' for k, v in chain.items()]
    lines += ['city cells forwarded from the prior winner (NEW\'s children kept):']
    lines += [f'  {c["cell"]} {c["edid"]!r} from {c["prior"]}' for c in at['city_cells'] if c['decision'] == 'FORWARD']
    lines.append('city cells where Graves edited cell fields: ' + (', '.join(at['city_cells_graves_edited']) or 'none'))
    lines.append(f'rollback copy of LIVE: {ROLLBACK} {INPUTS["LIVE"][1]}')
    build_log('step 5 finalise (misc/esp-merge/finalise.py)', lines + assert_untouched())


if __name__ == '__main__':
    main()
