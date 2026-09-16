#!/usr/bin/env python3
# Independent check of a replay run, read-only and without delta.py's code: base vs r7's base, each replayed ref vs its original, the winner and live, and the finished plugin vs r10.
#   ESP_MERGE_RUN=r11-graves python verify_replay.py
# The plugin check runs once the run has its own thrones output; exits 3 when a check fails.
import json
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import INPUTS, MANIFEST, RUN, RUNS, SELF, STAGE_SETTINGS, STAGE_SETTINGS_SHA, assert_untouched, build_log, check_sha, live_load_order, step_input  # noqa: E402
import city  # noqa: E402
import fastesp  # noqa: E402

DISABLED, DELETED = 0x800, 0x20
LINKS = ('NAME', 'XESP', 'XLRL', 'XEMI')
SUBS = set(LINKS) | {'DATA', 'XSCL'}
# The only refs the replay disables: Graves hid the Aretino basket and a Winterhold Restored snowberry
NEWLY_DISABLED = ['Skyrim.esm:0C71FE', 'Winterhold Restored.esp:6B156F']
MARKER = 0x001F84


class Plug:
    def __init__(self, path, odd=None):
        self.pl = fastesp.load(path)
        self.m, self.odd = self.pl['masters'], odd or {}
        self.recs = {r.fid: r for r in self.pl['recs']}

    def owner(self, fid):
        i = fid >> 24
        return (self.m[i] if i < len(self.m) else self.odd.get(i, SELF), fid & 0xFFFFFF)

    def fid(self, key):
        low = [m.lower() for m in self.m]
        return ((len(self.m) if key[0] == SELF else low.index(key[0].lower())) << 24) | key[1]

    def cell(self, r):
        g, label = r.path[-1]
        return g, self.owner(label)

    def canon(self, r):
        types = [t for t, _ in r.subs()]
        assert set(types) <= SUBS and len(set(types)) == len(types), f'{r.fid:08X}: unexpected subrecords {types}'
        # position, rotation and scale compare as values, since Mutagen writes -0.0 as 0.0
        subs = {t: (self.owner(struct.unpack_from('<I', v)[0]), v[4:]) if t in LINKS else struct.unpack(f'<{len(v) // 4}f', v) for t, v in r.subs()}
        return r.type, r.flags, self.cell(r), subs

    def raw(self, r):
        return r.type, r.flags, r.path, r.buf[r.off + 8:r.off + 24 + r.size]

    def hedr_count(self):
        b = self.pl['buf']
        return struct.unpack_from('<I', dict(fastesp.subs_of(b[24:24 + struct.unpack_from('<I', b, 4)[0]]))['HEDR'], 4)[0]


def state(r):
    if r is None:
        return 'none'
    d = r.sub('DATA')
    pos = struct.unpack_from('<3f', d) if d and len(d) >= 12 else (0, 0, 0)
    parent = r.sub('XESP')
    return ('disabled' if r.flags & (DISABLED | DELETED) else 'enabled') + (' (enable parent)' if parent else '') + f' at {pos[0]:.0f},{pos[1]:.0f},{pos[2]:.0f}'


def main():
    checks = []

    def check(name, ok, detail=''):
        checks.append((ok, f'{"OK  " if ok else "FAIL"} {name}' + (f': {detail}' if detail else '')))

    at = json.load(open(check_sha(*RUN['attribution']), encoding='utf-8'))
    rows = json.load(open(check_sha(*RUN['delta']), encoding='utf-8'))['records']
    odd = {int(i, 16): v[0] for i, v in at['odd_index_owners'].items()}
    new, live, old = Plug(check_sha(*INPUTS['NEW']), odd), Plug(check_sha(*INPUTS['R4'])), Plug(check_sha(*INPUTS['BASE']))
    base_path, base_sha = step_input('base')
    base = Plug(base_path)
    keys = {r['target']: r for r in rows}
    tkey = {r['target']: (r['target'].rsplit(':', 1)[0], int(r['target'].rsplit(':', 1)[1], 16)) for r in rows}
    lines = [f'r7 base {INPUTS["BASE"][1][:8]}, replayed base {base_sha[:8]}, NEW {INPUTS["NEW"][1][:8]}, live {INPUTS["R4"][1][:8]}']

    # base: only the delta and the marker differ from r7's base
    want = {base.fid(tkey[t]) for t in keys}
    marker = base.fid((SELF, MARKER))
    gone = sorted(set(old.recs) - set(base.recs))
    added = sorted(set(base.recs) - set(old.recs))
    changed = sorted(f for f in set(old.recs) & set(base.recs) if old.raw(old.recs[f]) != base.raw(base.recs[f]))
    check('removed from the base: the marker only', gone == [marker], ' '.join(f'{f:08X}' for f in gone))
    check('added and changed records are the delta', set(added) | set(changed) == want and len(added) == sum(r['kind'] == 'new' for r in rows)
          and not set(added) & set(changed), f'{len(added)} added, {len(changed)} changed')
    check('base masters unchanged', old.m == base.m)
    check('base HEDR count follows the record count', base.hedr_count() - old.hedr_count() == len(added) - len(gone), f'{old.hedr_count()} -> {base.hedr_count()}')
    same = [t for t, r in keys.items() if base.canon(base.recs[base.fid(tkey[t])]) == new.canon(new.recs[int(r['fid'], 16)])]
    check('each replayed ref equals NEW\'s record, cell group included', len(same) == len(keys), f'{len(same)} of {len(keys)}')

    # each replayed ref against its original, the load-order winner before AlduinakAdditions and live
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    _, order = live_load_order(STAGE_SETTINGS)
    wants = {('REFR',) + tkey[t] for t in keys if tkey[t][0] != SELF}
    hits, recs = city.scan(order, wants, keep={'REFR'})
    disabled_now, enabled_now = [], []
    lines.append('ref: original / load-order winner / live / replayed')
    for t in sorted(keys):
        k = tkey[t]
        chain = hits.get(('REFR',) + k, [])
        orig = recs.get((chain[0], ('REFR',) + k)) if chain else None
        win = recs.get((chain[-1], ('REFR',) + k)) if chain else None
        lv, rp = live.recs.get(live.fid(k)), base.recs[base.fid(k)]
        prior = lv if lv is not None else win
        if prior is not None and not prior.flags & (DISABLED | DELETED) and rp.flags & (DISABLED | DELETED):
            disabled_now.append(t)
        if prior is not None and prior.flags & (DISABLED | DELETED) and not rp.flags & (DISABLED | DELETED):
            enabled_now.append(t)
        if k[0] == SELF:
            check(f'{t} is a new own ref, Initially Disabled', lv is None and not chain and rp.flags & DISABLED)
        else:
            check(f'{t} is defined by {k[0]}', bool(chain) and chain[0].lower() == k[0].lower(), str(chain))
        lines.append(f'  {keys[t]["kind"]:4s} {t} in {keys[t]["cell"]}: {state(orig)} / {state(win)} ({chain[-1] if chain else "-"}) / {state(lv)} / {state(rp)}')
    check('no replayed ref is enabled where live or the winner has it disabled', not enabled_now, str(enabled_now))
    check('refs the replay newly disables', sorted(disabled_now) == NEWLY_DISABLED, str(sorted(disabled_now)))

    # the finished plugin against r10, when this run has built one from r10's spec
    manifest = json.load(open(MANIFEST, encoding='utf-8')) if os.path.exists(MANIFEST) else {}
    if 'thrones' in manifest and RUN['spec'] != RUNS['r10']['spec']:
        lines.append('plugin vs r10 skipped: this run builds with another spec')
    elif 'thrones' in manifest:
        out_path, out_sha = step_input('thrones')
        r10, out = Plug(check_sha(*INPUTS['R10'])), Plug(out_path)
        lines.append(f'plugin {out_sha[:8]} vs r10 {INPUTS["R10"][1][:8]}')
        want = {out.fid(tkey[t]) for t in keys}
        marker = out.fid((SELF, MARKER))
        gone = sorted(set(r10.recs) - set(out.recs))
        added = sorted(set(out.recs) - set(r10.recs))
        changed = sorted(f for f in set(r10.recs) & set(out.recs) if r10.raw(r10.recs[f]) != out.raw(out.recs[f]))
        check('plugin masters equal r10\'s', out.m == r10.m, f'{len(out.m)}')
        check('removed from r10: the marker only', gone == [marker], ' '.join(f'{f:08X}' for f in gone))
        check('added and changed against r10 are the delta, every other record byte-equal', set(added) | set(changed) == want and not set(added) & set(changed),
              f'{len(added)} added, {len(changed)} changed, {len(set(r10.recs) & set(out.recs)) - len(changed)} equal')
        check('each replayed ref reaches the plugin as the replayed base has it', all(out.canon(out.recs[out.fid(tkey[t])]) == base.canon(base.recs[base.fid(tkey[t])]) for t in keys))
        check('plugin HEDR count is r10\'s plus the added refs less the marker', out.hedr_count() - r10.hedr_count() == len(added) - len(gone), f'{r10.hedr_count()} -> {out.hedr_count()}')
        ed = {f & 0xFFFFFF: (r.type, r.edid()) for f, r in live.recs.items() if f >> 24 == len(live.m)}
        mine = {f & 0xFFFFFF: (r.type, r.edid()) for f, r in out.recs.items() if f >> 24 == len(out.m)}
        missing = sorted(x for x in ed if mine.get(x) != ed[x])
        check('every live own id keeps its type and editor id, except the deleted marker', missing == [MARKER], ' '.join(f'{x:06X}' for x in missing))
        lines.append(f'records {len(r10.recs)} -> {len(out.recs)}')
    ok = all(o for o, _ in checks)
    build_log('verify replay (misc/esp-merge/verify_replay.py)', lines + [c for _, c in checks] + assert_untouched())
    sys.exit(0 if ok else 3)


if __name__ == '__main__':
    main()
