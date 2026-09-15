#!/usr/bin/env python3
# Step 2a: pads NEW's master list with 6 load-order plugins so raw index 0x0E becomes the self index, and deletes the refs the attribution marks delete.
#   python pad_masters.py
# Writes r7/work/padded/AlduinakAdditions.esp; every record and group byte other than the header, the deleted refs and group sizes is asserted unchanged.
import json
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import ATTRIBUTION, SELF, WORK, assert_untouched, build_log, check_sha, flat, live_load_order, read_input, record_output  # noqa: E402
from esplib import Group, Plugin  # noqa: E402

FILLERS = ('Helgen.esp', 'WindhelmSSE.esp', 'The Great City of Falkreath.esp', "JK's Whiterun's Outskirts.esp",
           'Warbirds Whiterun Metropolis.esp', 'City of Dawnstar.esp')
OWN = 0x0E
BROKEN = 0x0E04B2AB
BROKEN_NAME = 0x0D000801
DOUBLED = 0x0E022A3A
OUT = WORK + 'padded/' + SELF


def drop(nodes, fids, gone):
    for n in list(nodes):
        if isinstance(n, Group):
            drop(n.children, fids, gone)
        elif n.fid in fids:
            nodes.remove(n)
            gone.append(n)


def empty_groups(p):
    return sum(1 for n, _ in p.walk() if isinstance(n, Group) and not n.children)


def main():
    src = read_input('NEW')
    at = json.load(open(check_sha(*ATTRIBUTION), encoding='utf-8'))
    assert at['index_08_0D'] == [f'REFR {BROKEN:08X} NAME -> {BROKEN_NAME:08X}'], at['index_08_0D']
    deletes = {int(e['fid'], 16): e.get('subtype') or e['class'] for e in at['entries'] if e['action'] == 'delete'}
    assert deletes == {BROKEN: 'BROKEN', DOUBLED: 'DOUBLED'}, f'attribution deletes {deletes}'
    p = Plugin(buf=src)
    assert p.serialize() == src, 'NEW round trip is not exact'
    masters = p.masters()
    _, order = live_load_order()
    pos = {n.lower(): i for i, n in enumerate(order)}
    fillers = sorted(FILLERS, key=lambda m: pos[m.lower()])
    assert len(masters) + len(fillers) == OWN, f'{len(masters)} masters + {len(fillers)} fillers is not {OWN}'
    assert all(pos[m.lower()] < pos[SELF.lower()] for m in fillers), 'a filler master loads after AlduinakAdditions'
    assert not {m.lower() for m in masters} & {m.lower() for m in fillers}, 'a filler is already a master'
    before = flat(p, skip=set(deletes))
    hdr_before = p.header.subs()
    empty_before = empty_groups(p)

    gone = []
    drop(p.top, set(deletes), gone)
    assert sorted(r.fid for r in gone) == sorted(deletes) and all(r.type == 'REFR' for r in gone), f'deleted {[f"{r.type} {r.fid:08X}" for r in gone]}'
    assert empty_groups(p) == empty_before, 'a deletion left an empty group'
    assert struct.unpack('<I', dict(next(r for r in gone if r.fid == BROKEN).subs())['NAME'])[0] == BROKEN_NAME

    last = max(i for i, (t, _) in enumerate(hdr_before) if t == 'MAST') + 1
    assert hdr_before[last][0] == 'DATA' and hdr_before[0][0] == 'HEDR'
    add = [s for m in fillers for s in (('MAST', m.encode('latin1') + b'\0'), ('DATA', b'\0' * 8))]
    recs, grps = p.counts()
    hedr = bytearray(hdr_before[0][1])
    n_before = struct.unpack_from('<I', hedr, 4)[0]
    assert n_before == recs + grps + len(gone), f'HEDR count {n_before} is not {recs} records + {grps} groups + the {len(gone)} deleted refs'
    struct.pack_into('<I', hedr, 4, recs + grps)
    want_hdr = [('HEDR', bytes(hedr))] + hdr_before[1:last + 1] + add + hdr_before[last + 1:]
    p.header.set_subs(want_hdr)
    out = p.serialize()

    q = Plugin(buf=out)
    assert q.serialize() == out, 'padded round trip is not exact'
    assert q.masters() == masters + fillers
    assert q.header.subs() == want_hdr and q.header.flags == p.header.flags
    assert flat(q) == before, 'a record or group header changed besides the deleted refs'
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(out)
    sha = record_output('padded', OUT)
    lines = [f'deleted {r.type} {r.fid:08X} {deletes[r.fid]}' + (f' (NAME {BROKEN_NAME:08X})' if r.fid == BROKEN else '') for r in gone]
    lines += [f'masters {len(masters)} -> {len(masters) + len(fillers)}; appended ' + ', '.join(fillers),
             f'HEDR records {n_before} -> {recs + grps}; next id {struct.unpack_from("<I", hedr, 8)[0]:X} kept',
             f'checked: round trip exact, header differs only by the count and the appended masters, all {len(before)} other nodes byte-equal',
             f'wrote {OUT} {sha}'] + assert_untouched()
    build_log('step 2a pad masters (misc/esp-merge/pad_masters.py)', lines)


if __name__ == '__main__':
    main()
