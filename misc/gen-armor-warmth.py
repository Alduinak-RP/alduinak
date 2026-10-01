"""Generates the survival warmth table (skymp5-server/ts/systems/armorWarmth.ts).

The engine rates a worn piece by slot (body 32, head 30/31/42, hands 33, feet 37) and by keyword: Survival_ArmorWarm,
Survival_ArmorCold or neither (normal). Bethesda set the keywords on the base game's own pieces; mod pieces, enchanted
copies of a keyworded piece and everything worn on another slot (cloaks, capes, scarves, collars) have none. This
script reads the winning ARMO records of a server loadOrder and gives every playable one without a keyword a rating
in the same three classes, so SurvivalSystem counts it like the comparable vanilla piece:

  rated slots  a record with a template armour takes its template's class; an unenchanted record of Skyrim.esm,
               Update.esm or a DLC keeps Bethesda's rating (normal), and so does a record of a mod whose author
               rated it for Survival (some record of the plugin carries a keyword); any other record takes the
               class of the base game pieces of its exact name and covered parts (body, head, hands, feet) when
               they all agree, else it is classed by the words of its name (COLD_WORDS, then WARM_WORDS with the
               editor id's words; a robe, hood or cowl alone is normal like the base game's, a hooded robe and a
               mage's hood are warm), by its material keyword, or stays normal
  other slots  a piece on the back (40, 46) or at the neck and face (44, 45) gets warmth points of its own (EXTRA);
               shields, jewellery, bags and the rest warm nothing

Only what differs from the engine's rating is written: warm and cold ids, and [id, points] of the extras.

Run:  python misc/gen-armor-warmth.py                 (writes the .ts)
      python misc/gen-armor-warmth.py --dump          (one line per playable record; nothing written)
Options: --settings <server-settings.json> (default build/dist/server, read-only) --data <Data dir>
"""
import collections
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, 'skymp5-server', 'ts', 'systems', 'armorWarmth.ts')

WARM, COLD = 'Survival_ArmorWarm', 'Survival_ArmorCold'
# Plugins whose unenchanted records Bethesda rated for Survival
RATED_PLUGINS = {'skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm'}
BODY, HEAD, HANDS, FEET = {32}, {30, 31, 42}, {33}, {37}
RATED_SLOTS = BODY | HEAD | HANDS | FEET
PARTS = (('body', BODY), ('head', HEAD), ('hands', HANDS), ('feet', FEET))
BACK, NECK = {40, 46}, {44, 45}
MATERIAL_WARM = {'DLC2ArmorMaterialNordicHeavy', 'DLC2ArmorMaterialStalhrimHeavy', 'DLC2ArmorMaterialStalhrimLight',
                 'ArmorMaterialBearStormcloak'}
# Bare skin, rags and thin head cloths, as Bethesda's cold pieces (prisoner rags, beggar and miner clothes, sandals)
COLD_WORDS = {'rags', 'ragged', 'prisoner', 'beggar', 'loincloth', 'sandals', 'tavern', 'wench', 'barbarian',
              'harness', 'bandana', 'shackles', 'cuffs', 'footwraps', 'wraps', 'roughspun', 'shirtless', 'kilt'}
# Fur and padding, as Bethesda's warm pieces (fur armour, Stalhrim, Skaal); Nordic Carved comes by MATERIAL_WARM
WARM_WORDS = {'fur', 'furs', 'pelt', 'bear', 'bearskin', 'wool', 'woolen', 'quilted', 'padded', 'gambeson', 'aketon',
              'mantle', 'coat', 'cloak', 'cloaked', 'stalhrim', 'skaal', 'winter', 'snow', 'lined', 'scarf', 'mittens'}
# Warmth points of a piece the engine does not rate; a normal head piece is 18 and normal hands are 13
EXTRA = {'furCloak': 20, 'cloak': 12, 'shortCape': 6, 'furCollar': 8, 'scarf': 5, 'mask': 3}
NO_WARMTH_WORDS = {'backpack', 'satchel', 'pouch', 'banner', 'lantern', 'resource', 'quiver', 'bag', 'eyepatch'}
FUR_WORDS = {'fur', 'furs', 'pelt', 'bear', 'sabre', 'wolf', 'bearskin'}


def arg(name, default):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv else default


def name_words(a):
    return set(re.findall(r'[a-z]+', a.get('name', '').lower()))


def words_of(a):
    """Lower-case words of the name and of the editor id split at capitals, digits and underscores (NoHood, NoCloak dropped)."""
    edid = re.sub(r'(?i)no_?(hood|cloak)', '', a.get('edid', ''))
    return name_words(a) | set(re.findall(r'[a-z]+', re.sub(r'([a-z])([A-Z])', r'\1 \2', edid).lower()))


def slots_of(a):
    return {int(s.split(':')[0]) for s in a.get('biped_slots', '').split()}


def parts_of(slots):
    return frozenset(part for part, group in PARTS if slots & group)


def keyword_class(a):
    kws = a.get('keywords', '').split()
    return 'warm' if WARM in kws else 'cold' if COLD in kws else None


def text_class(a):
    words = words_of(a)
    if (name_words(a) or words) & COLD_WORDS:
        return 'cold'
    if words & WARM_WORDS or set(a.get('keywords', '').split()) & MATERIAL_WARM:
        return 'warm'
    # The base game rates a hooded robe and a mage's hood warm, a plain robe, hood or cowl normal
    parts = parts_of(slots_of(a))
    if 'hooded' in words and 'body' in parts or 'mage' in name_words(a) and parts == {'head'}:
        return 'warm'
    return 'normal'


def extra_points(a, slots):
    """Warmth of a piece on the back or at the neck and face; 0 for anything else."""
    words = words_of(a)
    if words & NO_WARMTH_WORDS or not slots & (BACK | NECK):
        return 0
    own = keyword_class(a)
    fur = bool(words & FUR_WORDS) or own == 'warm'
    small = bool(words & {'collar', 'mantle', 'scarf', 'gaiter', 'shoulder', 'short'}) or own == 'cold'
    if slots & BACK:
        if words & {'collar', 'mantle'}:
            return EXTRA['furCollar']
        if words & {'scarf', 'gaiter'}:
            return EXTRA['scarf']
        if fur and not small:
            return EXTRA['furCloak']
        if words & {'cloak', 'cape', 'capes', 'cloaks'}:
            return EXTRA['shortCape'] if small else EXTRA['cloak']
        return 0
    if fur or words & {'collar', 'mantle'}:
        return EXTRA['furCollar']
    if words & {'scarf', 'gaiter', 'hood'}:
        return EXTRA['scarf']
    return EXTRA['mask'] if 'mask' in words else 0


def classify(armors):
    """[(armor, slot kind, class or points, why)] of every playable record; armors are loadorder.armors() rows."""
    by_key = {a['key']: a for a in armors}
    memo = {}
    # (name, covered parts) -> classes of the base game's unenchanted pieces
    vanilla = collections.defaultdict(set)
    # Plugins rated for Survival: Bethesda's, and every mod with a keyword on a record of its own
    rated_plugins = set(RATED_PLUGINS)
    for a in armors:
        if a['key'][0] in RATED_PLUGINS and a.get('name') and not by_key.get(a.get('template_key')):
            vanilla[(a['name'].lower(), parts_of(slots_of(a)))].add(keyword_class(a) or 'normal')
        if keyword_class(a):
            rated_plugins.add(a['key'][0])

    def rate(a, depth=0):
        key = a['key']
        if key in memo:
            return memo[key]
        slots = slots_of(a)
        tmpl = by_key.get(a.get('template_key')) if depth < 8 else None
        if not slots & RATED_SLOTS:
            if tmpl and not slots_of(tmpl) & RATED_SLOTS:
                out = ('extra', rate(tmpl, depth + 1)[1], 'template')
            else:
                out = ('extra', extra_points(a, slots), 'words')
        elif keyword_class(a):
            out = ('rated', keyword_class(a), 'keyword')
        elif tmpl and slots_of(tmpl) & RATED_SLOTS:
            out = ('rated', rate(tmpl, depth + 1)[1], 'template')
        elif key[0] in rated_plugins:
            out = ('rated', 'normal', 'vanilla' if key[0] in RATED_PLUGINS else 'rated mod')
        else:
            same = vanilla.get((a.get('name', '').lower(), parts_of(slots)), ())
            out = ('rated', next(iter(same)), 'vanilla name') if len(same) == 1 else ('rated', text_class(a), 'words')
        memo[key] = out
        return out

    return [(a, *rate(a)) for a in armors if not a.get('non_playable')]


def table_of(rows):
    """{plugin: {warm: [ids], cold: [ids], extra: [[id, points]]}} of what the engine's own rating lacks."""
    table = collections.defaultdict(lambda: dict(warm=[], cold=[], extra=[]))
    for a, kind, value, why in rows:
        local, plugin = a['desc'].split(':', 1)
        if kind == 'extra' and value > 0:
            table[plugin]['extra'].append([int(local, 16), value])
        elif kind == 'rated' and why != 'keyword' and value != 'normal':
            table[plugin][value].append(int(local, 16))
    return {p: {k: sorted(v) for k, v in t.items() if v} for p, t in sorted(table.items(), key=lambda x: x[0].lower())}


def counts_of(rows):
    c = collections.Counter()
    for a, kind, value, why in rows:
        if kind == 'extra':
            c['extra' if value > 0 else 'unrated'] += 1
        else:
            c[f'{value} ({why})'] += 1
    return dict(sorted(c.items()))


def write_ts(table, counts, plugins):
    hexes = lambda ids: '[' + ', '.join(f'0x{i:x}' for i in ids) + ']'
    lines = [
        '// Generated by misc/gen-armor-warmth.py from the ARMO records of the server load order; rerun it instead of editing.',
        '// Survival warmth of playable pieces the engine rates as plain or not at all: a class for body, head, hands and feet pieces, points for the rest.',
        f'export const ARMOR_WARMTH_INPUTS: {{ plugins: number; counts: Record<string, number> }} = {{ plugins: {plugins}, counts: {json.dumps(counts)} }};',
        '// Plugin file name -> local form ids rated warm or cold, and [local form id, points] of cloaks, capes, collars, scarves and masks',
        'export const ARMOR_WARMTH: Record<string, { warm?: number[]; cold?: number[]; extra?: number[][] }> = {',
    ]
    for plugin, t in table.items():
        parts = [f'{k}: {hexes(t[k])}' for k in ('warm', 'cold') if k in t]
        if 'extra' in t:
            parts.append('extra: [' + ', '.join(f'[0x{i:x}, {v}]' for i, v in t['extra']) + ']')
        lines.append(f'  {json.dumps(plugin)}: {{ {", ".join(parts)} }},')
    lines.append('};')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')


def main():
    sys.path.insert(0, os.path.join(HERE, 'combat-settings'))
    import loadorder as L
    settings_path = arg('--settings', os.path.join(REPO, 'build', 'dist', 'server', 'server-settings.json'))
    load_order = L.read_load_order(settings_path)
    data_dir = arg('--data', '')
    if data_dir:
        load_order = [os.path.join(data_dir, os.path.basename(p)) for p in load_order]
    lo = L.LoadOrder(load_order, None, data_dir or None, log=lambda *_: None)
    rows = classify(L.armors(lo))
    if '--dump' in sys.argv:
        for a, kind, value, why in rows:
            print('\t'.join([a['desc'], a['edid'], a['name'], a['armor_type'], a['biped_slots'], kind, str(value), why]))
        return
    table, counts = table_of(rows), counts_of(rows)
    write_ts(table, counts, len(load_order))
    entries = sum(len(v) for t in table.values() for v in t.values())
    print(f'[armor-warmth] {len(rows)} playable armours of {len(load_order)} plugins: {json.dumps(counts)}')
    print(f'[armor-warmth] wrote {entries} entries of {len(table)} plugins to {os.path.relpath(OUT, REPO)}')


if __name__ == '__main__':
    main()
