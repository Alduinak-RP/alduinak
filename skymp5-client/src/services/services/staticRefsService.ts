import { Cell, CellFullyLoadedEvent, Form, FormType, MotionType, ObjectLoadedEvent, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { logError, logTrace } from "../../logging";

// World clutter is frozen as its cell or 3D loads so local havok cannot move it
const FROZEN_TYPES = [FormType.MovableStatic, FormType.Flora, FormType.Activator, FormType.Furniture, FormType.Static, ...FormTypeEx.itemTypes];

// Mods often place havok-enabled item meshes as statics; only those model folders are worth a native call
const HAVOK_STATIC_MODEL = /(^|[\\/])clutter[\\/]|^(meshes[\\/])?plants[\\/]/i;

const SWEEP_MS = 200;
// Refs looked at per sweep tick
const SWEEP_BUDGET = 128;
// How long a loaded cell keeps being revisited; the cell the player stands in is refreshed every tick
const SWEEP_WINDOW_MS = 30000;
const TRACKED_LIMIT = 8192;

interface CellSweep {
  id: number;
  cell: Cell;
  type: number;
  index: number;
  froze: number;
  until: number;
}

export class StaticRefsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("cellFullyLoaded", (e) => this.onCellFullyLoaded(e));
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

  // A cell reports itself loaded before its refs stream their 3D in, so it is swept for a while
  private onCellFullyLoaded(e: CellFullyLoadedEvent): void {
    if (e.cell) this.trackCell(e.cell, Date.now() + SWEEP_WINDOW_MS);
  }

  private onObjectLoaded(e: ObjectLoadedEvent): void {
    if (!e.isLoaded) return;
    try {
      const ref = ObjectReference.from(e.object);
      if (ref) this.freeze(ref);
    } catch (err) {
      logError(this, `onObjectLoaded failed: ${err}`);
    }
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_MS;
    try {
      const cell = this.sp.Game.getPlayer()?.getParentCell();
      if (cell) this.trackCell(cell, now + SWEEP_WINDOW_MS);
      this.sweepSlice(now);
    } catch (err) {
      // A cell that went away drops out instead of failing every tick
      this.sweeps.shift();
      logError(this, `sweep failed: ${err}`);
    }
  }

  private trackCell(cell: Cell, until: number): void {
    const id = cell.getFormID();
    const tracked = this.sweeps.find((sweep) => sweep.id === id);
    if (tracked) {
      tracked.until = Math.max(tracked.until, until);
      return;
    }
    this.sweeps.push({ id, cell, type: 0, index: 0, froze: 0, until });
  }

  // One cell per tick, rotated to the back when its pass ends, so the per frame cost stays flat
  private sweepSlice(now: number): void {
    while (this.sweeps.length) {
      const sweep = this.sweeps[0];
      if (sweep.until <= now) {
        this.sweeps.shift();
        continue;
      }
      let budget = SWEEP_BUDGET;
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
          if (ref && this.freeze(ref)) sweep.froze++;
        }
        sweep.index += take;
        budget -= take;
      }
      if (sweep.type >= FROZEN_TYPES.length) this.endPass(sweep);
      return;
    }
  }

  private endPass(sweep: CellSweep): void {
    if (sweep.froze > 0) logTrace(this, `froze ${sweep.froze} refs in cell ${sweep.id.toString(16)}`);
    sweep.type = 0;
    sweep.index = 0;
    sweep.froze = 0;
    this.sweeps.shift();
    this.sweeps.push(sweep);
  }

  private freeze(ref: ObjectReference): boolean {
    const id = ref.getFormID();
    if (this.ignored.has(id)) return false;
    // Havok is rebuilt from the mesh every time 3D returns, so an unloaded ref has to be frozen again
    if (!ref.is3DLoaded()) {
      this.frozen.delete(id);
      return false;
    }
    if (this.frozen.has(id)) return false;
    const base = ref.getBaseObject();
    if (!base) return false;
    const type = base.getType();
    const isItem = FormTypeEx.isItem(type);
    // Runtime items are server-streamed (dealWithRef) or engine drops like a disarmed weapon, which must stay pickable
    if ((isItem && id >= 0xff000000) || !this.isFrozenBase(base, type)) {
      this.trimCaches();
      this.ignored.add(id);
      return false;
    }
    ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    // Pickups and untouchable decor only go through the server, which syncs or refuses them
    if (isItem || ObjectReferenceEx.isUntouchable(base)) ref.blockActivation(true);
    this.trimCaches();
    this.frozen.add(id);
    return true;
  }

  // Every visited cell adds refs, so a long session starts over rather than growing without bound
  private trimCaches(): void {
    if (this.frozen.size + this.ignored.size < TRACKED_LIMIT) return;
    this.frozen.clear();
    this.ignored.clear();
  }

  private isFrozenBase(base: Form, type: number): boolean {
    if (type !== FormType.Static) return FROZEN_TYPES.includes(type);
    const id = base.getFormID();
    let frozen = this.havokStatics.get(id);
    if (frozen === undefined) {
      frozen = HAVOK_STATIC_MODEL.test(base.getWorldModelPath() || "");
      this.havokStatics.set(id, frozen);
    }
    return frozen;
  }

  private havokStatics = new Map<number, boolean>();
  private sweeps: CellSweep[] = [];
  private nextSweepAt = 0;
  private frozen = new Set<number>();
  private ignored = new Set<number>();
}
