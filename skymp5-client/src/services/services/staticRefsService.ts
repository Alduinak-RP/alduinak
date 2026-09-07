import { Cell, CellFullyLoadedEvent, FormType, MotionType, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CreateActorMessage } from "../messages/createActorMessage";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { logError, logTrace } from "../../logging";

// Movable statics (cart wheels, wagon parts, hanging clutter) run on local havok and the server never syncs them;
// coin purses are flora with havok that the server may stream before their 3D exists. Both are frozen per cell as
// it attaches, so nobody kicks them around and every client sees the same scene. Refs a script enables later
// (collapse sequences) are not covered, those sequences do not run in multiplayer.
const FROZEN_TYPES = [FormType.MovableStatic, FormType.Flora];

export class StaticRefsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("cellFullyLoaded", (e) => this.onCellFullyLoaded(e));
    this.controller.emitter.on("createActorMessage", (e) => this.onCreateActorMessage(e));
  }

  private onCellFullyLoaded(e: CellFullyLoadedEvent): void {
    const cell = e.cell;
    if (!cell) return;
    // Natives throw outside the update context
    this.controller.once("update", () => this.freezeCell(cell));
  }

  // The cell the player spawns into may have attached before the service saw a cellFullyLoaded event
  private onCreateActorMessage(e: ConnectionMessage<CreateActorMessage>): void {
    if (!e.message.isMe) return;
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
          if (ref) {
            this.freeze(ref);
            frozen++;
          }
        }
      }
      if (frozen > 0) logTrace(this, `froze ${frozen} refs in cell ${cell.getFormID().toString(16)}`);
    } catch (err) {
      logError(this, `freezeCell failed: ${err}`);
    }
  }

  private freeze(ref: ObjectReference): void {
    ref.setMotionType(MotionType.Keyframed, false).catch(() => { /* ref vanished */ });
    const base = ref.getBaseObject();
    // Coin purses must not harvest locally either; the server refuses them and the client would desync
    if (base && ObjectReferenceEx.isLeveledFlora(base)) ref.blockActivation(true);
  }
}
