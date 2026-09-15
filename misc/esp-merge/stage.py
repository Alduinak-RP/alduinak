#!/usr/bin/env python3
# Step 0: builds r7/stage-data (hardlinks to the load order plugins and archives) and r7/server-settings.stage.json.
#   python stage.py [--slot <plugin> --slot-sha <sha256>]
# The AlduinakAdditions.esp slot stays empty unless --slot names the plugin a later step needs there.
import argparse
import json
import os
import sys

sys.path[:0] = [os.path.dirname(os.path.abspath(__file__)), os.path.join(os.path.dirname(os.path.abspath(__file__)), 'tools')]
from r7lib import DATA, R7, SELF, STAGE, STAGE_SETTINGS, assert_untouched, live_load_order, sha_file  # noqa: E402


def link(src, dst):
    if os.path.lexists(dst):
        assert os.path.samefile(src, dst), f'{dst} exists and is not a hardlink of {src}'
        return False
    os.link(src, dst)
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--slot')
    ap.add_argument('--slot-sha')
    a = ap.parse_args()
    assert bool(a.slot) == bool(a.slot_sha), '--slot needs --slot-sha'
    log = []
    data_dir, order = live_load_order()
    assert data_dir.replace('\\', '/').rstrip('/') + '/' == DATA, f'live dataDir is {data_dir}'
    assert len(order) == 71 and order[-1] == SELF and len(set(n.lower() for n in order)) == 71, 'unexpected live loadOrder'
    os.makedirs(STAGE, exist_ok=True)

    made = kept = 0
    others = order[:-1]
    for name in others:
        assert os.path.isfile(DATA + name), f'{name} is in the loadOrder but not in Data'
        if link(DATA + name, STAGE + name):
            made += 1
        else:
            kept += 1
    bsas = sorted(f for f in os.listdir(DATA) if f.lower().endswith('.bsa'))
    for name in bsas:
        if link(DATA + name, STAGE + name):
            made += 1
        else:
            kept += 1
    log.append(f'plugins linked: {len(others)}; archives linked: {len(bsas)}; new links {made}, already present {kept}')

    strings = DATA + 'Strings'
    if os.path.isdir(strings):
        dst = STAGE + 'Strings'
        if not os.path.lexists(dst):
            import _winapi
            _winapi.CreateJunction(strings, dst)
        assert os.path.samefile(strings, dst)
        log.append(f'Strings junction -> {strings}')
    else:
        log.append('Data has no loose Strings folder; localized strings come from the linked archives')

    slot = STAGE + SELF
    if a.slot:
        assert sha_file(a.slot) == a.slot_sha, f'{a.slot} is not {a.slot_sha}'
        if os.path.lexists(slot) and not os.path.samefile(slot, a.slot):
            assert not os.path.samefile(slot, DATA + SELF), 'stage slot is linked to the live Data plugin'
            os.remove(slot)
        link(a.slot, slot)
        log.append(f'slot {SELF} -> {a.slot} {a.slot_sha[:8]}')
    elif os.path.lexists(slot):
        log.append(f'slot {SELF} already filled: {sha_file(slot)[:8]}')
    else:
        log.append(f'slot {SELF} empty')
    if os.path.lexists(slot):
        assert not os.path.samefile(slot, DATA + SELF), 'stage slot is linked to the live Data plugin'

    # Mutagen reads only dataDir and the loadOrder basenames; the entries point into stage-data so nothing resolves to the live Data
    stage_dir = STAGE.rstrip('/')
    settings = {'dataDir': stage_dir, 'loadOrder': [f'{stage_dir}/{n}' for n in order]}
    with open(STAGE_SETTINGS, 'w', encoding='utf-8') as f:
        json.dump(settings, f, indent=2)
        f.write('\n')
    back = json.load(open(STAGE_SETTINGS, encoding='utf-8'))
    assert sorted(back) == ['dataDir', 'loadOrder'] and [os.path.basename(p) for p in back['loadOrder']] == order
    log.append(f'wrote {STAGE_SETTINGS}: dataDir + {len(order)} loadOrder entries, sha256 {sha_file(STAGE_SETTINGS)}')

    for name in others + bsas:
        assert os.path.samefile(DATA + name, STAGE + name), name
    log.append(f'checked: all {len(others) + len(bsas)} stage entries are the same files as Data')
    log += assert_untouched()
    with open(R7 + 'stage-log.txt', 'a', encoding='utf-8') as f:
        f.write('\n'.join(log) + '\n\n')
    print('\n'.join(log))


if __name__ == '__main__':
    main()
