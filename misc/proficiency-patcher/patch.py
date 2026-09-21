#!/usr/bin/env python3
# Builds the proficiency version of AlduinakAdditions.esp: pre-cleans the plugin, runs the Mutagen patcher, verifies the output record by record.
#   python patch.py --plugin "C:/MO2/mods/Alduinak/AlduinakAdditions.esp" --out out [--settings ../../build/dist/server/server-settings.json] [--spec spec.json] [--no-creations] [--hotfix] [--stage]
# The output is out/AlduinakAdditions.esp plus proficiency-report.md, proficiency-ids.json and verify.txt (with --stage also verify-r13.txt), and with a creations spec AlduinakCreations.esp, its inputs json and verify-creations.txt.
import argparse
import json
import os
import struct
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
from esplib import Plugin, Record, Group, edid  # noqa: E402

DELETED = 0x20
INITIALLY_DISABLED = 0x800
# Generated from the whole load order; the plugin must never master them, and the last two load after it
NEVER_MASTERS = ('dyndolod.esm', 'dyndolod.esp', 'occlusion.esp')
NEG_ZERO = b'\x00\x00\x00\x80'
# Record types the patcher creates or overrides; anything else must survive untouched.
# ARMO, WEAP and AMMO join them for the crafting-category keywords the menu filters on.
PATCHED_TYPES = {'KYWD', 'SPEL', 'MGEF', 'FURN', 'COBJ', 'BOOK', 'MISC', 'ARMO', 'WEAP', 'AMMO'}


def preclean(src, dst):
    # The CK left two LAND records in one exterior cell; Mutagen refuses that, the game keeps the last one.
    p = Plugin(src)
    removed = []

    def clean(nodes):
        for n in nodes:
            if isinstance(n, Group):
                if n.gtype in (8, 9):
                    lands = [c for c in n.children if isinstance(c, Record) and c.type == 'LAND']
                    for extra in lands[:-1]:
                        n.children.remove(extra)
                        removed.append(f'LAND {extra.fid:08X} in cell {n.label:08X} (kept {lands[-1].fid:08X})')
                clean(n.children)

    clean(p.top)
    with open(dst, 'wb') as f:
        f.write(p.serialize())
    return removed


def norm_zero(b):
    # -0.0 floats become 0.0 in Mutagen's output
    out = bytearray(b)
    for i in range(0, len(out) - 3, 4):
        if out[i:i + 4] == NEG_ZERO:
            out[i:i + 4] = b'\0\0\0\0'
    return bytes(out)


def floats_close(a, b, tol=0.005):
    if len(a) != len(b) or len(a) % 4:
        return False
    for i in range(0, len(a), 4):
        fa, fb = struct.unpack('<f', a[i:i + 4])[0], struct.unpack('<f', b[i:i + 4])[0]
        if fa != fb and abs(fa - fb) > tol:
            return False
    return True


def index(p):
    recs, groups = {}, {}
    for n, parents in p.walk():
        if isinstance(n, Record):
            recs[(n.type, n.fid)] = n
        else:
            groups[(n.gtype, n.label)] = n
    return recs, groups


def benign_change(a, b):
    # None when the only differences are Mutagen's known normalisations or a record turned Initially Disabled
    if a.flags != b.flags and a.flags | INITIALLY_DISABLED != b.flags:
        return f'flags {a.flags:#x} -> {b.flags:#x}'
    sa, sb = a.subs(), b.subs()
    if a.flags & DELETED and not sb:
        return None
    if len(sa) != len(sb):
        return f'subrecords {[t for t, _ in sa]} -> {[t for t, _ in sb]}'
    for (ta, va), (tb, vb) in zip(sa, sb):
        if ta != tb:
            return f'subrecord {ta} -> {tb}'
        if va == vb:
            continue
        if norm_zero(va) == norm_zero(vb):
            continue
        if ta == 'XPRM' and len(va) == len(vb) == 32 and va[24:] == vb[24:] and floats_close(va[:24], vb[:24]):
            continue
        return f'{ta}: {va.hex()[:64]} -> {vb.hex()[:64]}'
    return None


def meadery_allowed(spec):
    # The meadery step adds its own bench references, found by editor id, and overrides of the cells holding them
    m = json.load(open(spec, encoding='utf-8')).get('meadery', {})
    cells = {b['cell'].lower() for b in m.get('benches', [])}
    return lambda k, rec: (k[0] == 'REFR' and k[1] == 'self' and str(k[2]).startswith('AldMeadBench_')) or (k[0] == 'CELL' and edid(rec).lower() in cells)


def spec_overrides(spec):
    # Overrides of other types the spec names: placed references by form key, enchantments and races by editor id
    s = json.load(open(spec, encoding='utf-8'))
    refs = {('REFR', p['ref'].split(':')[1].lower(), int(p['ref'].split(':')[0], 16)) for p in s.get('placements', [])}
    # References the spec disables: the same form-key spelling, plus the plugin's own, which are changed in place
    for r in s.get('disableReferences', {}).get('refs', []):
        refs.add(('REFR', r.split(':', 1)[1].lower(), int(r.split(':', 1)[0], 16)))
    enchs = {e['enchantment'].lower() for e in s.get('enchantmentMagnitudes', [])}
    named = {('RACE', r.lower()) for r in s.get('races', {}).get('races', [])}
    return lambda k, rec: (k[0], k[1].lower(), k[2]) in refs or (k[0] == 'ENCH' and edid(rec).lower() in enchs) or (k[0], edid(rec).lower()) in named


def world_allowed(spec):
    # The world section adds its own references, the overrides of the cells holding them and the references it moves
    w = json.load(open(spec, encoding='utf-8')).get('world', {})
    def key(text):
        local, plugin = text.split(':', 1)
        return plugin.lower(), int(local, 16)
    cells = {key(p['cell']) for p in w.get('placements', [])}
    edids = {p['edid'] for p in w.get('placements', [])}
    moves = {key(m['ref']) for m in w.get('moves', [])}
    return lambda k, rec: (k[0] == 'REFR' and k[1] == 'self' and k[2] in edids) \
        or (k[0] == 'CELL' and (k[1].lower(), k[2]) in cells) \
        or (k[0] == 'REFR' and (k[1].lower(), k[2]) in moves)


def actors_allowed(spec):
    # disableActors overrides placed actors and adds the cells and worldspaces holding them; verify_r13.py checks each against its winner
    on = 'disableActors' in json.load(open(spec, encoding='utf-8'))
    return lambda k, rec: on and k[0] in ('ACHR', 'CELL', 'WRLD')


def spec_allowed(spec):
    # Each spec section that adds or changes records of other types brings its own rule; verify_r13.py applies the same
    rules = [f(spec) for f in (meadery_allowed, spec_overrides, world_allowed, actors_allowed)]
    return lambda k, rec: any(rule(k, rec) for rule in rules)


def verify(original, patched, log, allowed=lambda k, rec: False):
    po, pp = Plugin(original), Plugin(patched)
    ro, go = index(po)
    rp, gp = index(pp)
    problems, added, changed, untouched = [], [], [], 0
    masters_o, masters_p = po.masters(), pp.masters()
    log.append(f'masters: {len(masters_o)} -> {len(masters_p)}')
    for m in masters_p:
        if m not in masters_o:
            log.append(f'  master added: {m}')
    for m in masters_o:
        if m not in masters_p:
            log.append(f'  master dropped: {m}')
    for m in masters_p:
        if m.lower() in NEVER_MASTERS:
            problems.append(f'MASTER {m}: the settings loadOrder must stop at the plugin (see --stage)')
    remap = masters_o != masters_p
    if remap:
        log.append('  master list changed: form ids were renumbered, records are compared by editor id')
    # With a changed master list every form id moves, so match records by (type, editor id) for own records and by master name for overrides
    def key_of(rec, masters):
        idx = rec.fid >> 24
        local = rec.fid & 0xFFFFFF
        owner = masters[idx] if idx < len(masters) else 'self'
        return (rec.type, owner, local if owner != 'self' else edid(rec) or f'{local:06X}')
    ko = {key_of(r, masters_o): r for r in ro.values()}
    kp = {key_of(r, masters_p): r for r in rp.values()}
    for k, r in ko.items():
        if k not in kp:
            problems.append(f'MISSING {k[0]} {r.fid:08X} {edid(r)}')
            continue
        q = kp[k]
        if r.type in PATCHED_TYPES or allowed(k, q):
            if r.serialize() != q.serialize():
                changed.append(f'{r.type} {edid(r) or f"{r.fid:08X}"}')
            continue
        if remap:
            # references inside the record moved with the master list; only structure can be compared
            if [t for t, _ in r.subs()] != [t for t, _ in q.subs()] and not (r.flags & DELETED and not q.subs()):
                problems.append(f'CHANGED {r.type} {r.fid:08X} {edid(r)}: subrecord layout differs')
            else:
                untouched += 1
            continue
        why = benign_change(r, q)
        if why:
            problems.append(f'CHANGED {r.type} {r.fid:08X} {edid(r)}: {why}')
        elif q.flags & ~r.flags & INITIALLY_DISABLED:
            changed.append(f'{r.type} {edid(r) or f"{r.fid:08X}"} Initially Disabled')
        else:
            untouched += 1
    for k, q in kp.items():
        if k not in ko:
            if q.type in PATCHED_TYPES or allowed(k, q):
                added.append(f'{q.type} {edid(q) or f"{q.fid:08X}"}')
            else:
                problems.append(f'ADDED {q.type} {q.fid:08X} {edid(q)}')
    log.append(f'records: {len(ro)} -> {len(rp)}; untouched {untouched}, records rewritten {len(changed)} (renumbered by the master list or edited, see proficiency-report.md), added {len(added)}')
    log.extend('  rewritten ' + c for c in changed)
    log.extend('  added ' + a for a in added)
    return problems


def stage_settings(settings, plugin, out):
    # The live settings cut after the plugin: the plugins after it would leak their records into the winners; DynDOLOD.esm loads before it and stays
    s = json.load(open(settings, encoding='utf-8'))
    names = [os.path.basename(p).lower() for p in s['loadOrder']]
    order = [p for p in s['loadOrder'][:names.index(plugin.lower()) + 1] if os.path.basename(p).lower() not in NEVER_MASTERS[1:]]
    path = os.path.join(out, 'settings.stage.json')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump({'dataDir': s['dataDir'], 'loadOrder': order}, f, indent=1)
    return path, s['dataDir']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--plugin', required=True, help='the live AlduinakAdditions.esp to patch')
    ap.add_argument('--out', default=os.path.join(HERE, 'out'))
    ap.add_argument('--settings', default=os.path.join(HERE, '..', '..', 'build', 'dist', 'server', 'server-settings.json'))
    ap.add_argument('--spec', default=os.path.join(HERE, 'spec.json'))
    ap.add_argument('--skip-verify', action='store_true')
    ap.add_argument('--next-form-id', help='first own form id to allocate, in hex; pins the marker spell ids')
    ap.add_argument('--no-creations', action='store_true', help='build AlduinakAdditions.esp without AlduinakCreations.esp')
    ap.add_argument('--hotfix', action='store_true', help='apply the recipe gates to the live plugin, sweeping only recipes it does not override yet')
    ap.add_argument('--stage', action='store_true', help='run on <out>/settings.stage.json, the --settings loadOrder cut after the plugin')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    log = []
    if a.stage:
        name = json.load(open(a.spec, encoding='utf-8')).get('pluginName', 'AlduinakAdditions.esp')
        a.settings, data_dir = stage_settings(a.settings, name, a.out)
        # The load order reads the plugin from dataDir, so the winners are only right when that copy is the input
        with open(a.plugin, 'rb') as f1, open(os.path.join(data_dir, name), 'rb') as f2:
            if f1.read() != f2.read():
                print(f'--stage: {os.path.join(data_dir, name)} is not the same file as {a.plugin}')
                sys.exit(5)
    pre = os.path.join(a.out, 'AlduinakAdditions.preclean.esp')
    removed = preclean(a.plugin, pre)
    for r in removed:
        log.append(f'pre-clean: removed duplicate {r}')
    cs = json.load(open(a.spec, encoding='utf-8')).get('creations')
    creations = os.path.join(a.out, (cs or {}).get('pluginName', 'AlduinakCreations.esp'))
    for stale in (creations, os.path.splitext(creations)[0] + '.inputs.json', os.path.join(a.out, 'verify-creations.txt')):
        if os.path.exists(stale):
            os.remove(stale)
    cmd = ['dotnet', 'run', '-c', 'Release', '--project', HERE, '--', '--settings', a.settings, '--plugin', pre, '--spec', a.spec, '--out', a.out, '--report', a.out]
    if a.next_form_id:
        cmd += ['--next-form-id', a.next_form_id]
    if a.no_creations:
        cmd.append('--no-creations')
    if a.hotfix:
        cmd.append('--hotfix')
    print(' '.join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        print(f'patcher failed with exit code {r.returncode}, see {os.path.join(a.out, "proficiency-report.md")}')
        sys.exit(r.returncode)
    out_esp = os.path.join(a.out, os.path.basename(a.plugin))
    if a.skip_verify:
        sys.exit(0)
    problems = verify(pre, out_esp, log, spec_allowed(a.spec))
    with open(os.path.join(a.out, 'verify.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(log + [''] + problems) + '\n')
    print('\n'.join(log))
    if problems:
        print(f'VERIFY FAILED: {len(problems)} unexpected difference(s), first 20:')
        print('\n'.join(problems[:20]))
        sys.exit(3)
    print(f'verified: only records of types {sorted(PATCHED_TYPES)}, the meadery bench references and cells, the spec\'s named overrides and newly Initially Disabled records were added or changed; {out_esp}', flush=True)
    if a.stage:
        # A new master turns the check above into a layout comparison; this one resolves every form id against the load order
        r = subprocess.run([sys.executable, '-B', os.path.join(HERE, 'verify_r13.py'), '--out', a.out, '--spec', a.spec])
        if r.returncode != 0:
            sys.exit(r.returncode)
    if cs and not a.no_creations:
        if not os.path.exists(creations):
            print(f'{creations} was not built')
            sys.exit(4)
        r = subprocess.run([sys.executable, os.path.join(HERE, 'verify_creations.py'), '--out', a.out, '--settings', a.settings, '--spec', a.spec])
        if r.returncode != 0:
            sys.exit(r.returncode)


if __name__ == '__main__':
    main()
