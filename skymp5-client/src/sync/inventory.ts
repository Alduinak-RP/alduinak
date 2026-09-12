import {
  getExtraContainerChanges,
  getContainer,
  BaseExtraList,
  ExtraHealth,
  ObjectReference,
  TESModPlatform,
  Game,
  storage,
  ExtraCount,
  ExtraEnchantment,
  ExtraPoison,
  ExtraSoul,
  ExtraTextDisplayData,
  ExtraCharge,
  Enchantment,
  Potion,
  Actor,
  Ammo,
  printConsole,
  ActorBase,
  FormType,
  Form,
  Weapon,
} from "skyrimPlatform";
// @ts-expect-error (TODO: Remove in 2.10.0)
import { createEnchantment } from "skyrimPlatform";

// Vanilla boundArrow, added by bound bow effects
const BOUND_ARROW_ID = 0x10b0a7;

// Bound weapon spells add items the server inventory never holds, removing them ends the spell
export const isBoundItem = (form: Form): boolean => {
  if (form.getFormID() === BOUND_ARROW_ID) {
    return true;
  }
  return !!Weapon.from(form) && !form.isPlayable();
};

// One effect of a player-made enchantment (Inventory::EnchantmentEffect on the server)
export interface EnchantmentEffect {
  effectId: number;
  magnitude: number;
  area: number;
  duration: number;
  cost: number;
}

export interface Extra {
  health?: number;
  enchantmentId?: number;
  maxCharge?: number;
  removeEnchantmentOnUnequip?: boolean;
  chargePercent?: number;
  name?: string;
  soul?: 0 | 1 | 2 | 3 | 4 | 5;
  poisonId?: number;
  poisonCount?: number;
  enchantmentEffects?: EnchantmentEffect[];
  worn?: boolean;
  wornLeft?: boolean;
}

export interface BasicEntry {
  baseId: number;
  count: number;
}

export type Entry = BasicEntry & Extra;

export interface Inventory {
  entries: Entry[];
}

// 'loxsword (Legendary)' => 'loxsword'
const getRealName = (s?: string): string => {
  if (!s) {
    return s as string;
  }

  const arr = s.split(" ");
  if (arr.length && arr[arr.length - 1].match(/^\(.*\)$/)) {
    arr.pop();
  }
  return arr.join(" ");
};

// 'aaaaaaaaaaaaaaaa' => 'aaa...'
const cropName = (s?: string): string => {
  if (!s) {
    return s as string;
  }

  const max = 128;
  return s.length >= max
    ? s
      .split("")
      .filter((x, i) => i < max)
      .join("")
      .concat("...")
    : s;
};

const checkIfNameIsGeneratedByGame = (
  aStr: string,
  bStr: string,
  formName: string
) => {
  if (!aStr.length && bStr.startsWith(formName)) {
    const bEnding = bStr.substr(formName.length);
    if (bEnding.match(/^\s\(.*\)$/)) {
      return true;
    }
  }
  return false;
};

const namesEqual = (a: Entry, b: Entry): boolean => {
  const aStr = a.name || "";
  const bStr = b.name || "";
  if (cropName(getRealName(aStr)) === cropName(getRealName(bStr))) {
    return true;
  }

  if (a.baseId === b.baseId) {
    const form = Game.getFormEx(a.baseId);
    if (form) {
      const formName = form.getName();
      if (
        checkIfNameIsGeneratedByGame(aStr, bStr, formName) ||
        checkIfNameIsGeneratedByGame(bStr, aStr, formName)
      )
        return true;
    }
  }

  return false;
};

// Property keys (housing system) are identified by their name extra, so name
// blindness would merge distinct keys and desync against the server.
export const PROPERTY_KEY_BASE_ID = 0x000DB0E2; // TODO: Replace with mod key when ESP is made

// Server floats pass through C++ float storage
const sameFloat = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(a));

// Tempering in tenths, the precision extractExtraData reads it with
const healthStep = (health?: number): number => (health && health > 1 ? Math.round(health * 10) : 10);

export const sameEffects = (a?: EnchantmentEffect[], b?: EnchantmentEffect[]): boolean => {
  const x = a || [];
  const y = b || [];
  return x.length === y.length && x.every((e, i) =>
    e.effectId === y[i].effectId && e.area === y[i].area && e.duration === y[i].duration &&
    sameFloat(e.magnitude, y[i].magnitude));
};

// Same text as the server's effectsKey (inventoryExtras.ts)
export const effectsKey = (effects?: EnchantmentEffect[]): string =>
  (effects || []).map((e) => `${e.effectId >>> 0}:${Math.round(e.magnitude * 1000) / 1000}:${e.area}:${e.duration}`).join(',');

const extrasEqual = (a: Entry, b: Entry, ignoreWorn = false) => {
  return (
    healthStep(a.health) === healthStep(b.health) &&
    (a.enchantmentId || 0) === (b.enchantmentId || 0) &&
    sameEffects(a.enchantmentEffects, b.enchantmentEffects) &&
    sameFloat(a.maxCharge || 0, b.maxCharge || 0) &&
    !!a.removeEnchantmentOnUnequip === !!b.removeEnchantmentOnUnequip &&
    //a.chargePercent === b.chargePercent &&
    //namesEqual(a, b) &&
    ((a.baseId >>> 0) !== PROPERTY_KEY_BASE_ID || (a.name || '') === (b.name || '')) &&
    (a.soul || 0) === (b.soul || 0) &&
    (a.poisonId || 0) === (b.poisonId || 0) &&
    (a.poisonCount || 0) === (b.poisonCount || 0) &&
    ((!!a.worn === !!b.worn && !!a.wornLeft === !!b.wornLeft) || ignoreWorn)
  );
};

export const hasExtras = (e: Entry): boolean => {
  return !extrasEqual(e, { baseId: 0, count: 0 });
};

// Extras the server records; worn state is not one of them
export const hasItemExtras = (e: Entry): boolean => {
  return !extrasEqual(e, { baseId: 0, count: 0 }, true);
};

export const sameItem = (a: Entry, b: Entry): boolean => a.baseId === b.baseId && extrasEqual(a, b, true);

const playerEnchantments = (): Map<string, number> => {
  if (storage["playerEnchantmentsExists"] !== true) {
    storage["playerEnchantmentsExists"] = true;
    storage["playerEnchantments"] = new Map<string, number>();
  }
  return storage["playerEnchantments"] as Map<string, number>;
};

export const canCreateEnchantments = (): boolean => typeof createEnchantment === "function";

// This session's runtime enchantment for a player-made definition, made once and reused
export const getPlayerEnchantment = (effects: EnchantmentEffect[], item: Form): Enchantment | null => {
  if (!canCreateEnchantments() || !effects.length) {
    return null;
  }
  const isWeapon = item.getType() === FormType.Weapon;
  const key = (isWeapon ? "w" : "a") + effectsKey(effects);
  const known = playerEnchantments().get(key);
  const cached = known ? Enchantment.from(Game.getFormEx(known)) : null;
  if (cached) {
    return cached;
  }
  const id = Number(createEnchantment(isWeapon, effects)) >>> 0;
  if (!id) {
    return null;
  }
  playerEnchantments().set(key, id);
  return Enchantment.from(Game.getFormEx(id));
};

// Copies with a player enchantment this client cannot rebuild are treated as plain, so they do not churn
const withoutPlayerEnchantments = (inv: Inventory): Inventory => ({
  entries: inv.entries.map((e) => {
    if (!e.enchantmentEffects) {
      return e;
    }
    const copy: Entry = { ...e };
    delete copy.enchantmentEffects;
    delete copy.maxCharge;
    delete copy.chargePercent;
    delete copy.removeEnchantmentOnUnequip;
    return copy;
  }),
});

const extractExtraData = (
  refr: ObjectReference,
  extraList: BaseExtraList | null,
  out: Entry
): void => {
  // I see that ExtraWorn is not emitted for 0xFF actors when arrows are equipped. Fixing
  const item = Game.getFormEx(out.baseId);
  if (Ammo.from(item)) {
    const actor = Actor.from(refr);
    if (actor && actor.isEquipped(item)) {
      out.worn = true;
    }
  }

  (extraList || []).forEach((extra) => {
    switch (extra.type) {
      case "Health":
        out.health = Math.round((extra as ExtraHealth).health * 10) / 10;

        // TESModPlatform::AddItemEx makes all items at least 1.01 health
        if (out.health === 1) {
          delete out.health;
        }
        break;
      case "Count":
        out.count = (extra as ExtraCount).count;
        break;
      case "Enchantment": {
        // A player-made enchantment is a runtime form of this session only, so it travels as its effects
        const effects = (extra as ExtraEnchantment & { effects?: EnchantmentEffect[] }).effects;
        if (effects && effects.length) {
          out.enchantmentEffects = effects.map((e) => ({
            effectId: e.effectId, magnitude: e.magnitude, area: e.area, duration: e.duration, cost: e.cost,
          }));
        } else {
          out.enchantmentId = (extra as ExtraEnchantment).enchantmentId;
        }
        out.maxCharge = (extra as ExtraEnchantment).maxCharge;
        out.removeEnchantmentOnUnequip = (
          extra as ExtraEnchantment
        ).removeOnUnequip;
        break;
      }
      case "Charge":
        out.chargePercent = (extra as ExtraCharge).charge;
        break;
      case "Poison":
        out.poisonId = (extra as ExtraPoison).poisonId;
        out.poisonCount = (extra as ExtraPoison).count;
        break;
      case "Soul":
        out.soul = (extra as ExtraSoul).soul;
        break;
      case "TextDisplayData":
        out.name = (extra as ExtraTextDisplayData).name;
        break;
      case "Worn":
        out.worn = true;
        break;
      case "WornLeft":
        out.wornLeft = true;
        break;
    }
  });
};

const squash = (inv: Inventory): Inventory => {
  const res = new Array<Entry>();
  inv.entries.forEach((e) => {
    const same = res.find((x) => e.baseId === x.baseId && extrasEqual(x, e));
    if (same) {
      same.count += e.count;
    } else {
      res.push(JSON.parse(JSON.stringify(e)));
    }
  });
  return { entries: res.filter((x) => x.count !== 0) };
};

const getExtraContainerChangesAsInventory = (
  refr: ObjectReference
): Inventory => {
  const extraContainerChanges = getExtraContainerChanges(refr.getFormID());
  const entries = new Array<Entry>();

  (extraContainerChanges || []).forEach((changesEntry) => {
    const entry: Entry = {
      baseId: changesEntry.baseId,
      count: changesEntry.countDelta,
    };

    (changesEntry.extendDataList || []).forEach((extraList) => {
      const e: Entry = {
        baseId: entry.baseId,
        count: 1,
      };
      extractExtraData(refr, extraList, e);
      entries.push(e);
      entry.count -= e.count;
    });

    if (entry.count !== 0) {
      entries.push(entry);
    }
  });

  let res: Inventory = { entries };
  res = squash(res);
  return res;
};

const getBaseContainerAsInventory = (refr: ObjectReference): Inventory => {
  return {
    entries: getContainer((refr.getBaseObject() as ActorBase).getFormID()),
  };
};

export const sumInventories = (lhs: Inventory, rhs: Inventory): Inventory => {
  const leftEntriesWithExtras = lhs.entries.filter((e) => hasExtras(e));
  const rightEntriesWithExtras = rhs.entries.filter((e) => hasExtras(e));
  const leftEntriesSimple = lhs.entries.filter((e) => !hasExtras(e));
  const rightEntriesSimple = rhs.entries.filter((e) => !hasExtras(e));

  leftEntriesSimple.forEach((e) => {
    const matching = rightEntriesSimple.find((x) => x.baseId === e.baseId);
    if (matching) {
      e.count += matching.count;
      matching.count = 0;
    }
  });

  return {
    entries: leftEntriesWithExtras
      .concat(rightEntriesWithExtras)
      .concat(leftEntriesSimple)
      .concat(rightEntriesSimple)
      .filter((e) => e.count !== 0),
  };
};

export const removeSimpleItemsAsManyAsPossible = (
  inv: Inventory,
  baseId: number,
  count: number
): Inventory => {
  const res: Inventory = { entries: [] };
  res.entries = JSON.parse(JSON.stringify(inv.entries));

  const entry = res.entries.find((e) => !hasExtras(e) && e.baseId === baseId);
  if (entry) {
    entry.count -= count;
  }

  res.entries = res.entries.filter((e) => e.count > 0);
  return res;
};

// apply: lhs is the server's inventory; a local copy with extras the server has not recorded yet keeps a plain server copy,
// while extras only the server holds reach the local copy
// snapshot: two views of one inventory where either side may lack extras nobody recorded
// exact: no fallback, every difference in extras shows
export type DiffMode = "apply" | "snapshot" | "exact";

// lhs minus rhs, item by item
export const getDiff = (
  lhs: Inventory,
  rhs: Inventory,
  ignoreWorn: boolean,
  mode: DiffMode = "snapshot"
): Inventory => {
  const lhsCopy: Inventory = JSON.parse(JSON.stringify(lhs));
  const pending: Entry[] = JSON.parse(JSON.stringify(rhs.entries));

  // Draws from every fitting lhs copy, so copies that differ only by charge still pair up
  const draw = (e: Entry, fits: (x: Entry) => boolean): void => {
    for (const x of lhsCopy.entries) {
      if (e.count <= 0) {
        return;
      }
      if (x.count > 0 && x.baseId === e.baseId && fits(x)) {
        const n = Math.min(x.count, e.count);
        x.count -= n;
        e.count -= n;
      }
    }
  };

  pending.forEach((e) => draw(e, (x) => extrasEqual(x, e, ignoreWorn)));
  if (mode !== "exact") {
    pending.forEach((e) => draw(e, (x) =>
      mode === "apply" ? !hasItemExtras(x) && hasItemExtras(e) : hasItemExtras(x) !== hasItemExtras(e)));
  }

  pending.forEach((e) => {
    if (e.count === 0) {
      return;
    }
    const sameFromLeft = e.count < 0
      ? lhsCopy.entries.find((x) => x.baseId === e.baseId && extrasEqual(x, e, ignoreWorn))
      : undefined;
    if (sameFromLeft) {
      sameFromLeft.count -= e.count;
      return;
    }
    lhsCopy.entries.push({ ...e, count: -e.count });
  });

  return { entries: lhsCopy.entries.filter((x) => x.count !== 0) };
};

export const getInventory = (refr: ObjectReference): Inventory => {
  return squash(
    sumInventories(
      getBaseContainerAsInventory(refr),
      getExtraContainerChangesAsInventory(refr)
    )
  );
};

const basesReset = (): Set<number> => {
  if (storage["basesResetExists"] !== true) {
    storage["basesResetExists"] = true;
    storage["basesReset"] = new Set<number>();
  }
  return storage["basesReset"] as Set<number>;
};

const resetBase = (refr: ObjectReference): void => {
  const base = refr.getBaseObject();
  const baseId = base ? base.getFormID() : 0;
  if (!basesReset().has(baseId)) {
    basesReset().add(baseId);
    TESModPlatform.resetContainer(base);

    refr.removeAllItems(null, false, true);
  }
};

export const applyInventory = (
  refr: ObjectReference,
  newInventory: Inventory,
  enableCrashProtection: boolean,
  ignoreWorn = false
): boolean => {
  resetBase(refr);
  const target = canCreateEnchantments() ? newInventory : withoutPlayerEnchantments(newInventory);
  const diff = getDiff(target, getInventory(refr), ignoreWorn, "apply").entries;

  let res = true;

  diff.sort((a, b) => (a.count < b.count ? -1 : 1));
  diff.forEach((e, i) => {
    if (i > 0 && enableCrashProtection) {
      res = false;
      return;
    }
    let absCount = Math.abs(e.count);

    let queueNiNodeUpdateNeeded = false;

    const worn = !!e.worn;
    const wornLeft = !!e.wornLeft;

    let oneStepCount = e.count / absCount;

    const f = Game.getFormEx(e.baseId);
    if (!f) {
      return printConsole(`Bad form ID ${e.baseId.toString(16)}`);
    }
    if (e.count < 0 && refr.getFormID() === 0x14 && isBoundItem(f)) {
      return;
    }
    const type = f.getType();
    // For misc items, potions and ingredients we don't want to split them into multiple items
    // This was made to fix a performance issue with users having 10000+ of misc items (i.e. gold)
    if (
      type === FormType.Misc ||
      type === FormType.Potion ||
      type === FormType.Ingredient
    ) {
      absCount = 1;
      oneStepCount = e.count;
    } else {
      if (absCount > 1000) {
        absCount = 1;
        oneStepCount = 1;

        // Also for arrows with strange count
        if (worn && e.count < 0) {
          absCount = 0;
        }
      }

      if (e.count > 1 && Ammo.from(Game.getFormEx(e.baseId))) {
        absCount = 1;
        oneStepCount = e.count;
        if (e.count > 60000) {
          // Why would actor have 60k arrows?
          e.count = 1;
        }
      }
    }

    for (let i = 0; i < absCount; ++i) {
      if (worn || wornLeft) {
        TESModPlatform.pushWornState(!!worn, !!wornLeft);
        queueNiNodeUpdateNeeded = true;
      }

      let addItemExArgs: [
        ObjectReference,
        Form,
        number,
        number,
        Enchantment | null,
        number,
        boolean,
        number,
        string,
        number,
        Potion | null,
        number,
      ];

      addItemExArgs = [
        refr,
        f,
        oneStepCount,
        e.health ? e.health : 1,
        e.enchantmentEffects && e.enchantmentEffects.length
          ? getPlayerEnchantment(e.enchantmentEffects, f)
          : e.enchantmentId
            ? Enchantment.from(Game.getFormEx(e.enchantmentId))
            : null,
        e.maxCharge ? e.maxCharge : 0,
        !!e.removeEnchantmentOnUnequip,
        e.chargePercent ? e.chargePercent : 0,
        e.name ? cropName(e.name) : f.getName(),
        e.soul ? e.soul : 0,
        e.poisonId ? Potion.from(Game.getFormEx(e.poisonId)) : null,
        e.poisonCount ? e.poisonCount : 0
      ];

      const argsToPrint = addItemExArgs.map((arg) => {
        if (arg instanceof ObjectReference) {
          return `ObjectReference(${arg.getFormID().toString(16)})`;
        } else if (arg instanceof Form) {
          return `Form(${arg.getFormID().toString(16)})`;
        } else {
          return JSON.stringify(arg);
        }
      });

      printConsole(
        `TESModPlatform.addItemEx(${argsToPrint.join(", ")})`
      );

      TESModPlatform.addItemEx(...addItemExArgs);
    }

    if (queueNiNodeUpdateNeeded) {
      const ac = Actor.from(refr);
      if (ac) {
        ac.queueNiNodeUpdate();
      }
    }
  });

  return res;
};
