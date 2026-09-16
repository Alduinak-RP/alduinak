#!/usr/bin/env python3
# Step 4b: drops FurnitureForce3rdPerson from every winning throne FURN that still carries it, as esp-fix/tools/r4_throne_keywords.py did for r4.
#   python thrones.py
# Writes <run>/work/thrones/AlduinakAdditions.esp; it runs after the last Mutagen pass, so the master list must not change.
import os
import struct
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import (SELF, STAGE, STAGE_SETTINGS, STAGE_SETTINGS_SHA, WORK, assert_untouched, build_log, canon_subs, check_sha, flat,  # noqa: E402
                   live_load_order, record_output, step_input)
from esplib import Group, Plugin, Record, edid, sub  # noqa: E402
import fastesp  # noqa: E402

FORCE_3RD_PERSON, IS_JARL_CHAIR = 0x0A56D8, 0x10651B
LOCALIZED, COMPRESSED, FORM_VERSION = 0x80, 0x40000, 44
FURN_LABEL = struct.unpack('<I', b'FURN')[0]
# The one winning throne r4 could not patch, because its plugin was not a master then
EXPECT = [("viking's longhouse.esp", 0x000E75)]
FORMID_SUBS = {'KWDA', 'KNAM', 'NAM1', 'FNMK'}
ALT_TEXTURES = {'MODS'}
PLAIN_SUBS = {'EDID', 'OBND', 'FULL', 'MODL', 'MODT', 'KSIZ', 'PNAM', 'FNAM', 'MNAM', 'WBDT', 'ENAM', 'NAM0', 'FNPR', 'XMRK'}
OUT = WORK + 'thrones/' + SELF


def owner_of(fid, masters, name):
    mi = fid >> 24
    return masters[mi] if mi < len(masters) else name


def remap(fid, masters, name, dst):
    if fid == 0:
        return 0
    low = [m.lower() for m in dst]
    owner = owner_of(fid, masters, name).lower()
    assert owner in low, f'form {fid:08X} belongs to {owner}, which is not a master'
    return (low.index(owner) << 24) | (fid & 0xFFFFFF)


def is_throne(kwda, ed, masters, name):
    kws = {(owner_of(k, masters, name).lower(), k & 0xFFFFFF) for k in struct.unpack(f'<{len(kwda or b"") // 4}I', kwda or b'')}
    return ('skyrim.esm', FORCE_3RD_PERSON) in kws and (('skyrim.esm', IS_JARL_CHAIR) in kws or 'throne' in ed.lower())


def winners(order, p):
    # winning FURN per (owner, local id) across the load order, the plugin itself last
    out = {}
    for name in order:
        if name == SELF:
            m, recs = p.masters(), [(r.fid, sub(r, 'KWDA'), edid(r)) for r, _ in p.records() if r.type == 'FURN']
        else:
            pl = fastesp.load(STAGE + name, {'FURN'})
            m, recs = pl['masters'], [(r.fid, r.sub('KWDA'), r.edid()) for r in pl['recs']]
        for fid, kwda, ed in recs:
            out[(owner_of(fid, m, name).lower(), fid & 0xFFFFFF)] = (name, fid, kwda, ed, m)
    return out


def bad_thrones(order, p):
    return sorted((k, v[0]) for k, v in winners(order, p).items() if is_throne(v[2], v[3], v[4], v[0]))


def remap_alt(v, masters, name, dst):
    n, o, out = struct.unpack_from('<I', v, 0)[0], 4, [v[:4]]
    for _ in range(n):
        ln = struct.unpack_from('<I', v, o)[0]
        fid = struct.unpack_from('<I', v, o + 4 + ln)[0]
        out.append(v[o:o + 4 + ln] + struct.pack('<I', remap(fid, masters, name, dst)) + v[o + 8 + ln:o + 12 + ln])
        o += 12 + ln
    assert o == len(v), 'alternate texture parse overran'
    return b''.join(out)


# Override of rec in the destination plugin: form ids remapped, Force3rdPerson dropped from KWDA
def build(rec, masters, name, dst):
    subs = []
    for t, v in rec.subs():
        if t in FORMID_SUBS:
            ids = [remap(x, masters, name, dst) for x in struct.unpack(f'<{len(v) // 4}I', v)]
            v = b''.join(struct.pack('<I', x) for x in ids if t != 'KWDA' or x != FORCE_3RD_PERSON)
        elif t in ALT_TEXTURES:
            v = remap_alt(v, masters, name, dst)
        else:
            assert t in PLAIN_SUBS, f'unhandled subrecord {t}'
        subs.append((t, v))
    nkw = len(dict(subs)['KWDA']) // 4
    subs = [(t, struct.pack('<I', nkw) if t == 'KSIZ' else v) for t, v in subs if nkw or t not in ('KSIZ', 'KWDA')]
    hdr = bytearray(rec.hdr)
    struct.pack_into('<I', hdr, 12, remap(rec.fid, masters, name, dst))
    struct.pack_into('<IHH', hdr, 16, 0, FORM_VERSION, 0)
    out = Record(bytes(hdr), bytes(rec.raw))
    out.set_subs(subs)
    return out


def main():
    src, src_sha = step_input('masks')
    check_sha(STAGE_SETTINGS, STAGE_SETTINGS_SHA)
    _, order = live_load_order(STAGE_SETTINGS)
    assert order[-1] == SELF, 'AlduinakAdditions.esp is not last in the load order'
    b = open(src, 'rb').read()
    p = Plugin(buf=b)
    assert p.serialize() == b, 'round trip is not exact'
    dst = p.masters()
    assert dst[0] == 'Skyrim.esm' and not p.header.flags & LOCALIZED
    before = flat(p)
    hdr0 = p.header.subs()
    hedr = dict(hdr0)['HEDR']
    count = struct.unpack_from('<I', hedr, 4)[0]

    bad = bad_thrones(order, p)
    assert [k for k, _ in bad] == EXPECT and all(w != SELF for _, w in bad), f'winning thrones with Force3rdPerson: {bad}'
    group = next(g for g in p.top if isinstance(g, Group) and g.label == FURN_LABEL)
    own_fids = {r.fid for r, _ in p.records()}
    edited = []
    for (owner, loc), name in bad:
        sp = Plugin(STAGE + name)
        assert not sp.header.flags & LOCALIZED, f'{name} is localized'
        m = sp.masters()
        rec = next(r for r, _ in sp.records() if r.type == 'FURN' and owner_of(r.fid, m, name).lower() == owner and r.fid & 0xFFFFFF == loc)
        assert not rec.flags & COMPRESSED, f'{name} FURN {loc:06X} is compressed'
        new = build(rec, m, name, dst)
        assert new.fid not in own_fids, f'{new.fid:08X} is already in the plugin'
        group.children.append(new)
        edited.append((sp, name, rec, new))
    hedr = hedr[:4] + struct.pack('<I', count + len(edited)) + hedr[8:]
    p.header.set_subs([(t, hedr if t == 'HEDR' else v) for t, v in hdr0])
    out = p.serialize()

    q = Plugin(buf=out)
    assert q.serialize() == out, 'output round trip is not exact'
    assert q.masters() == dst and q.header.flags == Plugin(buf=b).header.flags, 'masters or header flags changed'
    assert [x for x in q.header.subs() if x[0] != 'HEDR'] == [x for x in hdr0 if x[0] != 'HEDR'], 'TES4 changed beyond HEDR'
    assert flat(q, skip={e[3].fid for e in edited}) == before, 'a record or group changed besides the new overrides'
    lines = [f'input masks {src_sha[:8]}']
    for sp, name, rec, new in edited:
        qr = next(r for r, _ in q.records() if r.fid == new.fid)
        want = []
        for t, v in canon_subs(sp.masters(), rec, name, FORMID_SUBS, ALT_TEXTURES):
            if t == 'KWDA':
                v = tuple(k for k in v if k != ('Skyrim.esm', FORCE_3RD_PERSON))
            want.append((t, v))
        nkw = len(dict(want)['KWDA'])
        want = [(t, struct.pack('<I', nkw) if t == 'KSIZ' else v) for t, v in want]
        assert canon_subs(q.masters(), qr, SELF, FORMID_SUBS, ALT_TEXTURES) == want and qr.flags == rec.flags, f'{name} {rec.fid:08X} override differs'
        assert len(sub(qr, 'KWDA')) // 4 == len(sub(rec, 'KWDA')) // 4 - 1
        lines.append(f'FURN {new.fid:08X} {name}:{rec.fid & 0xFFFFFF:06X} {edid(rec)} "{sub(rec, "FULL").rstrip(bytes(1)).decode("latin1")}": '
                     f'override added, KWDA {len(sub(rec, "KWDA")) // 4} -> {len(sub(qr, "KWDA")) // 4} keywords, FurnitureForce3rdPerson 0A56D8 removed')
    after = bad_thrones(order, q)
    assert not after, f'winning thrones still carry Force3rdPerson: {after}'
    kw = lambda r: struct.unpack(f'<{len(sub(r, "KWDA") or b"") // 4}I', sub(r, 'KWDA') or b'')
    n_thr = sum(1 for r, _ in q.records() if r.type == 'FURN' and (IS_JARL_CHAIR in kw(r) or 'throne' in edid(r).lower()))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(out)
    lines += [f'masters unchanged ({len(dst)}); HEDR count {count} -> {count + len(edited)}; next id kept',
              'checked: round trip exact, TES4 differs only by the count, every other record and group byte-equal and in order',
              'checked: each override equals its source record minus 0A56D8, subrecord by subrecord with form ids normalised',
              f'checked: no winning throne FURN carries 0A56D8 over the load order; the plugin overrides {n_thr} thrones',
              f'wrote {OUT} {record_output("thrones", OUT)}']
    build_log('step 4b thrones (misc/esp-merge/thrones.py)', lines + assert_untouched())


if __name__ == '__main__':
    main()
