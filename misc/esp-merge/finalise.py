#!/usr/bin/env python3
# Step 5: checks the header and masters of the run's plugin, copies it to <run>/AlduinakAdditions.esp, keeps a rollback copy of the deployed plugin and closes the build log.
#   python finalise.py
import json
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import (ATTRIBUTION, DEPLOYED_SHA, INPUTS, RUN, RUN_DIR, SELF, assert_untouched, build_log, check_sha, live_load_order, manifests,  # noqa: E402
                   read_input, step_input)
from esplib import Plugin  # noqa: E402

OUT = RUN_DIR + SELF
ROLLBACK = RUN_DIR + 'rollback/' + SELF
SPEC = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'proficiency-patcher', 'spec.json')


def creations_files(final_sha):
    # Steps 4 and 4b add only ARMO and FURN overrides, which AlduinakCreations.esp never copies, so its inputs file moves to the final plugin
    name = (json.load(open(SPEC, encoding='utf-8')).get('creations') or {}).get('pluginName')
    if not name or not RUN.get('creations'):
        return []
    plugin, plugin_sha = step_input('creations')
    inputs, _ = step_input('creations-inputs')
    _, prof_sha = step_input('prof')
    body = json.load(open(inputs, encoding='utf-8'))
    own = [i for i in body['inputs'] if i['name'] == SELF]
    assert body['plugin'] == name and body['sha256'] == plugin_sha and len(own) == 1 and own[0]['sha256'] == prof_sha, f'{inputs} does not pin the step 3 plugins'
    assert not any(r.type in ('ARMO', 'FURN') for r, _ in Plugin(plugin).records()), f'{name} overrides ARMO or FURN records, which steps 4 and 4b change'
    own[0]['sha256'] = final_sha
    out_dir = os.path.dirname(OUT)
    with open(os.path.join(out_dir, name), 'wb') as f:
        f.write(open(plugin, 'rb').read())
    check_sha(os.path.join(out_dir, name), plugin_sha)
    out_inputs = os.path.join(out_dir, os.path.basename(inputs))
    with open(out_inputs, 'w', encoding='utf-8') as f:
        json.dump(body, f, indent=1)
        f.write('\n')
    return [f'output {os.path.join(out_dir, name)} sha256 {plugin_sha}',
            f'output {out_inputs}: {len(body["inputs"])} plugins, {SELF} re-pinned from step 3 {prof_sha[:8]} to {final_sha[:8]}']


def main():
    src, sha = step_input('thrones')
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
    deployed_buf = read_input('DEPLOYED')
    deployed = Plugin(buf=deployed_buf)
    deployed_offset = sum(deployed.counts()) - struct.unpack_from('<I', dict(deployed.header.subs())['HEDR'], 4)[0]
    # Mutagen's record count leaves out the same number of groups in every plugin it writes, the deployed one included
    assert recs + grps - count == deployed_offset, f'HEDR count {count} vs {recs} records + {grps} groups, deployed offset {deployed_offset}'
    assert all(pos.get(m.lower(), 999) < pos[SELF.lower()] for m in masters), 'a master is not in the server loadOrder before AlduinakAdditions'
    assert all((r.fid >> 24) <= len(masters) for r, _ in p.records()), 'a record uses an index past the master list'
    assert max(own) < nxt, f'next id {nxt:X} is not above the highest own id {max(own):X}'
    with open(OUT, 'wb') as f:
        f.write(b)
    check_sha(OUT, sha)
    os.makedirs(os.path.dirname(ROLLBACK), exist_ok=True)
    with open(ROLLBACK, 'wb') as f:
        f.write(deployed_buf)
    check_sha(ROLLBACK, DEPLOYED_SHA)
    creations = creations_files(sha)

    at = json.load(open(check_sha(*ATTRIBUTION), encoding='utf-8'))
    chain = {}
    for m in reversed(manifests()):
        chain.update(m)
    lines = [f'output {OUT}', f'sha256 {sha}', f'size {len(b)} bytes; {recs} records, {grps} groups; HEDR 1.71, count {count} (records + groups - {deployed_offset}, as deployed), next id {nxt:X}; TES4 flags 0, form version 44',
             f'masters ({len(masters)}), each in the server loadOrder before AlduinakAdditions (position {pos[SELF.lower()]}):']
    lines += [f'  {i:02X} {m} (load order {pos[m.lower()]})' for i, m in enumerate(masters)]
    lines += ['step chain:'] + [f'  {k}: {v["path"]} {v["sha256"]}' for k, v in chain.items()]
    if 'delta' in RUN:
        rows = json.load(open(check_sha(*RUN['delta']), encoding='utf-8'))['records']
        lines += [f'refs replayed from {INPUTS["NEW"][0]} ({len(rows)}):']
        lines += [f'  {r["kind"]} {r["type"]} {r["target"]} in {r["cell"]}: ' + ('; '.join(r['changes']) or 'new own ref') for r in rows]
    else:
        lines += ['city cells forwarded from the prior winner (NEW\'s children kept):']
        lines += [f'  {c["cell"]} {c["edid"]!r} from {c["prior"]}' for c in at['city_cells'] if c['decision'] == 'FORWARD']
        lines.append('city cells where Graves edited cell fields: ' + (', '.join(at['city_cells_graves_edited']) or 'none'))
    lines += creations
    lines.append(f'rollback copy of the deployed plugin: {ROLLBACK} {DEPLOYED_SHA}')
    build_log('step 5 finalise (misc/esp-merge/finalise.py)', lines + assert_untouched())


if __name__ == '__main__':
    main()
