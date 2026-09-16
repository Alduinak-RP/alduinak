#!/usr/bin/env python3
# Checks AlduinakCreations.esp against the plugins it overrides, reading them with fastesp only (no Mutagen):
#   python verify_creations.py --out <patch.py out dir> --settings <server-settings with the Creations> [--spec spec.json]
# Writes verify-creations.txt next to the plugin; exit code 3 on any problem. A clean run also writes <plugin>.inputs.json,
# the sha256 of every plugin loaded before it, which compile-manifest.js checks before it publishes the plugin.
import argparse
import collections
import hashlib
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..'))
sys.path.insert(0, os.path.join(HERE, '..', 'esp-merge'))
import fastesp  # noqa: E402

DELETED, DISABLED, ESL = 0x20, 0x800, 0x200
PLACED = {'REFR', 'ACHR', 'PGRE', 'PMIS', 'PARW', 'PBEA', 'PFLA', 'PCON', 'PBAR', 'PHZD'}
GET_RANDOM_PERCENT = 77
# Localized string fields: a string id in the source, the text itself in the non-localized output
LOCALIZED = ('FULL', 'DESC', 'RNAM', 'SHRT')
LOCALIZED_BY_TYPE = {'MGEF': ('DNAM',)}
NEG_ZERO = b'\x00\x00\x00\x80'
# Shipped with the game, so the manifest never carries them and the inputs file leaves them out
VANILLA = {'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'}


def norm_zero(b):
    out = bytearray(b)
    for i in range(0, len(out) - 3, 4):
        if out[i:i + 4] == NEG_ZERO:
            out[i:i + 4] = b'\0\0\0\0'
    return bytes(out)


class Loaded:
    def __init__(self, path):
        self.name = os.path.basename(path)
        pl = fastesp.load(path)
        self.masters = pl['masters']
        self.flags = pl['hflags']
        self.records = {self.key(r.fid): r for r in pl['recs']}

    def key(self, fid):
        i = fid >> 24
        return (self.masters[i] if i < len(self.masters) else self.name).lower(), fid & 0xFFFFFF


def floats_close(a, b, tol=0.005):
    if len(a) != len(b) or len(a) % 4:
        return False
    return all(x == y or abs(x - y) <= tol for x, y in zip(struct.unpack(f'<{len(a) // 4}f', a), struct.unpack(f'<{len(b) // 4}f', b)))


def own_index_moves(src, out):
    # (index of the source plugin's own records in its file, index of that plugin in the output's master list)
    own = len(src.masters)
    masters = [m.lower() for m in out.masters]
    return own, masters.index(src.name.lower()) if src.name.lower() in masters else own


def same_bytes(x, y, own, to):
    # equal except where a form id of the source's own records now carries the output's master index, at any offset
    x, y = norm_zero(x), norm_zero(y)
    return len(x) == len(y) and all(a == b or (b == own and a == to) for a, b in zip(x, y))


def same_fields(src, srec, out, orec, strip=()):
    # Mutagen writes subrecords in definition order, quantises XPRM colours and drops -0.0
    a = sorted(((t, v) for t, v in orec.subs() if t not in strip), key=lambda x: x[0])
    b = sorted(((t, v) for t, v in srec.subs() if t not in strip), key=lambda x: x[0])
    if [t for t, _ in a] != [t for t, _ in b]:
        return False
    own, to = own_index_moves(src, out)
    for (t, x), (_, y) in zip(a, b):
        if t == 'XPRM':
            ok = len(x) == len(y) == 32 and x[24:] == y[24:] and floats_close(x[:24], y[:24])
        else:
            ok = same_bytes(x, y, own, to)
        if not ok:
            return False
    return True


def sha_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def write_inputs(path, plugin, inputs):
    # The plugin copies whole cells, worldspaces and reverted records out of these files, so it is stale once any of them changes
    body = {'plugin': os.path.basename(plugin), 'sha256': sha_file(plugin), 'inputs': [{'name': n, 'sha256': sha_file(p)} for n, p in inputs]}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(body, f, indent=1)
        f.write('\n')
    return body


def layout(rec):
    return sorted(t for t, _ in rec.subs())


def conditions(rec):
    return [(v[0], struct.unpack_from('<f', v, 4)[0], struct.unpack_from('<H', v, 8)[0]) for t, v in rec.subs() if t == 'CTDA']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--settings', required=True)
    ap.add_argument('--spec', default=os.path.join(HERE, 'spec.json'))
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding='utf-8'))
    cs = spec['creations']
    settings = json.load(open(a.settings, encoding='utf-8'))
    data = settings['dataDir']
    order = [os.path.basename(p.replace(chr(92), '/')) for p in settings['loadOrder']]
    log, problems = [], []
    if cs['pluginName'].lower() in [n.lower() for n in order[:-1]]:
        problems.append(f'{cs["pluginName"]} is not last in the settings loadOrder')
    order = [n for n in order if n.lower() != cs['pluginName'].lower()]
    cc = [n.lower() for n in cs['plugins']]
    additions = spec.get('pluginName', 'AlduinakAdditions.esp').lower()

    out = Loaded(os.path.join(a.out, cs['pluginName']))
    log.append(f'{out.name}: {len(out.records)} records, {len(out.masters)} masters, header flags {out.flags:#x}')
    if not out.flags & ESL:
        problems.append('the plugin is not ESL-flagged')
    own = [k for k in out.records if k[0] == out.name.lower()]
    if own:
        problems.append(f'{len(own)} records are the plugin\'s own, an ESL overrides-only plugin must have none: {own[:5]}')
    position = {n.lower(): i for i, n in enumerate(order)}
    if any(position.get(m.lower(), -1) < 0 for m in out.masters) or [position[m.lower()] for m in out.masters] != sorted(position[m.lower()] for m in out.masters):
        problems.append(f'masters are not a load-order subsequence: {out.masters}')

    sources = {n.lower(): os.path.join(a.out, n) if n.lower() == additions else os.path.join(data, n) for n in order}
    loaded = {}

    def load(name):
        if name not in loaded:
            loaded[name] = Loaded(sources[name])
        return loaded[name]

    # Winner of a record key over the load order, with or without the Creations
    def winner(key, with_cc):
        best = None
        for name in order:
            lower = name.lower()
            if (lower in cc and not with_cc) or position[lower] < position.get(key[0], 0):
                continue
            if lower != key[0] and key[0] not in [m.lower() for m in load(lower).masters]:
                continue
            rec = load(lower).records.get(key)
            if rec is not None:
                best = (load(lower), rec)
        return best

    census = collections.Counter()
    checked = collections.Counter()
    for key, rec in out.records.items():
        census[rec.type] += 1
        full = winner(key, True)
        base = winner(key, False)
        if full is None:
            problems.append(f'{rec.type} {key}: no plugin in the load order defines it')
            continue
        src, srec = full
        creation_own = key[0] in cc
        if rec.type in PLACED and creation_own:
            if srec.flags & DELETED:
                problems.append(f'{rec.type} {key}: overrides a deleted reference')
            if rec.flags != (srec.flags | DISABLED):
                problems.append(f'{rec.type} {key}: flags {rec.flags:#x}, expected {srec.flags | DISABLED:#x}')
            if not same_fields(src, srec, out, rec, strip=('XESP',)):
                problems.append(f'{rec.type} {key}: fields differ from {src.name} beyond the disable flag and enable parent')
            if any(t == 'XESP' for t, _ in rec.subs()):
                problems.append(f'{rec.type} {key}: still has an enable parent')
            checked['placed references disabled'] += 1
        elif rec.type == 'QUST':
            dnam = dict(rec.subs()).get('DNAM')
            sdnam = dict(srec.subs()).get('DNAM')
            if not creation_own or dnam is None or struct.unpack_from('<H', dnam, 0)[0] & 1 or struct.unpack_from('<H', sdnam, 0)[0] & ~1 != struct.unpack_from('<H', dnam, 0)[0]:
                problems.append(f'QUST {key}: DNAM flags are not the Creation flags without Start Game Enabled')
            if layout(rec) != layout(srec):
                problems.append(f'QUST {key}: subrecord layout differs from {src.name}')
            checked['quests without Start Game Enabled'] += 1
        elif rec.type in ('LSCR', 'SMBN', 'SMQN'):
            if not creation_own or conditions(rec) != [(0x80, 0.0, GET_RANDOM_PERCENT)]:
                problems.append(f'{rec.type} {key}: conditions are not exactly GetRandomPercent < 0: {conditions(rec)}')
            checked[f'{rec.type} never passing'] += 1
        elif rec.type == 'SPEL' and creation_own:
            stage = cs.get('stageAbilities') or {}
            suffix = stage.get('dropEffectsEndingWith', '')
            effect_name = lambda pl, v: (lambda k: (load(k[0]).records.get(k).edid() if k[0] in sources and load(k[0]).records.get(k) else ''))(pl.key(struct.unpack('<I', v)[0]))
            kept = [src.key(struct.unpack('<I', v)[0]) for t, v in srec.subs() if t == 'EFID' and not effect_name(src, v).endswith(suffix)]
            now = [out.key(struct.unpack('<I', v)[0]) for t, v in rec.subs() if t == 'EFID']
            if rec.edid() not in stage.get('spells', []) or not suffix or now != kept or len(now) == len([t for t, _ in srec.subs() if t == 'EFID']):
                problems.append(f'SPEL {rec.edid()} {key}: effects are not the Creation effects without the {suffix} ones')
            checked['stage abilities without screen effects'] += 1
        elif rec.type == 'GLOB':
            want = cs['globals'].get(rec.edid())
            if want is None or struct.unpack('<f', dict(rec.subs())['FLTV'])[0] != want:
                problems.append(f'GLOB {rec.edid()} {key}: value is not the spec value {want}')
            checked['globals pinned'] += 1
        elif rec.type == 'COBJ':
            if not creation_own:
                problems.append(f'COBJ {key} {rec.edid()}: a recipe outside the Creations')
            checked['Creation recipes tiered or parked'] += 1
        elif rec.type in ('CELL', 'WRLD') or rec.type in cs['revertTypes']:
            expected = base if base is not None else (full if creation_own else None)
            if expected is None:
                problems.append(f'{rec.type} {key}: no record to revert to')
                continue
            esrc, erec = expected
            if rec.flags & ~0x40000 != erec.flags & ~0x40000:
                problems.append(f'{rec.type} {key}: flags {rec.flags:#x} differ from {esrc.name} {erec.flags:#x}')
            if layout(rec) != layout(erec):
                problems.append(f'{rec.type} {key} {rec.edid()}: subrecord layout {layout(rec)} differs from {esrc.name} {layout(erec)}')
            elif rec.type not in ('CELL', 'WRLD') and not same_fields(esrc, erec, out, rec, strip=LOCALIZED + LOCALIZED_BY_TYPE.get(rec.type, ())):
                problems.append(f'{rec.type} {key}: fields differ from {esrc.name}')
            checked[f'{rec.type} carrying {"the winner without the Creations" if base is not None else "the Creation record"}'] += 1
        else:
            problems.append(f'{rec.type} {key} {rec.edid()}: a record type the Creations step never writes')

    # Coverage: every live reference a Creation places and every quest it starts with the game is overridden
    for name in cs['plugins']:
        pl = load(name.lower())
        for key, rec in pl.records.items():
            if key[0] != name.lower():
                continue
            if rec.type in PLACED and not rec.flags & DELETED and (not rec.flags & DISABLED or any(t == 'XESP' for t, _ in rec.subs())) and key not in out.records:
                problems.append(f'{rec.type} {key} in {name} is live and not disabled')
            if rec.type == 'QUST' and struct.unpack_from('<H', dict(rec.subs())['DNAM'], 0)[0] & 1 and key not in out.records:
                problems.append(f'QUST {rec.edid()} in {name} still starts with the game')
            if rec.type in ('LSCR', 'SMBN', 'SMQN') and key not in out.records:
                problems.append(f'{rec.type} {rec.edid()} in {name} is not overridden')

    log.append('record types: ' + ', '.join(f'{t} {n}' for t, n in sorted(census.items())))
    log.extend(f'  {what}: {n}' for what, n in sorted(checked.items()))
    with open(os.path.join(a.out, 'verify-creations.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(log + [''] + problems) + '\n')
    print('\n'.join(log))
    if problems:
        print(f'CREATIONS VERIFY FAILED: {len(problems)} problem(s), first 20:')
        print('\n'.join(problems[:20]))
        sys.exit(3)
    plugin = os.path.join(a.out, cs['pluginName'])
    inputs_path = os.path.splitext(plugin)[0] + '.inputs.json'
    body = write_inputs(inputs_path, plugin, [(n, sources[n.lower()]) for n in order if n.lower() not in VANILLA])
    print(f'verified {out.name}; {os.path.basename(inputs_path)} pins {len(body["inputs"])} plugins loaded before it')


if __name__ == '__main__':
    main()
