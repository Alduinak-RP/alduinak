#!/usr/bin/env python3
# Step 2 of a replay run: writes the delta.json records of Graves's save onto r7's merged base and deletes the owner's stray marker.
#   ESP_MERGE_RUN=r11 python delta.py
# Writes <run>/work/base/AlduinakAdditions.esp; masters and the next id are kept, every other record and group stays byte-equal.
import json
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import ATTRIBUTION, RUN, RUNS, SELF, WORK, assert_untouched, build_log, check_sha, flat, read_input, record_output  # noqa: E402
from esplib import Group, Plugin, Record  # noqa: E402
from attribute import NEW_NM, NEW_OWN, ODD, layout, links  # noqa: E402

REF_GROUPS = (8, 9)
# The subrecords a replayed ref may carry, in the order Mutagen writes them, so later Mutagen passes keep their layout
WRITE_ORDER = ('NAME', 'XEMI', 'XSCL', 'XLRL', 'XESP', 'DATA')
# Owner decision 2026-09-16: the stray portal-box CollisionMarker 1.75 million units under the Windhelm arena goes
MARKERS = {0x001F84: ('Skyrim.esm', 0x000021)}
OUT = WORK + 'base/' + SELF


def owners(masters, odd, own, selfmap=None):
    # form id -> (plugin, local id); selfmap re-keys the own ids the CK re-owned or renumbered
    def of(fid):
        idx, loc = fid >> 24, fid & 0xFFFFFF
        if idx < len(masters):
            return masters[idx], loc
        return (selfmap or {}).get(loc, (SELF, loc)) if idx == own else (odd[idx], loc)
    return of


def refid(key, dst):
    low = [m.lower() for m in dst]
    idx = len(dst) if key[0] == SELF else low.index(key[0].lower())
    return (idx << 24) | key[1]


def fids_of(rec, fn):
    # subrecords in writing order with each form id passed through fn
    out = []
    subs = rec.subs()
    assert all(t in WRITE_ORDER for t, _ in subs) and len({t for t, _ in subs}) == len(subs), f'{rec.type} {rec.fid:08X}: unhandled subrecords {[t for t, _ in subs]}'
    for t, v in sorted(subs, key=lambda x: WRITE_ORDER.index(x[0])):
        lay = layout(rec.type, t)
        if lay:
            size, slots, _ = lay
            n, b = size or len(v), bytearray(v)
            for i in range(0, max(len(v) - n + 1, 1), n):
                for s in slots:
                    if i + s + 4 <= len(v) and struct.unpack_from('<I', v, i + s)[0]:
                        struct.pack_into('<I', b, i + s, fn(struct.unpack_from('<I', v, i + s)[0]))
            v = bytes(b)
        out.append((t, v))
    return out


def canon(rec, own_of):
    # flags, subrecords with form ids zeroed, and the (plugin, local id) of every form id in order
    keys = []

    def zero(f):
        keys.append(own_of(f))
        return 0
    return rec.flags, fids_of(rec, zero), keys


def main():
    base_buf, new_buf, live_buf = read_input('BASE'), read_input('NEW'), read_input('R4')
    delta = json.load(open(check_sha(*RUN['delta']), encoding='utf-8'))
    assert delta['new'] == RUN['NEW'][1], 'delta.json was written for another NEW'
    p, g, live = Plugin(buf=base_buf), Plugin(buf=new_buf), Plugin(buf=live_buf)
    assert p.serialize() == base_buf and g.serialize() == new_buf, 'round trip is not exact'
    dst = p.masters()
    assert len(g.masters()) == NEW_NM, 'NEW master count is not the attribution\'s'
    at = json.load(open(check_sha(*ATTRIBUTION), encoding='utf-8'))
    selfmap = {int(k.split(':')[1], 16): (v.rsplit(':', 1)[0], int(v.rsplit(':', 1)[1], 16)) for k, v in at['rekey_map'].items()}
    selfmap.update({int(n, 16): (SELF, int(o, 16)) for o, n in at['renumber_map_r4_to_new'].items()})
    g_of = owners(g.masters(), ODD, NEW_OWN, selfmap)
    b_of, l_of = owners(dst, {}, len(dst)), owners(live.masters(), {}, len(live.masters()))
    hdr0 = p.header.subs()
    hedr = dict(hdr0)['HEDR']
    count, nxt = struct.unpack_from('<II', hedr, 4)

    rows = {int(r['fid'], 16): r for r in delta['records']}
    gnodes = {n.fid: (n, par) for n, par in g.walk() if isinstance(n, Record) and n.fid in rows}
    assert len(gnodes) == len(rows), 'a delta record is missing from NEW'
    bnodes = {n.fid: (n, par) for n, par in p.walk() if isinstance(n, Record)}
    lnodes = {(n.type, l_of(n.fid)): n for n, _ in live.records()}
    cells = {(n.gtype, n.label): n for n, _ in p.walk() if isinstance(n, Group) and n.gtype in REF_GROUPS}
    lines, written, replaced = [], [], set()
    for gfid, r in sorted(rows.items(), key=lambda kv: kv[1]['target']):
        rec, par = gnodes[gfid]
        key = g_of(gfid)
        assert r['type'] == rec.type == 'REFR' and f'{key[0]}:{key[1]:06X}' == r['target'], f'{gfid:08X} is not the delta.json record'
        new = Record(bytes(rec.hdr), bytes(rec.raw))
        struct.pack_into('<I', new.hdr, 12, refid(key, dst))
        new.set_subs(fids_of(rec, lambda f: refid(g_of(f), dst)))
        grp = par[-1]
        assert grp.gtype in REF_GROUPS, f'{gfid:08X} is not a placed ref'
        cell = (grp.gtype, refid(g_of(grp.label), dst))
        old = bnodes.get(new.fid)
        if r['kind'] == 'edit':
            assert old is not None and old[0].type == 'REFR', f'{r["target"]}: edited record is not in the base'
            base_rec, bpar = old
            assert canon(base_rec, b_of) == canon(lnodes[('REFR', key)], l_of), f'{r["target"]}: the base record differs from the live one Graves edited'
            children = bpar[-1].children
            state = f'flags {base_rec.flags:08X} -> {new.flags:08X}'
            if (bpar[-1].gtype, bpar[-1].label) == cell:
                children[children.index(base_rec)] = new
            else:
                # a ref moved across an exterior cell border is refiled under its new cell, as the CK saved it
                assert cell in cells and len(children) > 1, f'{r["target"]}: cannot refile it into cell group {cell[0]} {cell[1]:08X}'
                children.remove(base_rec)
                cells[cell].children.append(new)
                state += f', refiled from cell {bpar[-1].label:08X}'
            replaced.add(new.fid)
        else:
            assert old is None, f'{r["target"]}: a new record is already in the base'
            assert cell in cells, f'{r["target"]}: cell group {cell[0]} {cell[1]:08X} is not in the base'
            cells[cell].children.append(new)
            state = f'flags {new.flags:08X}'
        written.append((new, rec))
        lines.append(f'{r["kind"]:4s} REFR {new.fid:08X} {r["target"]} in {r["cell"]} ({"persistent" if cell[0] == 8 else "temporary"}): {state}; ' + '; '.join(r['changes']))

    deleted = []
    for loc, base_obj in sorted(MARKERS.items()):
        rec, par = bnodes[(len(dst) << 24) | loc]
        prm = dict(rec.subs())
        z = struct.unpack_from('<f', prm['DATA'], 8)[0]
        assert rec.type == 'REFR' and b_of(struct.unpack('<I', prm['NAME'])[0]) == base_obj and 'XPRM' in prm and z < -1e6, f'{loc:06X} is not the stray marker'
        assert not [n for n, _ in p.records() for _, f in links(n) if f == rec.fid], f'{loc:06X} is still linked'
        par[-1].children.remove(rec)
        assert par[-1].children, f'{loc:06X} was the last ref of its group'
        deleted.append(rec)
        lines.append(f'deleted REFR {rec.fid:08X} {SELF}:{loc:06X} {base_obj[0]}:{base_obj[1]:06X} primitive at z {z:.0f} in cell {par[-1].label:08X}')

    # an added own ref must not reuse an id live holds or r7 retired, since changeForms may still carry it
    retired = set(json.load(open(check_sha(*RUNS['r7']['attribution']), encoding='utf-8'))['retired_own_ids'])
    fresh = {f'{n.fid & 0xFFFFFF:06X}' for n, _ in written if (n.fid >> 24) == len(dst)}
    assert not fresh & retired and not fresh & {f'{k[1]:06X}' for _, k in lnodes if k[0] == SELF}, f'an added own ref reuses a live or retired id: {sorted(fresh)}'
    added = sum(1 for r in rows.values() if r['kind'] == 'new')
    own_ids = {n.fid & 0xFFFFFF for n, _ in p.records() if (n.fid >> 24) == len(dst)}
    assert max(own_ids) < nxt, f'an own id is not below the next id {nxt:X}'
    hedr = hedr[:4] + struct.pack('<I', count + added - len(deleted)) + hedr[8:]
    p.header.set_subs([(t, hedr if t == 'HEDR' else v) for t, v in hdr0])
    out = p.serialize()

    q = Plugin(buf=out)
    assert q.serialize() == out, 'output round trip is not exact'
    assert q.masters() == dst and q.header.flags == p.header.flags, 'masters or header flags changed'
    assert [x for x in q.header.subs() if x[0] != 'HEDR'] == [x for x in hdr0 if x[0] != 'HEDR'], 'TES4 changed beyond HEDR'
    mine = {n.fid for n, _ in written}
    assert flat(q, skip=mine) == flat(Plugin(buf=base_buf), skip=replaced | {d.fid for d in deleted}), 'a record or group changed besides the replay'
    qn = {n.fid: n for n, _ in q.records()}
    for new, rec in written:
        assert canon(qn[new.fid], b_of) == canon(rec, g_of), f'{new.fid:08X} is not NEW\'s record'
    assert not {d.fid for d in deleted} & set(qn), 'a deleted marker is still in the output'
    recs, _ = q.counts()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(out)
    lines += [f'records {len(bnodes)} -> {recs}: {len(replaced)} replaced, {added} added, {len(deleted)} deleted; HEDR count {count} -> {count + added - len(deleted)}; next id {nxt:X} kept',
              f'masters unchanged ({len(dst)}); the {len(fresh)} added own ids {" ".join(sorted(fresh))} are unused in the base, in live and in the r7 retired list, and below the next id',
              'checked: round trip exact, TES4 differs only by the count, every other record and group byte-equal and in order',
              'checked: each replaced base record equalled the live record Graves edited; each written record equals NEW\'s, flags and form ids normalised',
              f'wrote {OUT} {record_output("base", OUT)}']
    build_log('step 2 replay (misc/esp-merge/delta.py)', [f'input base {RUN["BASE"][1][:8]}, NEW {RUN["NEW"][1][:8]}, delta.json {RUN["delta"][1][:8]}'] + lines + assert_untouched())


if __name__ == '__main__':
    main()
