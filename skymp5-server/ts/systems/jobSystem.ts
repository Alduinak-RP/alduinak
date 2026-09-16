import * as fs from "fs";
import * as chokidar from "chokidar";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content, USER_MENU_QUIT_EVENT } from "./system";
import { resolveEditorIds, isEditorId } from "./espmEditorIds";
import { espmFieldFormIds } from "./formIdUtil";
import { addItemTo, baseTypeOf, cleanDisplayName, formatWait, GOLD_BASE_ID, hex, holdsItem, isAlive, userOf } from "./actorUtil";
import { CaptureSystem, isRestrained } from "./captureSystem";
import { MasterySystem } from "./masterySystem";
import { pick, pickKey, num, parsePos, parseIdCount } from "./npcSpawnSystem";
import { ITEM_TYPES, descKey, itemNames } from "./itemCatalog";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Passive jobs from ./Jobs.json (server cwd): Activate on the offer at a pickup, carry the load to the dropoff, get paid; see docs/docs_roleplay_jobs.md.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "jobStart", job }  Activate on the offer
//                     { customPacketType: "jobPutDown" }  Put down in the player action menu
//   Server -> Client: { customPacketType: "jobPrompt", job, verb, label }  job "" withdraws the offer
//                     { customPacketType: "jobState", carrying, title }  title names the load and where it goes
//                     { customPacketType: "carryState", carrying, anim, target: 0 }  the pose, applied by RestraintService
//                     { customPacketType: "notification", text }
// Persistence: private.jobs = { trips: [epoch ms of each paid delivery] } on the character. The limit is rolling and shared by every job.
// Rewards: items added with the gold at delivery, one item of each entry picked at random.

const JOBS_FILE = "./Jobs.json";
const JOBS_PROP = "private.jobs";
const PROMPT_PACKET = "jobPrompt";
const STATE_PACKET = "jobState";
const CARRY_PACKET = "carryState";
const NOTICE_PACKET = "notification";

const POLL_MS = 1000;
const RELOAD_DEBOUNCE_MS = 500;
const MAX_NAME = 64;
const MAX_TEXT = 48;
const MAX_REQUIRES = 16;
const MAX_REWARDS = 8;
const MAX_REWARD_ITEMS = 64;
const MAX_REWARD_COUNT = 100;
const MAX_KEPT_TRIPS = 100;
const DEFAULT_ANIM = "OffsetCarryBasketStart";
const DEFAULT_RADIUS = 200;
const MIN_RADIUS = 50;
const MAX_RADIUS = 2000;
const MAX_PAY = 1000;
// The offer stays and a start is accepted this far past the radius, so lag at the edge does not flicker it
const EDGE_SLACK = 1.25;
// No delivery is paid sooner than this
const MIN_TRIP_MS = 10000;
// A carrier covering more than this per second between polls was moved, not walking
const MAX_STEP_PER_SECOND = 600;
// The client sheathes on pickup; the synced weapon state gets this long to follow
const WEAPON_GRACE_MS = 3000;
const DENY_NOTICE_MS = 1000;
const REFUSAL_LOG_MS = 5000;
const MOUNT_FF = "ff_mount";

const REQUIRE_SCAN_TYPES = ["FLST", "KYWD", "WEAP", "ARMO", "MISC"];

interface Globals {
  tripsPerWindow: number;
  windowMs: number;
  pay: number;
  maxTripMs: number;
  minDistance: number;
  maxSpeed: number;
}

const DEFAULT_GLOBALS: Globals = {
  tripsPerWindow: 10,
  windowMs: 12 * 3600000,
  pay: 10,
  maxTripMs: 15 * 60000,
  minDistance: 1000,
  maxSpeed: 150,
};

interface EndDraft {
  locator: string;
  pos: number[];
  radius: number;
  label: string;
}

// ids as written in the file: editor ids, load-order ids or descs
interface RewardDraft {
  ids: string[];
  count: number;
}

interface Draft {
  name: string;
  enabled: boolean;
  item: string;
  prompt: string;
  pay: number;
  anim: string;
  requires: string[];
  requiresText: string;
  rewards: RewardDraft[];
  pickup: EndDraft;
  dropoff: EndDraft;
}

interface End {
  desc: string;
  cellId: number;
  pos: number[];
  radius: number;
  label: string;
}

interface Reward {
  items: number[];
  // In-game names, the file's id where a record has none
  names: string[];
  count: number;
}

interface Job {
  draft: Draft;
  pickup: End;
  dropoff: End;
  tools: Set<number>;
  keywords: number[];
  rewards: Reward[];
}

// Editor ids resolved for the Requires and Rewards of enabled drafts
interface ResolvedIds {
  requires: Map<string, string>;
  rewards: Map<string, string>;
}

// Every named file entry; the ends resolve when the location does, the job only when it is enabled and valid
interface Entry {
  draft: Draft;
  status: string;
  pickup: End | null;
  dropoff: End | null;
}

interface Trip {
  job: Job;
  userId: number;
  startedAt: number;
  cellId: number;
  pos: number[];
  polledAt: number;
  crossed: boolean;
}

interface JobFile {
  list: unknown[];
  root: Record<string, unknown> | null;
  key: string;
  missing: boolean;
}

export interface JobEndSummary {
  id: string;
  pos: number[];
  radius: number;
  label: string;
}

export interface JobSummary {
  name: string;
  enabled: boolean;
  status: string;
  item: string;
  prompt: string;
  pay: number;
  anim: string;
  requires: string[];
  requiresText: string;
  pickup: JobEndSummary;
  dropoff: JobEndSummary;
  carrying: number;
}

type Reject = (msg: string) => void;

const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const article = (noun: string): string => (/^[aeiou]/i.test(noun) ? "an" : "a");

const capitalized = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const entryName = (raw: unknown): string => String(pick(raw, "name") ?? "").trim().toLowerCase();

const listOf = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : String(raw).split(",");
  return list.map((v) => String(v ?? "").trim()).filter(Boolean);
};

const joinedList = (parts: string[]): string => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts.join(""));

export class JobSystem implements System {
  systemName = "JobSystem";
  constructor(private log: Log, private capture: CaptureSystem, private mastery: MasterySystem) { }

  private ctx: SystemContext | null = null;
  private mp: Mp = null;
  private ready = false;
  private globals: Globals = { ...DEFAULT_GLOBALS };
  private entries: Entry[] = [];
  private jobs: Job[] = [];
  private loadChain: Promise<void> = Promise.resolve();
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  // Carrier actorId -> trip
  private trips = new Map<number, Trip>();
  // userId -> name of the job offered
  private offers = new Map<number, string>();
  // Carriers an allowed hit landed on, dropped at the next poll
  private struck = new Set<number>();
  private lastDenyMs = new Map<number, number>();
  private refusalLogAt = new Map<number, number>();
  // Reward item id -> in-game name, "" when the record has none; plugins only change with a restart
  private rewardNames = new Map<number, string>();

  async initAsync(ctx: SystemContext): Promise<void> {
    this.ctx = ctx;
    this.mp = ctx.svr as Mp;
    this.installHooks(this.mp);
    ctx.gm.on(USER_MENU_QUIT_EVENT, (userId: number) => this.dropUser(userId));
    ctx.gm.on("userAssignActor", (userId: number) => this.dropUser(userId));
    await this.queueLoad("boot");
    this.watchFile();
    this.ready = true;
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  // Outermost wrappers: the previous verdict comes first, so a hit refused by god mode or a capture block never drops a load
  private installHooks(mp: Mp): void {
    for (const event of ["onHitAttempt", "onHitDamageAttempt", "onSpellCastAttempt"]) {
      const previous = typeof mp[event] === "function" ? mp[event] : null;
      mp[event] = (actorId: number, ...rest: unknown[]): boolean => {
        if (!this.chain(mp, previous, [actorId, ...rest])) return false;
        if (this.trips.has(actorId >>> 0)) {
          this.logRefusal(actorId >>> 0, event);
          return false;
        }
        if (event === "onHitDamageAttempt" && this.trips.has(Number(rest[0]) >>> 0)) this.struck.add(Number(rest[0]) >>> 0);
        return true;
      };
    }
    // Refused before the inner handlers run, so no furniture session starts under a load
    const previousActivate = typeof mp.onActivate === "function" ? mp.onActivate : null;
    mp.onActivate = (targetId: number, casterId: number): boolean => {
      const trip = this.trips.get(casterId >>> 0);
      if (trip && baseTypeOf(mp, targetId >>> 0) === "FURN") {
        this.deny(trip.userId, `Put the ${trip.job.draft.item} down first.`);
        return false;
      }
      return this.chain(mp, previousActivate, [targetId, casterId]);
    };
  }

  private chain(mp: Mp, previous: ((...args: unknown[]) => unknown) | null, args: unknown[]): boolean {
    if (!previous) return true;
    try {
      return previous.apply(mp, args) !== false;
    } catch {
      return true;
    }
  }

  private logRefusal(actorId: number, what: string): void {
    const now = Date.now();
    if (now - (this.refusalLogAt.get(actorId) ?? 0) < REFUSAL_LOG_MS) return;
    this.refusalLogAt.set(actorId, now);
    this.log(`[jobs] refused ${what} by job carrier ${hex(actorId)}`);
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  private queueLoad(reason: string): Promise<void> {
    this.loadChain = this.loadChain
      .then(() => this.load(reason))
      .catch((e) => this.log(`[jobs] load failed (${reason}): ${e}`));
    return this.loadChain;
  }

  private async load(reason: string): Promise<void> {
    const file = this.readJobFile();
    if (typeof file === "string") {
      this.log(`[jobs] ${file}, keeping ${this.jobs.length} job(s)`);
      return;
    }
    if (file.missing) {
      this.log(`[jobs] ${JOBS_FILE} not found, no jobs (${reason})`);
      this.replace(DEFAULT_GLOBALS, []);
      return;
    }
    const globals = this.parseGlobals(file.root);
    const drafts: Array<{ draft: Draft; problem: string }> = [];
    const names = new Set<string>();
    for (const raw of file.list) {
      const problems: string[] = [];
      const draft = this.parseDraft(raw, globals, (msg) => problems.push(msg));
      if (!draft) {
        this.log(`[jobs] ${problems[0]}`);
        continue;
      }
      if (names.has(draft.name.toLowerCase())) {
        this.log(`[jobs] '${draft.name}' skipped, duplicate job name`);
        continue;
      }
      names.add(draft.name.toLowerCase());
      drafts.push({ draft, problem: problems[0] ?? "" });
    }
    const enabled = drafts.filter((d) => d.draft.enabled && !d.problem).map((d) => d.draft);
    const { locators, ids } = await this.resolveIds(drafts.map((d) => d.draft), enabled);
    const entries: Entry[] = [];
    const jobs: Job[] = [];
    for (const { draft, problem } of drafts) {
      const problems: string[] = problem ? [problem] : [];
      const reject: Reject = (msg) => problems.push(msg);
      const pickup = this.buildEnd(draft.pickup, "Pickup", locators, reject);
      const dropoff = this.buildEnd(draft.dropoff, "Dropoff", locators, reject);
      const job = pickup && dropoff && !problems.length ? this.buildJob(draft, pickup, dropoff, globals, draft.enabled ? ids : null, reject) : null;
      const status = [draft.enabled ? "" : "disabled", problems[0] ?? ""].filter(Boolean).join(", ");
      entries.push({ draft, status, pickup, dropoff });
      if (!draft.enabled) continue;
      if (job && !problems.length) jobs.push(job);
      else this.log(`[jobs] '${draft.name}' skipped, ${problems[0]}`);
    }
    await this.nameRewards(jobs);
    this.replace(globals, jobs, entries);
    const disabled = entries.filter((e) => !e.draft.enabled).map((e) => e.draft.name);
    this.log(`[jobs] ${jobs.length}/${file.list.length} job(s) active from ${JOBS_FILE} (${reason})${disabled.length ? `, disabled: ${disabled.join(", ")}` : ""}; ${globals.tripsPerWindow} trips per ${globals.windowMs / 3600000} h`);
  }

  // A missing file reads as an empty list; a string names what is wrong with an existing one
  private readJobFile(): JobFile | string {
    let text: string;
    try {
      text = fs.readFileSync(JOBS_FILE, "utf8");
    } catch (e: any) {
      if (e?.code === "ENOENT") return { list: [], root: null, key: "", missing: true };
      return `${JOBS_FILE} unreadable: ${e}`;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return `${JOBS_FILE} is not valid JSON: ${e}`;
    }
    if (Array.isArray(parsed)) return { list: parsed, root: null, key: "", missing: false };
    const key = pickKey(parsed, "jobs");
    const list = key === undefined ? undefined : (parsed as Record<string, unknown>)[key];
    if (key === undefined || !Array.isArray(list)) return `${JOBS_FILE} must be an array or { "Jobs": [...] }`;
    return { list, root: parsed as Record<string, unknown>, key, missing: false };
  }

  // Temp file plus rename so an interrupted write cannot truncate the list; a wrapper keeps its other keys
  private writeJobFile(file: JobFile, list: unknown[]): void {
    const tmp = JOBS_FILE + ".tmp";
    if (file.root) file.root[file.key] = list;
    const root = file.root ?? (file.missing ? { Jobs: list } : list);
    fs.writeFileSync(tmp, JSON.stringify(root, null, 2));
    fs.renameSync(tmp, JOBS_FILE);
  }

  private parseGlobals(root: Record<string, unknown> | null): Globals {
    const read = (key: string, fallback: number, min: number, max: number): number => {
      const raw = pick(root, key.toLowerCase());
      const value = num(raw, NaN);
      if (raw === undefined) return fallback;
      if (Number.isFinite(value) && value >= min && value <= max) return value;
      this.log(`[jobs] ${key} ${JSON.stringify(raw)} must be a number from ${min} to ${max}, using ${fallback}`);
      return fallback;
    };
    return {
      tripsPerWindow: Math.round(read("TripsPerWindow", DEFAULT_GLOBALS.tripsPerWindow, 1, MAX_KEPT_TRIPS)),
      windowMs: read("WindowHours", DEFAULT_GLOBALS.windowMs / 3600000, 0.01, 168) * 3600000,
      pay: Math.round(read("Pay", DEFAULT_GLOBALS.pay, 1, MAX_PAY)),
      maxTripMs: read("MaxTripMinutes", DEFAULT_GLOBALS.maxTripMs / 60000, 1, 120) * 60000,
      minDistance: read("MinDistance", DEFAULT_GLOBALS.minDistance, 0, 100000),
      maxSpeed: read("MaxSpeed", DEFAULT_GLOBALS.maxSpeed, 1, 10000),
    };
  }

  // Null only without a usable Name; every other problem is reported and the draft still lists
  private parseDraft(raw: unknown, globals: Globals, reject: Reject): Draft | null {
    const name = String(pick(raw, "name") ?? "").trim();
    if (!name) {
      reject("entry without a Name skipped");
      return null;
    }
    if (name.length > MAX_NAME) {
      reject(`'${name.slice(0, MAX_NAME)}...' skipped, Name longer than ${MAX_NAME} characters`);
      return null;
    }
    const enabledRaw = pick(raw, "enabled");
    const item = cleanDisplayName(pick(raw, "item"), MAX_TEXT) || "load";
    const payRaw = pick(raw, "pay");
    const pay = num(payRaw, globals.pay);
    if (!Number.isInteger(pay) || pay < 1 || pay > MAX_PAY) reject(`Pay must be a whole number from 1 to ${MAX_PAY}`);
    const anim = String(pick(raw, "carryanim") ?? "").trim() || DEFAULT_ANIM;
    if (!/^Offset[A-Za-z0-9_]+$/i.test(anim)) reject(`CarryAnim '${anim}' is not an Offset pose`);
    const requires = listOf(pick(raw, "requires"));
    if (requires.length > MAX_REQUIRES) reject(`more than ${MAX_REQUIRES} Requires entries`);
    const rewards = this.parseRewards(pick(raw, "rewards"), reject);
    return {
      name,
      enabled: enabledRaw !== false && String(enabledRaw).toLowerCase() !== "false",
      item,
      prompt: cleanDisplayName(pick(raw, "prompt"), MAX_TEXT) || `Carry ${item}`,
      pay,
      anim,
      requires,
      requiresText: cleanDisplayName(pick(raw, "requirestext"), MAX_TEXT) || "the right tool",
      rewards,
      pickup: this.parseEnd(pick(raw, "pickup"), "the pickup"),
      dropoff: this.parseEnd(pick(raw, "dropoff"), "the dropoff"),
    };
  }

  // Entries are "id count", { ID, Count } or { OneOf: [ids], Count }
  private parseRewards(raw: unknown, reject: Reject): RewardDraft[] {
    const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    if (list.length > MAX_REWARDS) reject(`more than ${MAX_REWARDS} Rewards entries`);
    const rewards: RewardDraft[] = [];
    for (const entry of list) {
      const oneOf = pick(entry, "oneof");
      const single = oneOf === undefined ? parseIdCount(entry) : null;
      const ids = single ? [single.id] : listOf(oneOf);
      const count = single ? single.count : num(pick(entry, "count"), 1);
      if (!ids.length || ids.length > MAX_REWARD_ITEMS || !Number.isInteger(count) || count < 1 || count > MAX_REWARD_COUNT) {
        reject(`Rewards entry ${JSON.stringify(entry)} needs 1 to ${MAX_REWARD_ITEMS} items and a whole Count from 1 to ${MAX_REWARD_COUNT}`);
        continue;
      }
      rewards.push({ ids, count });
    }
    return rewards;
  }

  private parseEnd(raw: unknown, label: string): EndDraft {
    return {
      locator: String(pick(raw, "id") ?? "").trim(),
      pos: parsePos(pick(raw, "pos")) ?? [],
      radius: Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, num(pick(raw, "radius"), DEFAULT_RADIUS))),
      label: cleanDisplayName(pick(raw, "label"), MAX_TEXT) || label,
    };
  }

  // Locations resolve for every entry so a disabled job can still be visited; Requires and Rewards only for the given drafts
  private async resolveIds(all: Draft[], withRequires: Draft[]): Promise<{ locators: Map<string, string>; ids: ResolvedIds }> {
    const s = await Settings.get();
    const locatorIds = all.flatMap((d) => [d.pickup.locator, d.dropoff.locator]).filter((l) => l && isEditorId(l));
    const requireIds = withRequires.flatMap((d) => d.requires).filter(isEditorId);
    const rewardIds = withRequires.flatMap((d) => d.rewards.flatMap((r) => r.ids)).filter(isEditorId);
    const locators = await resolveEditorIds(Array.from(new Set(locatorIds)), s.dataDir, s.loadOrder, this.log);
    const requires = await resolveEditorIds(Array.from(new Set(requireIds)), s.dataDir, s.loadOrder, this.log, REQUIRE_SCAN_TYPES);
    const rewards = await resolveEditorIds(Array.from(new Set(rewardIds)), s.dataDir, s.loadOrder, this.log, ITEM_TYPES);
    return { locators: locators.resolved, ids: { requires: requires.resolved, rewards: rewards.resolved } };
  }

  private recordType(id: number): string {
    try {
      return String((id ? this.mp.lookupEspmRecordById(id) : null)?.record?.type ?? "");
    } catch {
      return "";
    }
  }

  // "3c:Skyrim.esm" desc, "0x0000003C" load-order id or an editor id already resolved; 0 when unknown
  private formIdOf(text: string, editorIds: Map<string, string>): number {
    try {
      if (text.includes(":")) return this.mp.getIdFromDesc(text) >>> 0;
      if (!isEditorId(text)) return parseInt(text, 16) >>> 0;
      const desc = editorIds.get(text.toLowerCase());
      return desc ? this.mp.getIdFromDesc(desc) >>> 0 : 0;
    } catch {
      return 0;
    }
  }

  private buildEnd(end: EndDraft, which: string, locators: Map<string, string>, reject: Reject): End | null {
    if (!end.locator || end.pos.length !== 3) {
      reject(`${which} needs ID and POS {x,y,z}`);
      return null;
    }
    let desc = "";
    const cellId = this.formIdOf(end.locator, locators);
    try {
      if (cellId) desc = this.mp.getDescFromId(cellId);
    } catch {
      desc = "";
    }
    if (!desc) {
      reject(`${which} ID '${end.locator}' is not a known cell or worldspace`);
      return null;
    }
    return { desc, cellId, pos: end.pos, radius: end.radius, label: end.label };
  }

  // Ids null skips the tools and rewards (a disabled entry); any entry that does not resolve refuses the job, so it fails closed
  private buildJob(draft: Draft, pickup: End, dropoff: End, globals: Globals, ids: ResolvedIds | null, reject: Reject): Job | null {
    if (pickup.cellId === dropoff.cellId && distance(pickup.pos, dropoff.pos) < globals.minDistance) {
      reject(`pickup and dropoff are ${Math.round(distance(pickup.pos, dropoff.pos))} units apart, MinDistance is ${globals.minDistance}`);
      return null;
    }
    const tools = new Set<number>();
    const keywords: number[] = [];
    for (const req of ids ? draft.requires : []) {
      const id = this.formIdOf(req, ids!.requires);
      const type = this.recordType(id);
      if (type === "FLST") {
        const listed = espmFieldFormIds(this.mp.lookupEspmRecordById(id), "LNAM");
        if (!listed.length) {
          reject(`Requires '${req}' lists no items`);
          return null;
        }
        listed.forEach((t) => tools.add(t));
      } else if (type === "KYWD") {
        keywords.push(id);
      } else if (ITEM_TYPES.includes(type)) {
        tools.add(id);
      } else {
        reject(type ? `Requires '${req}' is a ${type}, not an item, form list or keyword` : `Requires '${req}' is not in the load order`);
        return null;
      }
    }
    const rewards: Reward[] = [];
    for (const reward of ids ? draft.rewards : []) {
      const items = reward.ids.map((text) => this.formIdOf(text, ids!.rewards));
      const bad = items.findIndex((id) => !ITEM_TYPES.includes(this.recordType(id)));
      if (bad >= 0) {
        const type = this.recordType(items[bad]);
        reject(type ? `Rewards '${reward.ids[bad]}' is a ${type}, not an item` : `Rewards '${reward.ids[bad]}' is not in the load order`);
        return null;
      }
      rewards.push({ items, names: [...reward.ids], count: reward.count });
    }
    return { draft, pickup, dropoff, tools, keywords, rewards };
  }

  // One scan of the reward records' types names every item not named before
  private async nameRewards(jobs: Job[]): Promise<void> {
    const rewards = jobs.flatMap((j) => j.rewards);
    const descs = new Map<number, string>();
    for (const id of rewards.flatMap((r) => r.items)) {
      if (this.rewardNames.has(id) || descs.has(id)) continue;
      try {
        descs.set(id, this.mp.getDescFromId(id));
      } catch {
        this.rewardNames.set(id, "");
      }
    }
    if (descs.size) {
      const s = await Settings.get();
      const types = Array.from(new Set(Array.from(descs.keys()).map((id) => this.recordType(id))));
      try {
        const names = await itemNames(Array.from(descs.values()), types, s.dataDir, s.loadOrder, this.log);
        for (const [id, desc] of descs) this.rewardNames.set(id, names.get(descKey(desc)) ?? "");
      } catch (e) {
        this.log(`[jobs] reward item names unreadable, the file's ids stand in: ${e}`);
      }
    }
    for (const reward of rewards) reward.names = reward.items.map((id, i) => this.rewardNames.get(id) || reward.names[i]);
  }

  // Trips of a job that is gone or was edited end; every offer is withdrawn and the next poll makes it again
  private replace(globals: Globals, jobs: Job[], entries: Entry[] = []): void {
    this.globals = globals;
    const signature = (j: Job) => JSON.stringify([j.draft, j.pickup, j.dropoff, Array.from(j.tools), j.keywords, j.rewards]);
    const next = new Map(jobs.map((j) => [j.draft.name.toLowerCase(), j]));
    for (const [actorId, trip] of Array.from(this.trips)) {
      const same = next.get(trip.job.draft.name.toLowerCase());
      if (same && signature(same) === signature(trip.job)) trip.job = same;
      else this.endTrip(actorId, "The work here has changed.");
    }
    for (const userId of Array.from(this.offers.keys())) this.setOffer(userId, null);
    this.jobs = jobs;
    this.entries = entries;
  }

  private watchFile(): void {
    const watcher = chokidar.watch(JOBS_FILE, { persistent: true, ignoreInitial: true, awaitWriteFinish: true });
    const schedule = () => this.scheduleReload();
    watcher.on("add", schedule);
    watcher.on("change", schedule);
    watcher.on("unlink", schedule);
    watcher.on("error", (e: unknown) => this.log(`[jobs] watch error: ${e}`));
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.queueLoad("file changed");
    }, RELOAD_DEBOUNCE_MS);
  }

  // ── Players ────────────────────────────────────────────────────────────────

  customPacket(userId: number, type: string, content: Content): void {
    if (type === "jobStart") this.onStart(userId, String(content["job"] ?? ""));
    else if (type === "jobPutDown") this.onPutDown(userId);
  }

  disconnect(userId: number): void {
    this.offers.delete(userId);
    this.lastDenyMs.delete(userId);
    for (const [actorId, trip] of Array.from(this.trips)) {
      if (trip.userId !== userId) continue;
      this.trips.delete(actorId);
      this.log(`[jobs] ${hex(actorId)} disconnected carrying ${trip.job.draft.name}`);
    }
  }

  // Character select keeps the connection, so the client is told to drop the pose before the next character loads
  private dropUser(userId: number): void {
    for (const [actorId, trip] of Array.from(this.trips)) {
      if (trip.userId === userId) this.endTrip(actorId, "");
    }
    this.setOffer(userId, null);
  }

  private onStart(userId: number, name: string): void {
    const mp = this.mp;
    const actorId = this.actorOf(userId);
    const job = this.findJob(name);
    if (!this.ready || !actorId || !job || this.trips.has(actorId) || !isAlive(mp, actorId)) return;
    const item = job.draft.item;
    let cellId = 0;
    let pos: number[] = [];
    try {
      cellId = mp.getActorCellOrWorld(actorId);
      pos = mp.getActorPos(actorId);
    } catch {
      return;
    }
    if (!this.inside(cellId, pos, job.pickup, EDGE_SLACK)) return this.deny(userId, `Stand at ${job.pickup.label} to take this work.`);
    const now = Date.now();
    const recent = this.recentTrips(actorId, now);
    if (recent.length >= this.globals.tripsPerWindow) return this.deny(userId, this.limitText(recent, now));
    if (!this.holdsRequirement(actorId, job)) return this.deny(userId, `You need ${job.draft.requiresText} for this work.`);
    if (isRestrained(mp, actorId) || this.capture.carriedOf(actorId)) return this.deny(userId, "Your hands are full.");
    if (this.isMounted(actorId)) return this.deny(userId, `Dismount to pick up the ${item}.`);
    if (this.isWeaponDrawn(actorId)) return this.deny(userId, `Put your weapon away to pick up the ${item}.`);
    this.trips.set(actorId, { job, userId, startedAt: now, cellId, pos, polledAt: now, crossed: false });
    this.setOffer(userId, null);
    this.send(userId, { customPacketType: CARRY_PACKET, carrying: true, anim: job.draft.anim, target: 0 });
    this.send(userId, { customPacketType: STATE_PACKET, carrying: true, title: `${capitalized(item)} for ${job.dropoff.label}` });
    this.notice(userId, `You pick up ${article(item)} ${item}. Carry it to ${job.dropoff.label}.`);
    this.log(`[jobs] ${this.actorLabel(actorId)} picked up ${job.draft.name}, ${recent.length}/${this.globals.tripsPerWindow} trips made`);
  }

  private onPutDown(userId: number): void {
    const actorId = this.actorOf(userId);
    const trip = this.trips.get(actorId);
    if (trip) this.endTrip(actorId, `You put the ${trip.job.draft.item} down.`);
  }

  // The job carrier's load for CaptureSystem, "" when not on a trip
  loadOf(actorId: number): string {
    return this.trips.get(actorId >>> 0)?.job.draft.item ?? "";
  }

  // ── Poll ───────────────────────────────────────────────────────────────────

  async updateAsync(): Promise<void> {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!this.ready) return;
    const now = Date.now();
    for (const actorId of Array.from(this.struck)) {
      const trip = this.trips.get(actorId);
      if (trip) this.endTrip(actorId, `You dropped the ${trip.job.draft.item} in the fight.`);
    }
    this.struck.clear();
    for (const [actorId, trip] of Array.from(this.trips)) {
      try {
        this.checkTrip(actorId, trip, now);
      } catch (e) {
        this.log(`[jobs] trip check failed for ${hex(actorId)}: ${e}`);
        this.endTrip(actorId, "");
      }
    }
    this.updateOffers();
  }

  private checkTrip(actorId: number, trip: Trip, now: number): void {
    const mp = this.mp;
    const item = trip.job.draft.item;
    if (userOf(mp, actorId) !== trip.userId) return this.endTrip(actorId, "");
    // CaptureSystem posed the carrier meanwhile, so its pose must not be cleared
    if (this.capture.carriedOf(actorId)) return this.endTrip(actorId, "", false);
    if (!isAlive(mp, actorId) || isRestrained(mp, actorId)) return this.endTrip(actorId, `You dropped the ${item}.`);
    if (this.isMounted(actorId)) return this.endTrip(actorId, `You dropped the ${item} to mount.`);
    if (now - trip.startedAt > this.globals.maxTripMs) return this.endTrip(actorId, `You took too long and dropped the ${item}.`);
    if (now - trip.startedAt > WEAPON_GRACE_MS && this.isWeaponDrawn(actorId)) return this.endTrip(actorId, `You dropped the ${item} to draw your weapon.`);
    const cellId = mp.getActorCellOrWorld(actorId);
    const pos: number[] = mp.getActorPos(actorId);
    const { pickup, dropoff } = trip.job;
    if (cellId !== trip.cellId) {
      // One load door is allowed, into the dropoff's own cell or worldspace
      if (trip.crossed || cellId !== dropoff.cellId || dropoff.cellId === pickup.cellId) return this.endTrip(actorId, `You dropped the ${item}.`);
      trip.crossed = true;
    } else if (distance(pos, trip.pos) > MAX_STEP_PER_SECOND * Math.max(1, (now - trip.polledAt) / 1000)) {
      return this.endTrip(actorId, `You dropped the ${item}.`);
    }
    trip.cellId = cellId;
    trip.pos = pos;
    trip.polledAt = now;
    if (this.inside(cellId, pos, dropoff, 1)) this.deliver(actorId, trip, now);
  }

  private deliver(actorId: number, trip: Trip, now: number): void {
    const { draft, pickup, dropoff } = trip.job;
    // The walk counts from the edge of the pickup offer to the edge of the dropoff
    const straight = pickup.cellId === dropoff.cellId ? distance(pickup.pos, dropoff.pos) - pickup.radius * EDGE_SLACK - dropoff.radius : 0;
    const minMs = Math.max(MIN_TRIP_MS, (straight / this.globals.maxSpeed) * 1000);
    const elapsed = now - trip.startedAt;
    const who = this.actorLabel(actorId);
    if (elapsed < minMs) {
      this.log(`[jobs] ${who} delivered ${draft.name} in ${Math.round(elapsed / 1000)} s, under the ${Math.round(minMs / 1000)} s minimum, not paid`);
      return this.endTrip(actorId, "That was too quick; nobody pays for that.");
    }
    const limit = this.globals.tripsPerWindow;
    const recent = this.recentTrips(actorId, now);
    if (recent.length >= limit) return this.endTrip(actorId, this.limitText(recent, now));
    try {
      addItemTo(this.mp, actorId, GOLD_BASE_ID, draft.pay, true);
    } catch (e) {
      this.log(`[jobs] paying ${who} for ${draft.name} failed: ${e}`);
      return this.endTrip(actorId, "Nobody could pay you just now.");
    }
    const paid = [`${draft.pay} gold`, ...this.grantRewards(actorId, trip.job, who)];
    recent.push(now);
    try {
      this.mp.set(actorId, JOBS_PROP, { trips: recent.slice(-MAX_KEPT_TRIPS) });
    } catch (e) {
      this.log(`[jobs] recording the trip of ${who} failed: ${e}`);
    }
    const left = limit - recent.length;
    const earned = `You deliver the ${draft.item} and earn ${joinedList(paid)}.`;
    this.endTrip(actorId, left > 0
      ? `${earned} ${left} of ${limit} trips left.`
      : `${earned} That was your last trip; there is more work in ${formatWait(this.nextFreeAt(recent) - now)}.`);
    this.log(`[jobs] ${who} delivered ${draft.name}, +${paid.join(", +")}, ${recent.length}/${limit}`);
  }

  // A reward that fails is logged and left out of the notice; the gold stands
  private grantRewards(actorId: number, job: Job, who: string): string[] {
    const granted: string[] = [];
    for (const reward of job.rewards) {
      const i = Math.floor(Math.random() * reward.items.length);
      try {
        addItemTo(this.mp, actorId, reward.items[i], reward.count, true);
        granted.push(`${reward.count} ${reward.names[i]}`);
      } catch (e) {
        this.log(`[jobs] reward ${reward.names[i]} for ${who} (${job.draft.name}) failed: ${e}`);
      }
    }
    return granted;
  }

  // Ends a trip without pay; the pose is dropped unless CaptureSystem owns it
  private endTrip(actorId: number, text: string, dropPose = true): void {
    const trip = this.trips.get(actorId);
    if (!trip) return;
    this.trips.delete(actorId);
    if (!this.connected(trip.userId)) return;
    if (dropPose) this.send(trip.userId, { customPacketType: CARRY_PACKET, carrying: false, target: 0 });
    this.send(trip.userId, { customPacketType: STATE_PACKET, carrying: false, title: "" });
    if (text) this.notice(trip.userId, text);
  }

  // A player standing at a pickup is offered its job; the offer holds to the slack edge
  private updateOffers(): void {
    const mp = this.mp;
    let players: number[] = [];
    try { players = mp.get(0, "onlinePlayers") ?? []; } catch { return; }
    const seen = new Set<number>();
    for (const actorId of players) {
      const userId = userOf(mp, actorId);
      if (userId < 0) continue;
      seen.add(userId);
      const offered = this.findJob(this.offers.get(userId) ?? "");
      let next: Job | undefined;
      if (this.jobs.length && !this.trips.has(actorId) && isAlive(mp, actorId)) {
        try {
          const cellId = mp.getActorCellOrWorld(actorId);
          const pos = mp.getActorPos(actorId);
          next = offered && this.inside(cellId, pos, offered.pickup, EDGE_SLACK) ? offered : this.jobs.find((j) => this.inside(cellId, pos, j.pickup, 1));
        } catch {
          next = undefined;
        }
      }
      if (next !== offered) this.setOffer(userId, next ?? null);
    }
    for (const userId of Array.from(this.offers.keys())) {
      if (!seen.has(userId)) this.offers.delete(userId);
    }
  }

  private setOffer(userId: number, job: Job | null): void {
    if (job) {
      this.offers.set(userId, job.draft.name);
      this.send(userId, { customPacketType: PROMPT_PACKET, job: job.draft.name, verb: job.draft.prompt, label: `${job.draft.pay} gold` });
      return;
    }
    if (!this.offers.delete(userId)) return;
    this.send(userId, { customPacketType: PROMPT_PACKET, job: "", verb: "", label: "" });
  }

  // ── Rules ──────────────────────────────────────────────────────────────────

  private inside(cellId: number, pos: number[], end: End, slack: number): boolean {
    return cellId === end.cellId && Array.isArray(pos) && distance(pos, end.pos) <= end.radius * slack;
  }

  // Paid deliveries inside the rolling window, oldest first; the server clock counts time offline
  private recentTrips(actorId: number, now: number): number[] {
    let raw: any = null;
    try { raw = this.mp.get(actorId, JOBS_PROP); } catch { raw = null; }
    const list: unknown[] = raw && Array.isArray(raw.trips) ? raw.trips : [];
    return list.map(Number).filter((t) => Number.isFinite(t) && t > now - this.globals.windowMs).sort((a, b) => a - b);
  }

  private nextFreeAt(recent: number[]): number {
    return recent[Math.max(0, recent.length - this.globals.tripsPerWindow)] + this.globals.windowMs;
  }

  private limitText(recent: number[], now: number): string {
    return `You have made ${this.globals.tripsPerWindow} trips. There is more work in ${formatWait(this.nextFreeAt(recent) - now)}.`;
  }

  private holdsRequirement(actorId: number, job: Job): boolean {
    if (!job.tools.size && !job.keywords.length) return true;
    return holdsItem(this.mp, actorId, (baseId) =>
      job.tools.has(baseId) || job.keywords.some((k) => this.mastery.baseHasKeyword(this.ctx!, baseId, k)));
  }

  private isMounted(actorId: number): boolean {
    try {
      return !!this.mp.get(actorId, MOUNT_FF);
    } catch {
      return false;
    }
  }

  // Read from the client-synced animation variable, like the position
  private isWeaponDrawn(actorId: number): boolean {
    try {
      const self = { type: "form", desc: this.mp.getDescFromId(actorId) };
      return this.mp.callPapyrusFunction("method", "Actor", "IsWeaponDrawn", self, []) === true;
    } catch {
      return false;
    }
  }

  private findJob(name: string): Job | undefined {
    const key = name.trim().toLowerCase();
    return key ? this.jobs.find((j) => j.draft.name.toLowerCase() === key) : undefined;
  }

  // ── Packets ────────────────────────────────────────────────────────────────

  // A held Activate repeats, so refusals are throttled per user
  private deny(userId: number, text: string): void {
    const now = Date.now();
    if (now - (this.lastDenyMs.get(userId) ?? 0) < DENY_NOTICE_MS) return;
    this.lastDenyMs.set(userId, now);
    this.notice(userId, text);
  }

  private notice(userId: number, text: string): void {
    this.send(userId, { customPacketType: NOTICE_PACKET, text });
  }

  private send(userId: number, payload: Record<string, unknown>): void {
    if (userId < 0) return;
    try { this.mp.sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
  }

  private connected(userId: number): boolean {
    try { return userId >= 0 && !!this.mp.isConnected(userId); } catch { return false; }
  }

  private actorOf(userId: number): number {
    try { return this.mp.getUserActor(userId) >>> 0; } catch { return 0; }
  }

  private actorLabel(actorId: number): string {
    let name = "";
    try { name = String(this.mp.getActorName(actorId) ?? ""); } catch { name = ""; }
    return `${name || hex(actorId)} (${hex(actorId)})`;
  }

  // ── Admin panel API ────────────────────────────────────────────────────────

  listJobs(): JobSummary[] {
    const carrying = (name: string) => Array.from(this.trips.values()).filter((t) => t.job.draft.name === name).length;
    const end = (d: EndDraft): JobEndSummary => ({ id: d.locator, pos: d.pos, radius: d.radius, label: d.label });
    return this.entries.map(({ draft, status }) => ({
      name: draft.name,
      enabled: draft.enabled,
      status,
      item: draft.item,
      prompt: draft.prompt,
      pay: draft.pay,
      anim: draft.anim,
      requires: draft.requires,
      requiresText: draft.requiresText,
      pickup: end(draft.pickup),
      dropoff: end(draft.dropoff),
      carrying: carrying(draft.name),
    }));
  }

  // Validates like a file entry, Requires and Rewards only when enabled, then replaces the entry of that name or appends it; error null on success
  async saveJob(raw: unknown): Promise<{ error: string | null; name: string; replaced: boolean }> {
    const problems: string[] = [];
    const reject: Reject = (msg) => problems.push(msg);
    const draft = this.parseDraft(this.withKeptRewards(raw), this.globals, reject);
    if (!draft || problems.length) return { error: problems[0], name: "", replaced: false };
    const { locators, ids } = await this.resolveIds([draft], draft.enabled ? [draft] : []);
    const pickup = this.buildEnd(draft.pickup, "Pickup", locators, reject);
    const dropoff = this.buildEnd(draft.dropoff, "Dropoff", locators, reject);
    if (pickup && dropoff) this.buildJob(draft, pickup, dropoff, this.globals, draft.enabled ? ids : null, reject);
    if (problems.length) return { error: problems[0], name: draft.name, replaced: false };
    const file = this.readJobFile();
    if (typeof file === "string") return { error: file, name: draft.name, replaced: false };
    const entry = {
      Name: draft.name,
      Enabled: draft.enabled,
      Item: draft.item,
      Prompt: draft.prompt,
      Pay: draft.pay,
      CarryAnim: draft.anim,
      Requires: draft.requires,
      RequiresText: draft.requires.length ? draft.requiresText : undefined,
      Rewards: draft.rewards.length ? draft.rewards.map((r) => (r.ids.length === 1 ? { ID: r.ids[0], Count: r.count } : { OneOf: r.ids, Count: r.count })) : undefined,
      Pickup: this.endEntry(draft.pickup),
      Dropoff: this.endEntry(draft.dropoff),
    };
    const at = file.list.findIndex((e) => entryName(e) === draft.name.toLowerCase());
    if (at >= 0) file.list[at] = entry;
    else file.list.push(entry);
    try {
      this.writeJobFile(file, file.list);
    } catch (e) {
      this.log(`[jobs] ${JOBS_FILE} write failed: ${e}`);
      return { error: `${JOBS_FILE} write failed, see server log`, name: draft.name, replaced: false };
    }
    this.log(`[jobs] '${draft.name}' ${at >= 0 ? "replaced in" : "appended to"} ${JOBS_FILE} by admin`);
    await this.queueLoad("admin save");
    return { error: null, name: draft.name, replaced: at >= 0 };
  }

  // The panel form has no Rewards field, so a save without one keeps the Rewards of the entry it replaces
  private withKeptRewards(raw: unknown): unknown {
    const file = this.readJobFile();
    if (typeof file === "string" || !raw || typeof raw !== "object" || pickKey(raw, "rewards") !== undefined) return raw;
    const kept = pick(file.list.find((e) => entryName(e) === entryName(raw)), "rewards");
    return kept === undefined ? raw : { ...(raw as Record<string, unknown>), Rewards: kept };
  }

  private endEntry(end: EndDraft): Record<string, unknown> {
    return { ID: end.locator, POS: { x: end.pos[0], y: end.pos[1], z: end.pos[2] }, Radius: end.radius, Label: end.label };
  }

  // Rewrites the file without the entry; the reload that follows ends its trips
  async deleteJob(name: string): Promise<boolean> {
    const file = this.readJobFile();
    if (typeof file === "string") {
      this.log(`[jobs] ${file}, delete refused`);
      return false;
    }
    const key = name.trim().toLowerCase();
    const kept = file.list.filter((e) => entryName(e) !== key);
    if (!key || kept.length === file.list.length) return false;
    try {
      this.writeJobFile(file, kept);
    } catch (e) {
      this.log(`[jobs] ${JOBS_FILE} write failed: ${e}`);
      return false;
    }
    this.log(`[jobs] '${name}' removed from ${JOBS_FILE} by admin`);
    await this.queueLoad("admin delete");
    return true;
  }

  teleportTarget(name: string, which: "pickup" | "dropoff"): { cellOrWorldDesc: string; pos: number[] } | null {
    const key = name.trim().toLowerCase();
    const entry = this.entries.find((e) => e.draft.name.toLowerCase() === key);
    const end = entry ? entry[which] : null;
    return end ? { cellOrWorldDesc: end.desc, pos: end.pos } : null;
  }
}
