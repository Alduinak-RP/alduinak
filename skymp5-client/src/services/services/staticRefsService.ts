import { Cell, CellFullyLoadedEvent, FormType, MotionType, ObjectLoadedEvent, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { logError, logTrace } from "../../logging";

// Movable statics and flora are frozen per cell so local havok cannot move them; script-enabled refs are not covered
const FROZEN_TYPES = [FormType.MovableStatic, FormType.Flora];

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
      const type = ref?.getBaseObject()?.getType();
      if (ref && type !== undefined && FROZEN_TYPES.includes(type)) this.freeze(ref);
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
    if (!ref.is3DLoaded()) return false;
    ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    const base = ref.getBaseObject();
    // Coin purses must not harvest locally either; the server refuses them and the client would desync
    if (base && ObjectReferenceEx.isLeveledFlora(base)) ref.blockActivation(true);
    return true;
  }
}
