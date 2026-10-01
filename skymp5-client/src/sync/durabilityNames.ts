import * as sp from "skyrimPlatform";
import { Armor, Form, Game, ObjectReference, Weapon } from "skyrimPlatform";
import { Entry, Inventory, addItemExOf, extrasEqual, getRawEntries, isBoundItem, localNameOf, sameItem } from "./inventory";
import { logToPlatformLog, logTrace } from "../logging";

// A worn weapon or armor piece shows its condition in its name: "Steel Sword (97%)", "(Broken)" at 0
// The server owns the condition (Inventory::ExtraData condition); the name is display and the hint the server picks a copy by

export interface DurabilityConfig {
  enabled: boolean;
  showAtFull: boolean;
  brokenLabel: string;
}

// SkyrimPlatform's in-place rename of one inventory copy, absent in a dll older than the durability build
type SetInventoryItemName = (refrId: number, baseId: number, fromName: string, toName: string, worn: boolean, wornLeft: boolean) => boolean;

const DEFAULT_BROKEN_LABEL = "Broken";
const TEMPER_LABELS = "Fine|Superior|Exquisite|Flawless|Epic|Legendary";
const STAFF_WEAPON_TYPE = 8;
const WEIGHT_CLASS_NONE = 2;
const SHIELD_SLOT_MASK = 0x200;
const MAX_COPIES = 1000;
const KEPT_LOG_GAP_MS = 60000;

// Off until the server's durabilityConfig says otherwise, so a server without durability sees today's names
let config: DurabilityConfig = { enabled: false, showAtFull: true, brokenLabel: DEFAULT_BROKEN_LABEL };
// Every broken label of this session, so a tag written under an earlier one still parses
const brokenLabels = [DEFAULT_BROKEN_LABEL];
let tagPattern: RegExp | undefined;
// Tags may be in the pack, so a pass still runs after durability went off to take them out
let tagsWritten = false;
let keptLoggedAt = 0;
const durableBases = new Map<number, boolean>();

const nativeRename = (): SetInventoryItemName | undefined => {
  const fn = (sp as unknown as { setInventoryItemName?: SetInventoryItemName }).setInventoryItemName;
  return typeof fn === "function" ? fn : undefined;
};

export const canRenameInPlace = (): boolean => !!nativeRename();

export const getDurabilityConfig = (): DurabilityConfig => config;

// True when the names to show changed
export const setDurabilityConfig = (next: Partial<DurabilityConfig> | null): boolean => {
  const label = next && typeof next.brokenLabel === "string" && next.brokenLabel.trim() ? next.brokenLabel.trim() : DEFAULT_BROKEN_LABEL;
  const updated: DurabilityConfig = { enabled: !!next && next.enabled !== false, showAtFull: !next || next.showAtFull !== false, brokenLabel: label };
  const changed = updated.enabled !== config.enabled || updated.showAtFull !== config.showAtFull || updated.brokenLabel !== config.brokenLabel;
  if (brokenLabels.indexOf(label) < 0) {
    brokenLabels.push(label);
    tagPattern = undefined;
  }
  config = updated;
  return changed;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The last tag of a name, with the quality the engine may have put after it
const pattern = (): RegExp => {
  if (!tagPattern) {
    tagPattern = new RegExp(`^(.*) \\((\\d{1,3}%|${brokenLabels.map(escapeRegExp).join("|")})\\)( \\((?:${TEMPER_LABELS})\\))?$`);
  }
  return tagPattern;
};

const temperSuffix = new RegExp(` \\((?:${TEMPER_LABELS})\\)$`);

export interface TaggedName {
  base: string;
  tag: string;
  suffix: string;
}

// Nothing reads as a tag before the server has switched condition names on, so a name is never cut on a server without durability
export const splitTag = (name: string): TaggedName => {
  const m = config.enabled || tagsWritten ? pattern().exec(name) : null;
  return m ? { base: m[1], tag: `(${m[2]})`, suffix: m[3] || "" } : { base: name, tag: "", suffix: "" };
};

// "Steel Sword (97%) (Fine)" => "Steel Sword (Fine)"
export const stripTag = (name: string): string => {
  const split = splitTag(name);
  return split.base + split.suffix;
};

// Whole percent rounded down and never 0 above broken, as the server's ConditionPercent shows it
export const conditionPercent = (condition?: number): number => {
  if (typeof condition !== "number" || !(condition < 1)) return 100;
  if (condition <= 0) return 0;
  return Math.max(1, Math.floor(condition * 100 + 1e-3));
};

export const percentLabel = (percent: number): string => (percent <= 0 ? config.brokenLabel : `${percent}%`);

export const tagFor = (condition?: number): string => {
  if (!config.enabled) return "";
  const percent = conditionPercent(condition);
  return percent >= 100 && !config.showAtFull ? "" : `(${percentLabel(percent)})`;
};

// The percent a tag stands for; a name without one reads as pristine
export const tagPercent = (tag: string): number => {
  if (!tag) return 100;
  const m = /^\((\d{1,3})%\)$/.exec(tag);
  return m ? Math.min(100, Number(m[1])) : 0;
};

// The condition a tagged name shows, as the hint a trade offer carries; undefined for pristine
export const conditionOfName = (name?: string): number | undefined => {
  const tag = name ? splitTag(name).tag : "";
  return tag && tagPercent(tag) < 100 ? tagPercent(tag) / 100 : undefined;
};

// Weapons except staffs and bound ones, light and heavy armor, shields; clothing and jewelry never wear
export const isDurable = (form: Form | null): boolean => {
  if (!form) return false;
  const id = form.getFormID();
  let durable = durableBases.get(id);
  if (durable === undefined) {
    const weapon = Weapon.from(form);
    const armor = weapon ? null : Armor.from(form);
    durable = weapon
      ? weapon.getWeaponType() !== STAFF_WEAPON_TYPE && !isBoundItem(form)
      : !!armor && (armor.getWeightClass() !== WEIGHT_CLASS_NONE || (armor.getSlotMask() & SHIELD_SLOT_MASK) !== 0);
    durableBases.set(id, durable);
  }
  return durable;
};

export const isDurableBase = (baseId: number): boolean => {
  const known = durableBases.get(baseId);
  return known === undefined ? isDurable(Game.getFormEx(baseId)) : known;
};

// The name without its tag and without the quality the engine appends again by itself
const plainName = (name: string): string => {
  const split = splitTag(name);
  return split.tag ? split.base : name.replace(temperSuffix, "");
};

// The name a server copy is added under
export const durabilityName = (name: string, condition: number | undefined, form: Form): string => {
  if (!config.enabled || !isDurable(form)) return name;
  const tag = tagFor(condition);
  tagsWritten = tagsWritten || !!tag;
  const split = splitTag(name);
  const base = split.tag ? split.base : name;
  return tag ? `${base} ${tag}` : base;
};

const tagsOf = (entries: Entry[], baseId: number): string[] => {
  const tags: string[] = [];
  entries.forEach((e) => {
    if (e.baseId !== baseId) return;
    for (let i = 0; i < Math.min(e.count, MAX_COPIES); i++) tags.push(tagFor(e.condition));
  });
  return tags;
};

interface Copy {
  raw: Entry;
  tag: string;
  worn: boolean;
}

// One element per copy; copies stacked in one extra list share its raw entry
const copiesOf = (raws: Entry[]): Copy[] => {
  const copies: Copy[] = [];
  raws.forEach((raw) => {
    const tag = splitTag(raw.name || "").tag;
    for (let i = 0; i < Math.min(raw.count, MAX_COPIES); i++) copies.push({ raw, tag, worn: !!raw.worn || !!raw.wornLeft });
  });
  return copies;
};

// Which copy takes which new tag: a tag the server still holds stays, on unworn copies first, so a changed one lands on the worn copy and nearest in percent
export const pairTags = (local: { tag: string; worn: boolean }[], wanted: string[]): { paired: Map<number, string>; unmet: string[] } => {
  const left = wanted.slice();
  const open: number[] = [];
  const order = local.map((_, i) => i).sort((a, b) => Number(local[a].worn) - Number(local[b].worn) || a - b);
  order.forEach((i) => {
    const at = left.indexOf(local[i].tag);
    if (at >= 0) left.splice(at, 1);
    else open.push(i);
  });
  open.sort((a, b) => Number(local[b].worn) - Number(local[a].worn) || a - b);
  const paired = new Map<number, string>();
  open.forEach((i) => {
    if (!left.length) return;
    const from = tagPercent(local[i].tag);
    let best = 0;
    left.forEach((tag, j) => {
      if (Math.abs(tagPercent(tag) - from) < Math.abs(tagPercent(left[best]) - from)) best = j;
    });
    paired.set(i, left[best]);
    left.splice(best, 1);
  });
  return { paired, unmet: left };
};

// Names for the removals an apply makes from one local entry: the copies whose tag the server no longer holds leave first
export const removalNames = (refr: ObjectReference, form: Form, e: Entry, target: Entry[]): string[] => {
  if ((!config.enabled && !tagsWritten) || !isDurable(form)) return [];
  const copies = copiesOf(getRawEntries(refr).filter((raw) => raw.baseId === e.baseId && raw.count > 0));
  const left = tagsOf(target, e.baseId);
  const kept = copies.map((copy) => {
    const at = left.indexOf(copy.tag);
    if (at >= 0) left.splice(at, 1);
    return at >= 0;
  });
  return copies
    .map((copy, i) => ({ copy, kept: kept[i] }))
    .filter((x) => extrasEqual(x.copy.raw, e))
    .sort((a, b) => Number(a.kept) - Number(b.kept))
    .map((x) => localNameOf(x.copy.raw, form));
};

interface RenameOptions {
  // Bases the apply of this update still adds to or removes from
  skipBaseIds?: Set<number>;
  // False while a spawn's outfit settles, when a removed copy could be the one an equip is queued for
  reAdd?: boolean;
}

interface RenameCounts {
  renamed: number;
  reAdded: number;
  kept: number;
}

const renameCopies = (refr: ObjectReference, form: Form, raws: Entry[], copies: Copy[], paired: Map<number, string>, options: RenameOptions, counts: RenameCounts): void => {
  const rename = nativeRename();
  const done = new Set<Entry>();
  paired.forEach((tag, i) => {
    const raw = copies[i].raw;
    if (done.has(raw)) return;
    const from = raw.name || "";
    const toName = tag ? `${plainName(from || form.getName())} ${tag}` : plainName(from || form.getName());
    const stack: number[] = [];
    copies.forEach((copy, j) => { if (copy.raw === raw) stack.push(j); });
    const wholeList = stack.every((j) => paired.get(j) === tag);
    const twins = raws.filter((x) => (x.name || "") === from && !!x.worn === !!raw.worn && !!x.wornLeft === !!raw.wornLeft);
    // The copies of one extra list take one name together, and a twin list of the same name could take it instead
    if (rename && wholeList && twins.length === 1) {
      let ok = false;
      try {
        ok = rename(refr.getFormID(), raw.baseId, from, toName, !!raw.worn, !!raw.wornLeft) === true;
      } catch (err) {
        ok = false;
      }
      if (ok) {
        done.add(raw);
        counts.renamed += stack.length;
        tagsWritten = tagsWritten || !!tag;
        return;
      }
    }
    if (raw.worn || raw.wornLeft || options.reAdd === false) {
      counts.kept++;
      return;
    }
    addItemExOf(refr, form, raw, -1, localNameOf(raw, form));
    addItemExOf(refr, form, raw, 1, toName);
    counts.reAdded++;
    tagsWritten = tagsWritten || !!tag;
  });
};

// Brings the tags of the local copies in line with the server's conditions without touching what is worn
export const applyDurabilityNames = (refr: ObjectReference, serverInv: Inventory, options: RenameOptions = {}): void => {
  if (!config.enabled && !tagsWritten) return;
  const byBase = new Map<number, Entry[]>();
  getRawEntries(refr).forEach((raw) => {
    if (raw.count <= 0 || (options.skipBaseIds && options.skipBaseIds.has(raw.baseId))) return;
    const list = byBase.get(raw.baseId);
    if (list) list.push(raw);
    else if (isDurableBase(raw.baseId)) byBase.set(raw.baseId, [raw]);
  });

  const counts: RenameCounts = { renamed: 0, reAdded: 0, kept: 0 };
  byBase.forEach((raws, baseId) => {
    const form = Game.getFormEx(baseId);
    if (!form) return;
    const copies = copiesOf(raws);
    const wanted = serverInv.entries.filter((e) => e.baseId === baseId && e.count > 0);
    const paired = new Map<number, string>();
    const unmet: string[] = [];
    const grouped = new Set<number>();
    // Copies with other extras are other items, so a tag never crosses from the tempered sword to the plain one
    wanted.forEach((sample, at) => {
      if (wanted.findIndex((x) => sameItem(x, sample)) !== at) return;
      const indexes: number[] = [];
      copies.forEach((copy, i) => { if (!grouped.has(i) && sameItem(copy.raw, sample)) indexes.push(i); });
      indexes.forEach((i) => grouped.add(i));
      const result = pairTags(indexes.map((i) => copies[i]), tagsOf(wanted.filter((x) => sameItem(x, sample)), baseId));
      result.paired.forEach((tag, k) => paired.set(indexes[k], tag));
      result.unmet.forEach((tag) => unmet.push(tag));
    });
    // Local extras the server has not recorded yet leave a copy outside every group
    const rest: number[] = [];
    copies.forEach((_, i) => { if (!grouped.has(i)) rest.push(i); });
    pairTags(rest.map((i) => copies[i]), unmet).paired.forEach((tag, k) => paired.set(rest[k], tag));
    if (paired.size) renameCopies(refr, form, raws, copies, paired, options, counts);
  });

  if (counts.renamed || counts.reAdded) {
    logTrace("DurabilityNames", `condition tags: ${counts.renamed} renamed in place, ${counts.reAdded} put in again, ${counts.kept} left as they are`);
  }
  if (counts.kept && Date.now() - keptLoggedAt > KEPT_LOG_GAP_MS) {
    keptLoggedAt = Date.now();
    logToPlatformLog("DurabilityNames", `${counts.kept} worn or settling item(s) keep an old condition tag, in-place rename ${nativeRename() ? "refused" : "missing (setInventoryItemName)"}`);
  }
};

const taggedName = (name: string, tag: string): string => (tag ? `${plainName(name)} ${tag}` : plainName(name));

// The name a dropped copy goes to the server under, so the server drops the copy of that condition: read off the world reference, else the tag the pack lost
export const droppedName = (refr: ObjectReference, serverInv: Inventory | undefined, baseId: number, count: number, worldName: string): string | undefined => {
  const form = Game.getFormEx(baseId);
  if (!config.enabled || !form || !isDurable(form)) return undefined;
  const seen = splitTag(worldName);
  if (seen.tag) return `${seen.base} ${seen.tag}`;
  if (!serverInv) return undefined;
  const left = tagsOf(serverInv.entries, baseId);
  copiesOf(getRawEntries(refr).filter((raw) => raw.baseId === baseId && raw.count > 0)).forEach((copy) => {
    const at = left.indexOf(copy.tag);
    if (at >= 0) left.splice(at, 1);
  });
  return left.length === count && left.every((tag) => tag === left[0]) ? taggedName(form.getName(), left[0]) : undefined;
};

// The player's durable copies when the container window opened or after its last move
let seenCopies: Copy[] | undefined;

export const noteCopies = (refr: ObjectReference): void => {
  seenCopies = config.enabled ? copiesOf(getRawEntries(refr).filter((raw) => raw.count > 0 && isDurableBase(raw.baseId))) : undefined;
};

// The tagged names of the copies a container move took out of the pack (put) or brought in, one per copy; undefined when they do not add up
export const movedNames = (refr: ObjectReference, moved: Entry, put: boolean): string[] | undefined => {
  const form = Game.getFormEx(moved.baseId);
  if (!config.enabled || !seenCopies || !form || !isDurable(form)) return undefined;
  const same = (copy: Copy) => sameItem(copy.raw, moved);
  const now = copiesOf(getRawEntries(refr).filter((raw) => raw.baseId === moved.baseId && raw.count > 0)).filter(same);
  const before = seenCopies.filter(same);
  const names = (put ? before : now).map((copy) => taggedName(copy.raw.name || form.getName(), copy.tag));
  (put ? now : before).forEach((copy) => {
    const at = names.indexOf(taggedName(copy.raw.name || form.getName(), copy.tag));
    if (at >= 0) names.splice(at, 1);
  });
  return names.length === Math.abs(moved.count) ? names : undefined;
};
