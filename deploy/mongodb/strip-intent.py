#!/usr/bin/env python3
# Sorts every item strip-inventories.js removed into what the owner meant to remove (ebony gear, spell tomes, Falmer chest armour) and the rest, for restore-stripped-items.js.
#   python deploy/mongodb/strip-intent.py [--list <the forbidden-items.json the strip ran with>] [--backup <strip backup dir>] [--settings build/dist/server/server-settings.json] [--out deploy/mongodb/strip-intent.json]
# The output also carries the part of the list the backup touches, so the restore needs no copy of the whole list and a re-run without --list reuses it.
# It records each plugin's hash and the plugins behind each item, which the restore checks against the Data folder before it runs.
# Plugins are read from the live load order's dataDir; the list's load order must be where it starts, since only appended plugins keep the backup's ids.
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('forbidden_items', os.path.join(HERE, 'forbidden-items.py'))
fi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fi)
from esplib import edid, sub, zstr  # noqa: E402

STRIP_DIR = os.environ.get('ALDUINAK_STRIP_BACKUP') or r'C:\Users\Administrator\Desktop\alduinak-r13\rollback-strip'
# Game, DLC and mod material keywords that mean ebony (the keywords come lower-cased)
EBONY_KW = re.compile(r'^(dlc\d*)?(armor|weap)materi[ae]lebony|^iakmaterialebony$|^spike(armor|weap)ebony$')
FALMER_KW = re.compile(r'materi[ae]lfalmer')
# A world model under a Falmer armour folder, such as Armor\Falmer or DLC01\Armor\FalmerHeavy
FALMER_DIR = re.compile(r'(^|[\\/])falmer[^\\/]*[\\/]', re.I)
BODY = 0x4
TEACHES_SPELL = 0x04
TEMPLATE = {'ARMO': 'TNAM', 'WEAP': 'CNAM'}
WORLD_MODELS = ('MOD2', 'MOD4')
LIST_FIELDS = ('reason', 'material', 'rank', 'adeptRecipe', 'factionGear')


def num(v):
    if isinstance(v, dict):
        for k in ('$numberInt', '$numberLong', '$numberDouble'):
            if k in v:
                return int(float(v[k]))
        return None
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def entries(doc):
    for inv in (doc.get('inv'), (doc.get('equipmentDump') or {}).get('inv')):
        yield from (inv or {}).get('entries') or []


def models(r):
    return [zstr(v) for t, v in r.subs() if t in WORLD_MODELS]


def classify(lo, kw, gid):
    key = lo.key_of(gid)
    rec = lo.recs.get(key) if key else None
    if not rec:
        return {'intent': 'unknown', 'evidence': 'no ARMO, WEAP, AMMO, BOOK or SCRL record with this id in the load order'}
    t, r, m, n = rec
    ref = sub(r, TEMPLATE.get(t, '----'))
    base = lo.recs.get(lo.ref(ref, m, n)) if ref else None
    # The plugins whose records decide this row: the defining one, the winning override and its template's winning override
    sources = sorted({key[0], n.lower()} | ({base[3].lower()} if base else set()))
    row = {'edid': edid(r), 'type': t, 'plugin': key[0], 'sources': sources, 'staff': False, 'note': ''}
    if t == 'BOOK':
        d = sub(r, 'DATA')
        return {**row, 'intent': 'spell tome', 'evidence': 'book that teaches a spell'} if d and d[0] & TEACHES_SPELL else {**row, 'intent': None, 'evidence': 'book'}
    kws = lo.keywords(kw, r, m, n)
    worn = models(r)
    if base:
        kws |= lo.keywords(kw, base[1], base[2], base[3])
        worn += models(base[1])
    row['staff'] = t == 'WEAP' and ('weaptypestaff' in kws or (sub(r, 'DNAM') or b'\0')[0] == fi.STAFF_ANIM)
    ebony = sorted(k for k in kws if EBONY_KW.search(k))
    if ebony:
        note = 'a daedric artifact' if 'daedricartifact' in kws else 'ammunition' if t == 'AMMO' else ''
        return {**row, 'intent': 'ebony', 'evidence': 'keyword ' + ', '.join(ebony), 'note': note}
    if 'aldcatmat_ebony' in kws:
        row['note'] = 'crafted mostly from ebony (aldcatmat_ebony), but no ebony material keyword'
    bod = sub(r, 'BOD2') or sub(r, 'BODT') or (base and (sub(base[1], 'BOD2') or sub(base[1], 'BODT')))
    body = t == 'ARMO' and bod and struct.unpack_from('<I', bod, 0)[0] & BODY
    falmer = [f'keyword {k}' for k in sorted(kws) if FALMER_KW.search(k)] or [f'model {p}' for p in worn if FALMER_DIR.search(p)]
    if body and worn and falmer:
        return {**row, 'intent': 'falmer cuirass', 'evidence': f'body slot 32, {falmer[0]}'}
    return {**row, 'intent': None, 'evidence': 'body slot 32 but no Falmer keyword or model' if body and worn and 'falmer' in row['edid'].lower() else ''}


def list_from_intent(path, info):
    # The list rows an earlier run kept in its output, for a re-run without the list itself
    old = json.load(open(path, encoding='utf-8'))
    if old.get('docsSha256') != info['docsSha256'] or old.get('listSha256') != info['listSha256']:
        sys.exit(f'{path} was made for another strip backup or list, pass --list')
    if any('sha256' not in p for p in old['plugins']):
        sys.exit(f'{path} carries no plugin hashes, pass --list')
    was = {c['name'].lower(): c['list'] for c in old.get('pluginChanges', []) if c.get('list')}
    return {
        'loadOrder': old['stripLoadOrder'],
        'plugins': [{'name': p['name'], 'light': p['light'], 'sha256': was.get(p['name'].lower(), p['sha256'])} for p in old['plugins']],
        'items': [{'globalId': int(k, 16), 'edid': v['edid'], **{f: v[f] for f in LIST_FIELDS if f in v}} for k, v in old['items'].items() if v.get('listed')],
        'spells': [{'globalId': int(k, 16), 'edid': v['edid'], 'kind': v['kind']} for k, v in old['spells'].items()],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', help='the forbidden-items.json the strip ran with; without it the list part of --out is reused')
    ap.add_argument('--backup', default=STRIP_DIR)
    ap.add_argument('--settings', default=os.environ.get('ALDUINAK_SERVER_SETTINGS') or os.path.join(fi.REPO, 'build', 'dist', 'server', 'server-settings.json'))
    ap.add_argument('--out', default=os.path.join(HERE, 'strip-intent.json'))
    a = ap.parse_args()
    info = json.load(open(os.path.join(a.backup, 'strip-backup.json'), encoding='utf-8'))
    raw = open(os.path.join(a.backup, 'changeforms.ejson'), 'rb').read()
    if hashlib.sha256(raw).hexdigest() != info['docsSha256']:
        sys.exit('changeforms.ejson does not match the checksum in strip-backup.json')
    if a.list:
        list_raw = open(a.list, 'rb').read()
        if hashlib.sha256(list_raw).hexdigest() != info['listSha256']:
            sys.exit(f'{a.list} is not the list the strip ran with (listSha256 {info["listSha256"][:12]})')
        lst = json.loads(list_raw)
    else:
        lst = list_from_intent(a.out, info)
    s = json.load(open(a.settings, encoding='utf-8-sig'))
    names = [os.path.basename(p.replace('\\', '/')) for p in s['loadOrder']]
    theirs = [n.lower() for n in lst['loadOrder']]
    if [n.lower() for n in names[:len(theirs)]] != theirs:
        sys.exit('the live load order no longer starts with the one the strip ran with, so the backup ids mean other records')
    lo = fi.LoadOrder(s['dataDir'], names)
    flipped = [p['name'] for p in lst['plugins'] if lo.slot[p['name'].lower()][0] != p['light']]
    if flipped:
        sys.exit(f'{", ".join(flipped)} changed its light flag since the strip, so the backup ids mean other records')
    now = {nm.lower(): h for nm, h in lo.files}
    kw = {k: edid(r) for k, (t, r, m, n) in lo.recs.items() if t == 'KYWD'}

    docs = json.loads(raw)
    listed = {i['globalId']: i for i in lst['items'] if info.get('factionGear') or not i.get('factionGear')}
    known = {sp['globalId']: sp for sp in lst['spells']}
    ids, spells = set(), {}
    for d in docs:
        for e in entries(d):
            b = num(e.get('baseId'))
            if b is not None and ((b & 0xFFFFFFFF) in listed or e.get('enchantmentId') is not None):
                ids.add(b & 0xFFFFFFFF)
        for sid in d.get('learnedSpells') or []:
            sp = known.get((num(sid) or 0) & 0xFFFFFFFF)
            if sp:
                spells[f'0x{sp["globalId"]:08X}'] = {'edid': sp['edid'], 'kind': sp['kind']}
    items = {}
    for g in sorted(ids):
        it = listed.get(g, {})
        items[f'0x{g:08X}'] = {'listed': bool(it), 'edid': it.get('edid', ''), **{k: it[k] for k in LIST_FIELDS if k in it}, **classify(lo, kw, g)}

    was = {p['name'].lower(): p['sha256'] for p in lst['plugins']}
    out = {
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'backup': os.path.abspath(a.backup),
        'docsSha256': info['docsSha256'],
        'listSha256': info['listSha256'],
        'factionGear': bool(info.get('factionGear')),
        'settings': os.path.abspath(a.settings),
        'stripLoadOrder': lst['loadOrder'],
        'plugins': [{'name': p['name'], 'light': p['light'], 'sha256': now[p['name'].lower()]} for p in lst['plugins']],
        'pluginChanges': [{'name': nm, 'list': was.get(nm.lower()), 'now': h} for nm, h in lo.files if was.get(nm.lower()) != h],
        'sourceSha256': {nm: h for nm, h in lo.files if nm.lower() in {s for row in items.values() for s in row.get('sources', [])}},
        'items': items,
        'spells': dict(sorted(spells.items())),
    }
    with open(a.out, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    counts = {}
    for row in items.values():
        counts[row['intent'] or 'restore'] = counts.get(row['intent'] or 'restore', 0) + 1
    print(f'{len(items)} removed item ids ({", ".join(f"{k} {v}" for k, v in sorted(counts.items()))}), {len(spells)} learned spells -> {a.out}')


if __name__ == '__main__':
    main()
