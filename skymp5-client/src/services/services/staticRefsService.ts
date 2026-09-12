import { Cell, CellFullyLoadedEvent, Form, FormType, MotionType, ObjectLoadedEvent, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { logError, logTrace } from "../../logging";

// World clutter is frozen per cell so local havok cannot move it; script-enabled refs are not covered
const FROZEN_TYPES = [FormType.MovableStatic, FormType.Flora, FormType.Activator, FormType.Static, ...FormTypeEx.itemTypes];

// Mods often place havok-enabled item meshes as statics; only those model folders are worth a native call
const HAVOK_STATIC_MODEL = /(^|[\\/])(clutter|plants)[\\/]/i;

export class StaticRefsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("cellFullyLoaded", (e) => this.onCellFullyLoaded(e));
    this.controller.on("objectLoaded", (e) => this.onObjectLoaded(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
  }

  private onCellFullyLoaded(e: CellFullyLoadedEvent): void {
    if (e.cell) this.freezeCell(e.cell);
  }

  // Refs whose 3D streams in after the cell attached
  private onObjectLoaded(e: ObjectLoadedEvent): void {
    if (!e.isLoaded) return;
    try {
      const ref = ObjectReference.from(e.object);
      if (ref) this.freeze(ref);
    } catch (err) {
      logError(this, `onObjectLoaded failed: ${err}`);
    }
  }

  // The cell the player spawns into may have attached before the service saw a cellFullyLoaded event
  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>): void {
    if (!e.message.isMe) return;
    // Natives throw in the packet context
    this.controller.once("update", () => {
      const cell = this.sp.Game.getPlayer()?.getParentCell();
      if (cell) this.freezeCell(cell);
    });
  }

  private freezeCell(cell: Cell): void {
    let frozen = 0;
    try {
      for (const type of FROZEN_TYPES) {
        const count = cell.getNumRefs(type);
        for (let i = 0; i < count; i++) {
          const ref = cell.getNthRef(i, type);
          if (ref && this.freeze(ref)) frozen++;
        }
      }
      if (frozen > 0) logTrace(this, `froze ${frozen} refs in cell ${cell.getFormID().toString(16)}`);
    } catch (err) {
      logError(this, `freezeCell failed: ${err}`);
    }
  }

  // Nothing to keyframe without 3D; objectLoaded brings such refs back later
  private freeze(ref: ObjectReference): boolean {
    const base = ref.getBaseObject();
    if (!base) return false;
    const type = base.getType();
    if (!this.isFrozenBase(base, type) || !ref.is3DLoaded()) return false;
    ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    // Pickups and untouchable decor only go through the server, which syncs or refuses them
    if (FormTypeEx.isItem(type) || ObjectReferenceEx.isLeveledFlora(base)) ref.blockActivation(true);
    return true;
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
}
