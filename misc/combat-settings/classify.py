"""The rebalance's shared item classifier (plan (e)), the recipe-rank audit and every list derived from them.

It runs on the record dicts of loadorder.py or on the 2026-09-29 research dump (items/*.json); both carry edid,
keywords, template, anim_type, speed, biped_slots, armor_type, ar, weight and non_playable. Rows, types and numbers
come from design.json. Resolution order: form-id override (regex rules on the record or any template it inherits
from, then the recipe-rank audit), specific then generic keyword, AldCatMat_*, fallback. The audit counts only recipes
in play: one the patcher parks on its out-of-play bench keyword (spec.json uncraftable.bench, tailoring.disabledBench)
is loot-only.
"""
import json
import os
import re

RANK = {'Tool': 0, 'Free': 0, 'Novice': 1, 'Adept': 2, 'Expert': 3, 'Master': 4, 'Legendary': 5}
RANK_NAME = {0: 'Free', 1: 'Novice', 2: 'Adept', 3: 'Expert', 4: 'Master', 5: 'Legendary'}
TEMPER_BENCHES = ('CraftingSmithingArmorTable', 'CraftingSmithingSharpeningWheel')
PATCHER_SPEC = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'proficiency-patcher', 'spec.json')
PROF_GATE = re.compile(r'AldProf_(\w+?)_(Novice|Adept|Expert|Master|Legendary)\b')
MELEE_TYPE = {'OneHandDagger': 'dagger', 'OneHandSword': 'sword', 'OneHandAxe': 'waraxe', 'OneHandMace': 'mace',
              'TwoHandSword': 'greatsword'}
HEAD_SLOTS = (30, 31, 41, 42, 43)
BUCKETS = (('cuirass', (32,)), ('helmet', HEAD_SLOTS), ('gauntlets', (33,)), ('boots', (37,)))
SHIELD_SLOT = 39
CLOSED_HELMET = re.compile(r'_(U_)?CLS$')
DUMMY_ROW = 'Dummy'


def kw_list(rec):
    k = rec.get('keywords') or ''
    return k.split() if isinstance(k, str) else list(k)


def slots_of(rec):
    return {int(s) for s in re.findall(r'(\d+):?', rec.get('biped_slots') or '')}


def rid(r):
    return r['formid']


def fallback_rule(rule):
    return rule if rule.startswith('fallback') else rule + ' -> fallback'


def is_fallback(rule):
    return 'fallback' in rule


def round_half_up(x):
    return int(x + 0.5)


def parked_benches(spec_path=PATCHER_SPEC):
    """The bench keywords the patcher parks recipes on to take them out of play (MothNest1 today)."""
    with open(spec_path, encoding='utf-8') as f:
        spec = json.load(f)
    return {b for b in ((spec.get('uncraftable') or {}).get('bench'), (spec.get('tailoring') or {}).get('disabledBench')) if b}


class Classifier:
    def __init__(self, design, weapons, armors, cobjs, assume_retier=False, parked=None):
        self.D = design
        self.parked = parked_benches() if parked is None else set(parked)
        K = design['keywordMap']
        self.K = K
        self.ow = [(re.compile(p), m, note) for p, m, note in K['overridesWeapons']]
        self.oa = [(re.compile(p), m, note) for p, m, note in K['overridesArmor']]
        self.weapons = [w for w in weapons if not w.get('deleted')]
        self.armors = [a for a in armors if not a.get('deleted')]
        self.cobjs = [c for c in cobjs if not c.get('deleted')]
        self.by_edid = {}
        for r in self.weapons + self.armors:
            self.by_edid.setdefault(r['edid'], r)
        self.retier = [(re.compile(x['created']), x) for x in design.get('recipeRetier', {}).get('rules', [])] if assume_retier else []
        self.recipe_rank = self._recipe_ranks()
        self.temper = {}
        for c in self.cobjs:
            if c['bench'] in TEMPER_BENCHES:
                self.temper.setdefault(c['created_edid'], []).append(c)

    # ------------------------------------------------------------ recipes
    def _recipe_ranks(self):
        """created edid -> lowest AldProf rank among its crafting (not temper, not parked) recipes."""
        ranks = {}
        for c in self.cobjs:
            if c['bench'] in TEMPER_BENCHES or c['bench'] in self.parked:
                continue
            conds = c['conditions'] if isinstance(c['conditions'], list) else [c['conditions'] or '']
            found = PROF_GATE.findall(' '.join(map(str, conds)))
            if not found:
                continue
            e = c['created_edid']
            v = min(RANK[r] for _, r in found)
            for rx, rule in self.retier:
                if rx.search(e):
                    v = RANK[rule['rank']]
            ranks[e] = min(v, ranks.get(e, 9))
        return ranks

    # ------------------------------------------------------------ resolution
    def template_chain(self, rec):
        """The record's own edid, then each template it inherits from."""
        out, seen, cur = [], set(), rec
        while cur and cur['edid'] not in seen:
            seen.add(cur['edid'])
            out.append(cur['edid'])
            t = cur.get('template')
            cur = self.by_edid.get(t) if t else None
            if t and not cur:
                out.append(t)
        return out

    def resolve(self, rec, kmap, overrides):
        chain = self.template_chain(rec)
        for rx, m, _ in overrides:
            if any(rx.search(e) for e in chain):
                return 'override', m
        ks = kw_list(rec)
        if sum(1 for x in ks if x.startswith('IAKMaterial')) >= self.K['multiIAKFallback']:
            return 'fallback(IA multi)', None
        for kw, m in kmap:
            if kw in ks:
                return 'keyword', m
        for kw, m in self.K['aldCatMat']:
            if kw in ks:
                return 'AldCatMat', m
        return 'fallback', None

    def weapon_type(self, w):
        at = w['anim_type']
        if at in MELEE_TYPE:
            return MELEE_TYPE[at]
        if at == 'TwoHandAxe':
            return 'warhammer' if 'WeapTypeWarhammer' in kw_list(w) else 'battleaxe'
        return {'Bow': 'bow', 'Crossbow': 'crossbow', 'HandToHand': 'unarmed', 'Staff': 'staff'}.get(at, 'unknown')

    def classify_weapon(self, w):
        """{kind, type, rule, row, tier}: kind weapon | bow | crossbow | staff | unarmed | dummy."""
        t = self.weapon_type(w)
        bows = self.D['bows']
        if t == 'staff':
            return dict(kind='staff', type=t, rule='staff (0)', row=None, tier=None)
        if t in ('unarmed', 'unknown'):
            return dict(kind=t, type=t, rule='unarmed row' if t == 'unarmed' else 'unknown animation', row=None, tier=None)
        if t == 'crossbow':
            row = 'Dwarven' if 'WeapMaterialDwarven' in kw_list(w) else 'Crossbow'
            return dict(kind='crossbow', type=t, rule='crossbow row', row=row, tier=bows['crossbows'][row]['tier'])
        rule, row = self.resolve(w, self.K['weapons'], self.ow)
        if row == DUMMY_ROW:
            return dict(kind='dummy', type=t, rule=rule, row=row, tier=None)
        fb = self.K['fallbackRows']
        if t == 'bow':
            brow = row if row in bows['bows'] else bows['rowForMaterial'].get(row)
            if not brow:
                rule, brow = fallback_rule(rule), fb['bow']
            return dict(kind='bow', type=t, rule=rule, row=brow, tier=bows['bows'][brow]['tier'])
        if row not in self.D['weapons']:
            rule, row = fallback_rule(rule), fb['weapon']
        return dict(kind='weapon', type=t, rule=rule, row=row, tier=self.D['weapons'][row]['tier'])

    def is_clothing(self, a):
        ks = kw_list(a)
        return a['armor_type'] == 'Clothing' or 'ArmorClothing' in ks or 'ArmorJewelry' in ks

    def buckets(self, a):
        s = slots_of(a)
        if SHIELD_SLOT in s or 'ArmorShield' in kw_list(a):
            return ['shield']
        return [b for b, ids in BUCKETS if s & set(ids)]

    def classify_armor(self, a):
        """{kind, rule, row, cls, tier, buckets, lightOnHeavy}: kind armor | shield | clothing."""
        if self.is_clothing(a):
            return dict(kind='clothing', rule='clothing/jewelry (DT 0)', row=None, cls='clothing', tier=None, buckets=[], lightOnHeavy=False)
        rule, row = self.resolve(a, self.K['armor'], self.oa)
        b = self.buckets(a)
        fb = self.K['fallbackRows']
        if row not in self.D['armor']:
            rule = fallback_rule(rule)
            row = fb['shield'] if b == ['shield'] else fb['armorHeavy'] if a['armor_type'] == 'Heavy' else fb['armorLight']
        A = self.D['armor'][row]
        return dict(kind='shield' if b == ['shield'] else 'armor', rule=rule, row=row, cls=A['class'], tier=A['tier'], buckets=b,
                    lightOnHeavy=a['armor_type'] == 'Light' and A['class'] == 'heavy')

    # ------------------------------------------------------------ the whole load order
    def run(self):
        refs = self.K['rankReferenceRows']
        bows = self.D['bows']
        W, A = {}, {}
        audit = []
        for w in self.weapons:
            c = self.classify_weapon(w)
            W[rid(w)] = c
            rr = self.recipe_rank.get(w['edid'])
            if rr is None or c['row'] is None or c['kind'] == 'dummy' or c['rule'] == 'override' or is_fallback(c['rule']):
                continue
            if RANK[c['tier']] > rr:
                cls = 'crossbow' if c['kind'] == 'crossbow' else 'weapon'
                to = refs[cls][RANK_NAME[rr]] if RANK_NAME[rr] in refs[cls] else None
                if c['kind'] == 'bow' and to:
                    to = to if to in bows['bows'] else bows['rowForMaterial'][to]
                audit.append(dict(sig='WEAP', rec=w, kind=c['kind'], row=c['row'], tier=c['tier'], rank=RANK_NAME[rr], to=to))
        for a in self.armors:
            c = self.classify_armor(a)
            A[rid(a)] = c
            rr = self.recipe_rank.get(a['edid'])
            if rr is None or c['kind'] == 'clothing' or c['rule'] == 'override' or is_fallback(c['rule']) or CLOSED_HELMET.search(a['edid']):
                continue
            if c['tier'] in RANK and RANK[c['tier']] > rr:
                to = refs[c['cls']].get(RANK_NAME[rr])
                audit.append(dict(sig='ARMO', rec=a, kind=c['kind'], row=c['row'], tier=c['tier'], rank=RANK_NAME[rr], to=to))
        self.W, self.A, self.audit = W, A, audit
        self.audited = {rid(x['rec']): x for x in audit if x['to']}
        by_edid = {x['rec']['edid']: x for x in audit if x['to']}
        self.variants = {}
        for sig, recs, table in (('WEAP', self.weapons, W), ('ARMO', self.armors, A)):
            for r in recs:
                if not r.get('template') or table[rid(r)]['rule'] == 'override':
                    continue
                base = next((e for e in self.template_chain(r)[1:] if e in by_edid), None)
                if base:
                    self.variants[rid(r)] = dict(sig=sig, rec=r, base=base, to=by_edid[base]['to'])
        return self

    def playable(self, r):
        return not r.get('non_playable') and bool(r.get('name'))

    def final_row(self, sig, r):
        """The row the server resolves, overrides included (the audit and its template variants)."""
        c = (self.W if sig == 'WEAP' else self.A)[rid(r)]
        if rid(r) in self.variants:
            return self.variants[rid(r)]['to'], 'audit (template)'
        if rid(r) in self.audited:
            return self.audited[rid(r)]['to'], 'audit'
        return c['row'], c['rule']

    # ------------------------------------------------------------ numbers the ESP shows
    def weapon_damage(self, kind, wtype, row):
        if kind == 'weapon':
            return self.D['weapons'][row]['base'] * self.D['weaponTypes'][wtype]['dmgMult']
        if kind == 'bow':
            return self.D['bows']['bows'][row]['base']
        if kind == 'crossbow':
            return self.D['bows']['crossbows'][row]['base']
        return None

    def std_speed(self, kind, wtype, row):
        if kind == 'weapon':
            return self.D['weaponTypes'][wtype]['speed']
        if kind == 'bow':
            return self.D['bows']['bows'][row]['speed']
        return None

    def piece_dt(self, c, row):
        A = self.D['armor'][row]
        f = self.D['formula']
        if A['setDT'] is None:
            return (A['dt'].get('shield') or 0) if c['kind'] == 'shield' else 0.0
        if c['kind'] == 'shield':
            return A['setDT'] * f['shieldShare']
        share = self.D['armorRules']['slotShare']
        d = sum(A['setDT'] * share[b] for b in c['buckets'])
        return d * (f['lightItemHeavyRowFactor'] if c['lightOnHeavy'] else 1)

    def piece_weight(self, c, row):
        w = self.D['armor'][row]['weight']
        if c['kind'] == 'shield':
            return w.get('shield')
        vals = [w.get(b) for b in c['buckets']]
        return sum(vals) if vals and None not in vals else None
