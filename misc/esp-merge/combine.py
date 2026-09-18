#!/usr/bin/env python3
# Step 4c: folds AlduinakCreations.esp into AlduinakAdditions.esp (Program.cs combine) and proves both inputs survived whole.
#   python combine.py
# Writes <run>/work/combined/AlduinakAdditions.esp and appends the run to <run>/build-log.txt.
import collections
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, 'tools'), os.path.join(HERE, '..', 'proficiency-patcher')]
from r7lib import (SELF, STAGE_SETTINGS, STAGE_SETTINGS_SHA, WORK, assert_untouched, build_log, check_sha, dotnet,  # noqa: E402
                   live_load_order, record_output, step_input)
from esplib import Plugin, Record  # noqa: E402
from verify_creations import ESL, norm_zero  # noqa: E402

SPEC = os.path.join(HERE, '..', 'proficiency-patcher', 'spec.json')
OUT_DIR = WORK + 'combined'
# Group types whose label is the form id of the record holding them
PARENT_GROUPS = (1, 6, 8, 9)
# A record of any other type in both plugins would lose one of its two versions
CONTAINERS = ('CELL', 'WRLD')


def records(p, name):
    # (owner plugin, local id) -> (record, group path), with the master list and the plugin's own index
    masters = [m.lower() for m in p.masters()]
    own = len(masters)
    out = {}
    for n, parents in p.walk():
        if isinstance(n, Record):
            i = n.fid >> 24
            out[(masters[i] if i < own else name.lower(), n.fid & 0xFFFFFF)] = (n, tuple((g.gtype, g.label) for g in parents))
    return masters, own, out


def index_map(masters, own, out_masters, out_own):
    # Source master index -> index in the merged plugin; its own records and its AlduinakAdditions master both land on the own index
    t = {i: (out_own if m == SELF.lower() else out_masters.index(m)) for i, m in enumerate(masters)}
    t[own] = out_own
    return t


def same_bytes(x, y, t):
    # Equal except where a byte is a source master index carrying the index the merged plugin gives it
    x, y = norm_zero(x), norm_zero(y)
    return len(x) == len(y) and all(a == b or t.get(b) == a for a, b in zip(x, y))


def differs(out, src, t):
    orec, opath = out
    rec, path = src
    if orec.type != rec.type or orec.flags != rec.flags:
        return f'{rec.type} flags {rec.flags:#x} -> {orec.type} flags {orec.flags:#x}'
    a, b = orec.subs(), rec.subs()
    if [x for x, _ in a] != [x for x, _ in b]:
        return f'subrecords {[x for x, _ in b]} -> {[x for x, _ in a]}'
    bad = [ta for (ta, va), (_, vb) in zip(a, b) if not same_bytes(va, vb, t)]
    if bad:
        return f'subrecord {bad[0]}'
    if len(opath) != len(path) or any(g != h for (g, _), (h, _) in zip(opath, path)):
        return f'group path {[g for g, _ in path]} -> {[g for g, _ in opath]}'
    for (g, ol), (_, sl) in zip(opath, path):
        moved = t.get(sl >> 24) != (ol >> 24) or (ol & 0xFFFFFF) != (sl & 0xFFFFFF) if g in PARENT_GROUPS else ol != sl
        if moved:
            return f'group {g} label {sl:08X} -> {ol:08X}'
    return None


def check(out_path, src_path, cre_path):
    cs = json.load(open(SPEC, encoding='utf-8'))['creations']
    cre_name = cs['pluginName']
    b = open(out_path, 'rb').read()
    po, pa, pc = Plugin(buf=b), Plugin(src_path), Plugin(cre_path)
    assert po.serialize() == b, 'esplib round trip of the merged plugin is not exact'
    assert pa.header.flags == 0 and pc.header.flags & ESL, 'the inputs are not a full plugin and an ESL one'
    assert po.header.flags == 0, f'the merged plugin has header flags {po.header.flags:#x}, the ESL flag must be off'
    assert struct.unpack_from('<H', b, 20)[0] == 44, 'form version is not 44'

    mo, oo, ro = records(po, SELF)
    ma, oa, ra = records(pa, SELF)
    mc, oc, rc = records(pc, cre_name)
    _, order = live_load_order(STAGE_SETTINGS)
    pos = {n.lower(): i for i, n in enumerate(order)}
    want = [n for n in order[:pos[SELF.lower()]] if n.lower() in set(ma) | set(mc)]
    assert [m.lower() for m in want] == mo, f'masters {mo} are not the load order union {want}'
    missing = [n for n in cs['plugins'] if n.lower() not in mo]
    assert not missing, f'the merged plugin does not master {missing}'
    assert SELF.lower() not in mo and cre_name.lower() not in mo, 'the plugin masters itself or the merged plugin'

    shared = set(ra) & set(rc)
    assert set(ro) == set(ra) | set(rc), f'{len((set(ra) | set(rc)) - set(ro))} records lost, {len(set(ro) - set(ra) - set(rc))} invented'
    bad = sorted(k for k in shared if ra[k][0].type not in CONTAINERS)
    assert not bad, f'{len(bad)} records are in both plugins and are not containers, first {bad[:5]}'
    ta, tc = index_map(ma, oa, mo, oo), index_map(mc, oc, mo, oo)
    problems = []
    for key, rec in ro.items():
        for src, t, tag in ((ra.get(key), ta, SELF), (rc.get(key), tc, cre_name)):
            why = src and differs(rec, src, t)
            if why:
                problems.append(f'{rec[0].type} {key[0]}:{key[1]:06X} against {tag}: {why}')
    assert not problems, f'{len(problems)} records differ from their source, first 5: {problems[:5]}'

    own_out = sorted(k[1] for k in ro if k[0] == SELF.lower())
    own_src = sorted(k[1] for k in ra if k[0] == SELF.lower())
    assert own_out == own_src, 'the plugin\'s own local form ids moved'
    hedr = lambda p: struct.unpack_from('<II', dict(p.header.subs())['HEDR'], 4)
    assert hedr(po)[1] == hedr(pa)[1], f'next form id {hedr(po)[1]:X} is not step 4b\'s {hedr(pa)[1]:X}'
    types = collections.Counter(rc[k][0].type for k in set(rc) - shared)
    return [f'merged {len(ra)} records of {SELF} and {len(rc)} of {cre_name} into {len(ro)} ({len(shared)} containers held by both)',
            'added by type: ' + ', '.join(f'{t} {n}' for t, n in sorted(types.items())),
            f'masters {len(ma)} -> {len(mo)}, each in the staged load order before {SELF}: ' + ', '.join(m for m in want if m.lower() not in set(ma)) + ' added',
            f'checked: header flags 0 (not ESL), form version 44, next id {hedr(po)[1]:X} and the {len(own_src)} own local ids unchanged',
            f'checked: every record of both inputs is in the merged plugin, byte-equal subrecord by subrecord with the master '
            f'indices remapped, and under the same groups; the {len(shared)} shared containers match both versions']


def main():
    src, src_sha = step_input('thrones')
    cre, cre_sha = step_input('creations')
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    code, lines = dotnet(['combine', '--settings', STAGE_SETTINGS, '--plugin', src, '--plugin-sha', src_sha,
                          '--extra', cre, '--extra-sha', cre_sha, '--out', OUT_DIR])
    lines = [f'input thrones {src_sha[:8]}, creations {cre_sha[:8]}'] + lines
    out = os.path.join(OUT_DIR, SELF).replace('\\', '/')
    if code == 0:
        lines += check(out, src, cre)
        lines.append(f'wrote {out} {record_output("combined", out)}')
    else:
        lines.append(f'FAILED with exit code {code}')
    build_log('step 4c creations merge (misc/esp-merge Program.cs combine)', lines + assert_untouched())
    sys.exit(code)


if __name__ == '__main__':
    main()
