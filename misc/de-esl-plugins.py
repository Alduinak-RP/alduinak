"""De-ESL the light plugins so server and client form-index spaces match.

WHY: libespm (the server) assigns every loadOrder entry a sequential plugin
index with no ESL awareness, but the Skyrim client puts ESL-flagged plugins in
the separate 0xFE light space. With ESLs mid-load-order, every later plugin's
form index differs between server and client, so teleports into mod-added
cells resolve to the wrong cell client-side and movement validation bounces
the player back outside the door (MovementValidation.cpp:21). Clearing the
ESL flag and renaming .esl -> .esp IN PLACE keeps every server-side combined
form id identical (positions unchanged, world DB verified free of .esl
filename references) while making the client index the plugins normally.

WHAT IT DOES (all-or-nothing, with backups):
  1. Backs up each .esl (game Data dir + MO2 mod dir) to a dated Desktop folder.
  2. Clears TES4 header flag 0x200 and renames the file to .esp in both places.
  3. Rewrites the loadOrder entries in build/dist/server/server-settings.json.
  4. Rewrites C:\\MO2\\profiles\\<profile>\\plugins.txt entries.

AFTER RUNNING, still required (Server Manager):
  - Modlist tab -> "Update manifest" (regenerates data/manifest.json crc/size).
  - Build Client (repackages the client files so players re-download the
    renamed plugins on next launcher update).
  - Start the game service.

Run with:  python misc/de-esl-plugins.py         (dry run)
           python misc/de-esl-plugins.py --apply
"""
import json
import os
import shutil
import struct
import sys
from datetime import date

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS = os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json')
MO2_PROFILE = os.environ.get('ALDUINAK_MO2_PROFILE_DIR', r'C:\MO2\profiles\Default')
MO2_MODS = os.environ.get('ALDUINAK_MO2_MODS_DIR', r'C:\MO2\mods')
BACKUP = os.path.join(os.path.expanduser('~'), 'Desktop', f'plugin-backups-{date.today().isoformat()}')

APPLY = '--apply' in sys.argv


def find_mo2_copy(name):
    for mod in os.listdir(MO2_MODS):
        p = os.path.join(MO2_MODS, mod, name)
        if os.path.exists(p):
            return p
    return None


def de_esl(path):
    buf = bytearray(open(path, 'rb').read())
    if buf[0:4] != b'TES4':
        raise SystemExit(f'{path}: not a plugin (no TES4 header)')
    flags = struct.unpack_from('<I', buf, 8)[0]
    if not flags & 0x200:
        print(f'  note: {path} has no ESL flag (extension-only light); renaming anyway')
    struct.pack_into('<I', buf, 8, flags & ~0x200)
    dst = os.path.splitext(path)[0] + '.esp'
    if APPLY:
        tag = 'GOG' if 'MO2' not in path else 'MO2'
        os.makedirs(BACKUP, exist_ok=True)
        shutil.copy2(path, os.path.join(BACKUP, f'{tag}-{os.path.basename(path)}'))
        open(dst, 'wb').write(buf)
        os.remove(path)
    print(f'  {"renamed" if APPLY else "would rename"}: {path} -> {os.path.basename(dst)} '
          f'(flags 0x{flags:08X} -> 0x{flags & ~0x200:08X})')


def main():
    settings = json.load(open(SETTINGS, encoding='utf-8'))
    load_order = settings['loadOrder']
    esls = [p for p in load_order if p.lower().endswith('.esl')]
    if not esls:
        print('loadOrder has no .esl entries; nothing to do')
        return
    print(f'{"APPLYING" if APPLY else "DRY RUN"} - {len(esls)} light plugin(s):')

    for entry in esls:
        name = os.path.basename(entry)
        print(name)
        game_copy = entry.replace('/', os.sep)
        if os.path.exists(game_copy):
            de_esl(game_copy)
        else:
            print(f'  MISSING game copy: {game_copy}')
        mo2_copy = find_mo2_copy(name)
        if mo2_copy:
            de_esl(mo2_copy)
        else:
            print(f'  MISSING MO2 copy of {name} under {MO2_MODS}')

    new_order = [p[:-4] + '.esp' if p.lower().endswith('.esl') else p for p in load_order]
    if APPLY:
        settings['loadOrder'] = new_order
        with open(SETTINGS, 'w', encoding='utf-8', newline='\n') as f:
            json.dump(settings, f, indent=2)
            f.write('\n')
    print(f'{"updated" if APPLY else "would update"} loadOrder in {SETTINGS}')

    plugins_txt = os.path.join(MO2_PROFILE, 'plugins.txt')
    if os.path.exists(plugins_txt):
        txt = open(plugins_txt, encoding='utf-8').read()
        for entry in esls:
            name = os.path.basename(entry)
            txt = txt.replace(name, name[:-4] + '.esp')
        if APPLY:
            open(plugins_txt, 'w', encoding='utf-8', newline='\n').write(txt)
        print(f'{"updated" if APPLY else "would update"} {plugins_txt}')
    else:
        print(f'plugins.txt not found at {plugins_txt} - update it manually')

    if APPLY:
        print(f'\nbackups: {BACKUP}')
        print('NEXT: Server Manager -> Modlist "Update manifest", then Build Client, then start the game service.')


if __name__ == '__main__':
    main()
