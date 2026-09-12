// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Inventory entries as the binding returns them (Inventory.h) and the item identity shared with the client's extrasEqual

// One effect of a player-made enchantment (Inventory::EnchantmentEffect)
export interface EnchantmentEffect {
  effectId: number;
  magnitude: number;
  area: number;
  duration: number;
  cost: number;
}

// Mirror of Inventory::ExtraData minus the worn flags
export interface Extras {
  health?: number;
  enchantmentId?: number;
  maxCharge?: number;
  removeEnchantmentOnUnequip?: boolean;
  chargePercent?: number;
  name?: string;
  soul?: number;
  poisonId?: number;
  poisonCount?: number;
  enchantmentEffects?: EnchantmentEffect[];
}

export interface Item extends Extras {
  baseId: number;
  count: number;
}

export interface InventoryEntry extends Item {
  worn?: boolean;
  wornLeft?: boolean;
}

export interface Inventory {
  entries: InventoryEntry[];
}

// Extras that tell copies apart; charge drifts with use and names only matter on property keys
export const IDENTITY_KEYS = [
  'health', 'enchantmentId', 'maxCharge', 'removeEnchantmentOnUnequip',
  'soul', 'poisonId', 'poisonCount', 'enchantmentEffects',
] as const;

export const EXTRA_KEYS: (keyof Extras)[] = [...IDENTITY_KEYS, 'chargePercent', 'name'];

// Property keys (housing): the name is the credential.
export const KEY_BASE_ID = 0x000db0e2;

const MAX_EFFECTS = 8;

// Zero and empty extras mean nothing (armor enchantments carry maxCharge 0)
export const isSet = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && !(Array.isArray(v) && v.length === 0);

export const sameBase = (a: Item, b: Item): boolean => (a.baseId >>> 0) === (b.baseId >>> 0);

export const isKeyItem = (i: Item): boolean => (i.baseId >>> 0) === KEY_BASE_ID;

export const keyName = (i: Item): string => (isKeyItem(i) && typeof i.name === 'string' ? i.name : '');

export const hasIdentityExtras = (i: Item): boolean => IDENTITY_KEYS.some((k) => isSet(i[k]));

// Floats pass through C++ float storage
export const sameFloat = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(a));

// Tempering in tenths, the precision clients read it with
export const healthStep = (health?: number): number => (typeof health === 'number' && health > 1 ? Math.round(health * 10) : 10);

export const sameEffects = (a?: EnchantmentEffect[], b?: EnchantmentEffect[]): boolean => {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((e, i) =>
    e.effectId === y[i].effectId && e.area === y[i].area && e.duration === y[i].duration &&
    sameFloat(e.magnitude, y[i].magnitude));
};

// Same text as the client's effectsKey
export const effectsKey = (effects?: EnchantmentEffect[]): string =>
  (effects || []).map((e) => `${e.effectId >>> 0}:${Math.round(e.magnitude * 1000) / 1000}:${e.area}:${e.duration}`).join(',');

export const isEnchanted = (i: Extras): boolean => isSet(i.enchantmentId) || isSet(i.enchantmentEffects);

function sameIdentityValue(key: keyof Extras, a: unknown, b: unknown): boolean {
  if (key === 'health') {
    return healthStep(a as number) === healthStep(b as number);
  }
  if (key === 'enchantmentEffects') {
    return sameEffects(a as EnchantmentEffect[], b as EnchantmentEffect[]);
  }
  if (!isSet(a) || !isSet(b)) {
    return !isSet(a) && !isSet(b);
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return sameFloat(a, b);
  }
  return a === b;
}

export function sameItem(e: Item, item: Item): boolean {
  return sameBase(e, item) && keyName(e) === keyName(item) && IDENTITY_KEYS.every((k) => sameIdentityValue(k, e[k], item[k]));
}

function identityText(key: keyof Extras, v: unknown): string {
  if (key === 'health') {
    return healthStep(v as number) > 10 ? String(healthStep(v as number)) : '';
  }
  if (key === 'enchantmentEffects') {
    return effectsKey(v as EnchantmentEffect[]);
  }
  return isSet(v) ? String(v) : '';
}

// Same shape as the client's lineKey in tradeService.ts
export function lineKey(i: Item): string {
  return [i.baseId >>> 0, keyName(i), ...IDENTITY_KEYS.map((k) => identityText(k, i[k]))].join('|');
}

// Identical copies, charge and name included: the ones that may share one entry
export function sameExtras(a: Item, b: Item): boolean {
  const charge = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return sameBase(a, b) && IDENTITY_KEYS.every((k) => sameIdentityValue(k, a[k], b[k]))
    && sameFloat(charge(a.chargePercent), charge(b.chargePercent)) && (a.name || '') === (b.name || '');
}

export function validEffects(raw: unknown): EnchantmentEffect[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EFFECTS) {
    return undefined;
  }
  const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
  const real = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const out: EnchantmentEffect[] = [];
  for (const e of raw) {
    if (!e || !whole(e.effectId) || !e.effectId || !real(e.magnitude) || !whole(e.area) || !whole(e.duration) || !real(e.cost)) {
      return undefined;
    }
    out.push({ effectId: e.effectId >>> 0, magnitude: e.magnitude, area: e.area, duration: e.duration, cost: e.cost });
  }
  return out;
}

export function copyValidExtras(raw: any, item: Item): void {
  // Same acceptance rule as the client's toItem, so both sides build the same lineKey
  const num = (v: unknown, allowZero = false): number | undefined =>
    (typeof v === 'number' && Number.isFinite(v) && (v > 0 || (allowZero && v === 0)) ? v : undefined);
  const id = (v: unknown, max: number): number | undefined =>
    (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max ? v : undefined);
  const extras: Extras = {
    health: num(raw?.health),
    enchantmentId: id(raw?.enchantmentId, 0xffffffff),
    maxCharge: num(raw?.maxCharge),
    removeEnchantmentOnUnequip: raw?.removeEnchantmentOnUnequip === true ? true : undefined,
    chargePercent: num(raw?.chargePercent, true),
    name: typeof raw?.name === 'string' && raw.name ? raw.name.slice(0, 256) : undefined,
    soul: id(raw?.soul, 5),
    poisonId: id(raw?.poisonId, 0xffffffff),
    poisonCount: id(raw?.poisonCount, 0xffffffff),
    enchantmentEffects: validEffects(raw?.enchantmentEffects),
  };
  for (const k of EXTRA_KEYS) {
    if (extras[k] !== undefined) {
      (item as any)[k] = extras[k];
    }
  }
}

export function readInventory(mp: Mp, actorId: number): Inventory {
  const inv = mp.get(actorId, 'inventory');
  if (inv && Array.isArray(inv.entries)) {
    return inv as Inventory;
  }
  return { entries: [] };
}

export function withCount(e: InventoryEntry, count: number): InventoryEntry {
  const copy: InventoryEntry = { ...e, count };
  delete copy.worn;
  delete copy.wornLeft;
  return copy;
}

// Stack entries onto a working inventory copy, only onto copies with identical extras
export function addEntries(inv: Inventory, entries: InventoryEntry[]): Inventory {
  const out = inv.entries.map((e) => ({ ...e }));
  for (const add of entries) {
    const stack = out.find((e) => sameExtras(e, add) && !e.worn && !e.wornLeft);
    if (stack) {
      stack.count += add.count;
    } else {
      out.push({ ...add });
    }
  }
  return { entries: out };
}

// Log text of an entry's extras, e.g. health=1.2, enchantmentEffects=[0x4605a 12.5 a0 d1]
export function describeExtras(i: Item): string[] {
  const hex = (v: unknown): string => '0x' + (Number(v) >>> 0).toString(16);
  return EXTRA_KEYS.filter((k) => k !== 'name' && isSet(i[k])).map((k) => {
    if (k === 'enchantmentId' || k === 'poisonId') {
      return k + '=' + hex(i[k]);
    }
    if (k === 'enchantmentEffects') {
      return k + '=[' + (i.enchantmentEffects || []).map((e) =>
        `${hex(e.effectId)} ${Math.round(e.magnitude * 100) / 100} a${e.area} d${e.duration}`).join('; ') + ']';
    }
    return k + '=' + String(i[k]);
  });
}
