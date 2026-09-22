import { Cell, CellAttachDetachEvent, CellFullyLoadedEvent, Form, FormType, MotionType, ObjectLoadedEvent, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { logError, logTrace } from "../../logging";

// World clutter is frozen as its cell or 3D loads so local havok cannot move it
const FROZEN_TYPES = [FormType.MovableStatic, FormType.Flora, FormType.Activator, FormType.Furniture, FormType.Static, FormType.Container, ...FormTypeEx.itemTypes];

// Mods place havok item meshes as statics and containers, so those are frozen unless the model sits in a folder that never carries havok
const NON_HAVOK_MODEL = /^(meshes[\\/])?(architecture|landscape|dungeons|lod|terrain|markers?|effects)[\\/]|^marker/i;

const SWEEP_MS = 200;
// Refs looked at per sweep tick, pending retries included
const SWEEP_BUDGET = 128;
// Part of the budget the pending retries may take, so the cell sweep always keeps the rest
const PENDING_BUDGET = 32;
const TRACKED_LIMIT = 8192;
// A ref frozen as it loaded is frozen once more after the havok body had a physics step to attach
const SECOND_PASS_MS = 1000;
// Sweep ticks a ref that loaded without 3D is retried before the cell sweep alone looks after it
const PENDING_TRIES = 50;

interface CellSweep {
  id: number;
  cell: Cell;
  type: number;
  index: number;
  froze: number;
}

type Freeze = "frozen" | "waiting" | "done";

export class StaticRefsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("cellFullyLoaded", (e) => this.onCellFullyLoaded(e));
    this.controller.on("cellAttach", (e) => this.onRefAttach(e, true));
    this.controller.on("cellDetach", (e) => this.onRefAttach(e, false));
    this.controller.on("objectLoaded", (e) => this.onObjectLoaded(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(e: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(e);
    if (!content || content["customPacketType"] !== "untouchableBaseIds" || !Array.isArray(content["ids"])) return;
    ObjectReferenceEx.setUntouchableBaseIds((content["ids"] as unknown[]).map(Number).filter((id) => id > 0));
    // The list decides which refs are blocked, so every cached decision is stale
    this.frozen.clear();
    this.ignored.clear();
  }

  // A cell reports itself loaded before its refs stream their 3D in, so it is swept for as long as it stays attached
  private onCellFullyLoaded(e: CellFullyLoadedEvent): void {
    if (e.cell) this.trackCell(e.cell, true);
  }

  // Fired per reference as it joins or leaves a loaded cell; havok is rebuilt on every attach
  private onRefAttach(e: CellAttachDetachEvent, attached: boolean): void {
    try {
      const ref = e.refr;
      if (!ref) return;
      const id = ref.getFormID();
      this.frozen.delete(id);
      if (!attached) {
        this.pending.delete(id);
        if (id >= 0xff000000) this.ignored.delete(id);
        return;
      }
      this.freezeOrPend(ref);
    } catch (err) {
      logError(this, `cell ${attached ? "attach" : "detach"} failed: ${err}`);
    }
  }

  private onObjectLoaded(e: ObjectLoadedEvent): void {
    try {
      const id = e.object?.getFormID();
      if (id === undefined) return;
      this.frozen.delete(id);
      if (!e.isLoaded) {
        this.pending.delete(id);
        // Runtime ids get reused for other refs
        if (id >= 0xff000000) this.ignored.delete(id);
        return;
      }
      const ref = ObjectReference.from(e.object);
      if (ref) this.freezeOrPend(ref);
    } catch (err) {
      logError(this, `onObjectLoaded failed: ${err}`);
    }
  }

  // A ref whose 3D is not in yet is retried from the update loop
  private freezeOrPend(ref: ObjectReference): void {
    if (this.freeze(ref, true) === "waiting") this.pending.set(ref.getFormID(), 0);
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_MS;
    try {
      const cell = this.sp.Game.getPlayer()?.getParentCell();
      if (cell) this.trackCell(cell);
      this.secondPassSlice(now);
      this.sweepSlice(SWEEP_BUDGET - this.pendingSlice());
    } catch (err) {
      // A cell that went away drops out instead of failing every tick
      this.sweeps.shift();
      logError(this, `sweep failed: ${err}`);
    }
  }

  private trackCell(cell: Cell, restart = false): void {
    const id = cell.getFormID();
    const tracked = this.sweeps.find((sweep) => sweep.id === id);
    if (tracked) {
      if (restart) {
        tracked.type = 0;
        tracked.index = 0;
      }
      return;
    }
    this.sweeps.push({ id, cell, type: 0, index: 0, froze: 0 });
  }

  // Havok bodies attach on the physics step after the 3D, so the first setMotionType may have found nothing to freeze
  private secondPassSlice(now: number): void {
    let budget = SWEEP_BUDGET;
    while (budget-- > 0 && this.secondPass.length && this.secondPass[0].at <= now) {
      const { id } = this.secondPass.shift()!;
      if (!this.frozen.has(id)) continue;
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (ref?.is3DLoaded()) ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    }
  }

  // Refs that loaded before their 3D, retried under their own cap; a retried ref moves to the back so a stuck batch cannot hog it
  private pendingSlice(): number {
    let used = 0;
    for (const [id, tries] of Array.from(this.pending)) {
      if (used >= PENDING_BUDGET) break;
      used++;
      this.pending.delete(id);
      const ref = ObjectReference.from(this.sp.Game.getFormEx(id));
      if (ref && this.freeze(ref, true) === "waiting" && tries + 1 < PENDING_TRIES) this.pending.set(id, tries + 1);
    }
    return used;
  }

  // One cell per tick, rotated to the back when its pass ends, so the per frame cost stays flat
  private sweepSlice(budget: number): void {
    while (this.sweeps.length) {
      const sweep = this.sweeps[0];
      if (!sweep.cell.isAttached()) {
        this.sweeps.shift();
        continue;
      }
      while (budget > 0 && sweep.type < FROZEN_TYPES.length) {
        const type = FROZEN_TYPES[sweep.type];
        const count = sweep.cell.getNumRefs(type);
        if (sweep.index >= count) {
          sweep.type++;
          sweep.index = 0;
          continue;
        }
        const take = Math.min(budget, count - sweep.index);
        for (let i = 0; i < take; i++) {
          const ref = sweep.cell.getNthRef(sweep.index + i, type);
          if (ref && this.freeze(ref) === "frozen") sweep.froze++;
        }
        sweep.index += take;
        budget -= take;
      }
      if (sweep.type >= FROZEN_TYPES.length) this.endPass(sweep);
      return;
    }
  }

  private endPass(sweep: CellSweep): void {
    if (sweep.froze > 0 || this.pending.size !== this.loggedPending) {
      this.loggedPending = this.pending.size;
      logTrace(this, `froze ${sweep.froze} refs in cell ${sweep.id.toString(16)}, pending ${this.pending.size}, ${this.sweeps.length} cells attached`);
    }
    sweep.type = 0;
    sweep.index = 0;
    sweep.froze = 0;
    this.sweeps.shift();
    this.sweeps.push(sweep);
  }

  private freeze(ref: ObjectReference, secondPass = false): Freeze {
    const id = ref.getFormID();
    if (this.ignored.has(id)) return "done";
    const base = ref.getBaseObject();
    if (!base) return "done";
    const type = base.getType();
    const isItem = FormTypeEx.isItem(type);
    // Runtime items are server-streamed (dealWithRef) or engine drops like a disarmed weapon, which must stay pickable
    if ((isItem && id >= 0xff000000) || !this.isFrozenBase(base, type)) {
      this.trimCaches();
      this.ignored.add(id);
      return "done";
    }
    // Havok is rebuilt from the mesh every time 3D returns, so an unloaded ref has to be frozen again
    if (!ref.is3DLoaded()) {
      this.frozen.delete(id);
      return "waiting";
    }
    if (this.frozen.has(id)) return "done";
    ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    // Pickups and untouchable decor only go through the server, which syncs or refuses them
    if (isItem || ObjectReferenceEx.isUntouchable(base)) ref.blockActivation(true);
    this.trimCaches();
    this.frozen.add(id);
    if (secondPass) this.secondPass.push({ id, at: Date.now() + SECOND_PASS_MS });
    this.noteFirstFreeze(base, type);
    return "frozen";
  }

  // The first freeze of each base type names its model, so the log shows which classes the sweep reaches
  private noteFirstFreeze(base: Form, type: number): void {
    if (this.seenTypes.has(type)) return;
    this.seenTypes.add(type);
    logTrace(this, `first freeze of type ${type}: base ${base.getFormID().toString(16)} model ${base.getWorldModelPath() || "?"}`);
  }

  // Every visited cell adds refs, so a long session starts over rather than growing without bound
  private trimCaches(): void {
    if (this.frozen.size + this.ignored.size < TRACKED_LIMIT) return;
    this.frozen.clear();
    this.ignored.clear();
  }

  private isFrozenBase(base: Form, type: number): boolean {
    if (type !== FormType.Static && type !== FormType.Container) return FROZEN_TYPES.includes(type);
    const id = base.getFormID();
    let frozen = this.havokModels.get(id);
    if (frozen === undefined) {
      const model = base.getWorldModelPath() || "";
      frozen = model !== "" && !NON_HAVOK_MODEL.test(model);
      this.havokModels.set(id, frozen);
    }
    return frozen;
  }

  private havokModels = new Map<number, boolean>();
  private sweeps: CellSweep[] = [];
  private nextSweepAt = 0;
  private frozen = new Set<number>();
  private ignored = new Set<number>();
  // Ref id -> sweep ticks it was retried without 3D
  private pending = new Map<number, number>();
  private secondPass: Array<{ id: number; at: number }> = [];
  private seenTypes = new Set<number>();
  private loggedPending = 0;
}
