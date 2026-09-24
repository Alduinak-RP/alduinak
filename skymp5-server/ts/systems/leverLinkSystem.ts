import { Settings } from "../settings";
import { System, Log, SystemContext } from "./system";
import { formIdFromConfig } from "./formIdUtil";
import { baseTypeOf, chainMpHook, hex, userOf } from "./actorUtil";
import { describeActor } from "./playerText";

type Mp = any;

// A listed lever opens or closes its target, for plugin wiring through markers the server never loads; overridable via "leverLinks"
// Soljund's Sinkhole: soljundLever 5ebe3 and 5ebe4 run soljundMasterScript, which opens portcullis 5ebc0 through XMarkers once both are pulled
const DEFAULT_LINKS: Record<string, unknown>[] = [
  { levers: ["5ebe3:Skyrim.esm", "5ebe4:Skyrim.esm"], target: "5ebc0:Skyrim.esm", all: true },
];

// default2StateActivator's animations, used for a target that is not a door
const OPEN_ANIM = "open";
const CLOSE_ANIM = "close";

// A held activate key repeats, and the target's swing takes about this long
const TOGGLE_COOLDOWN_MS = 3000;

const PULLED_PROP = "private.leverPulled";
const OPEN_PROP = "private.leverLinkOpen";

interface LeverLink {
  levers: number[];
  target: number;
  all: boolean;
  openAnim: string;
  closeAnim: string;
}

export class LeverLinkSystem implements System {
  systemName = "LeverLinkSystem";

  constructor(private log: Log) { }

  private linkByLever = new Map<number, LeverLink>();
  private lastToggleMs = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as Mp;
    const raw = ((await Settings.get()).allSettings as Record<string, unknown> | null)?.["leverLinks"];
    const entries = Array.isArray(raw) ? raw : DEFAULT_LINKS;
    for (const entry of entries as Record<string, unknown>[]) this.add(mp, entry);
    if (this.linkByLever.size === 0) return;
    chainMpHook(mp, "onActivate", (targetId: number, casterId: number) => {
      const link = this.linkByLever.get(targetId >>> 0);
      if (link) this.onPull(mp, link, targetId >>> 0, casterId >>> 0);
      return true;
    });
    this.log(`LeverLinkSystem: ${this.linkByLever.size} lever(s) linked`);
  }

  // An entry naming a lever or a target the load order has no form for is skipped and logged
  private add(mp: Mp, entry: Record<string, unknown>): void {
    const levers = Array.isArray(entry?.["levers"]) ? (entry["levers"] as unknown[]).map((v) => formIdFromConfig(mp, v)) : [];
    const target = formIdFromConfig(mp, entry?.["target"]);
    if (!target || levers.length === 0 || levers.includes(0)) {
      this.log(`LeverLinkSystem: skipped ${JSON.stringify(entry)}, needs levers and a target the load order has`);
      return;
    }
    const link: LeverLink = {
      levers,
      target,
      all: entry["all"] === true,
      openAnim: typeof entry["openAnim"] === "string" ? entry["openAnim"] : OPEN_ANIM,
      closeAnim: typeof entry["closeAnim"] === "string" ? entry["closeAnim"] : CLOSE_ANIM,
    };
    for (const lever of levers) this.linkByLever.set(lever, link);
  }

  private onPull(mp: Mp, link: LeverLink, leverId: number, casterId: number): void {
    if (userOf(mp, casterId) < 0) return;
    if (link.all) {
      mp.set(leverId, PULLED_PROP, true);
      const pulled = link.levers.filter((id) => this.isPulled(mp, id)).length;
      if (pulled < link.levers.length) {
        this.log(`[levers] ${describeActor(mp, casterId)} pulled ${hex(leverId)}, ${pulled} of ${link.levers.length} pulled`);
        return;
      }
    }
    const now = Date.now();
    if (now - (this.lastToggleMs.get(link.target) || 0) < TOGGLE_COOLDOWN_MS) return;
    this.lastToggleMs.set(link.target, now);
    const open = this.toggle(mp, link);
    this.log(`[levers] ${describeActor(mp, casterId)} pulled ${hex(leverId)}, ${hex(link.target)} ${open ? "opens" : "closes"}`);
  }

  private isPulled(mp: Mp, leverId: number): boolean {
    try { return mp.get(leverId, PULLED_PROP) === true; } catch { return false; }
  }

  // A door keeps its native isOpen; anything else plays its animation, which the server keeps for later arrivals
  private toggle(mp: Mp, link: LeverLink): boolean {
    if (baseTypeOf(mp, link.target) === "DOOR") {
      const open = mp.get(link.target, "isOpen") !== true;
      mp.set(link.target, "isOpen", open);
      return open;
    }
    const open = mp.get(link.target, OPEN_PROP) !== true;
    mp.set(link.target, OPEN_PROP, open);
    const self = { type: "form", desc: mp.getDescFromId(link.target) };
    mp.callPapyrusFunction("method", "ObjectReference", "PlayAnimation", self, [open ? link.openAnim : link.closeAnim]);
    return open;
  }
}
