import { Cell, CellAttachDetachEvent, FormType, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { parseCustomPacket } from "./customPacketUtil";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { FormTypeEx } from "../../extensions/formTypeEx";
import { logError } from "../../logging";

// Placed havok objects are keyframed natively (SkyrimPlatform StaticFreeze.cpp); this service blocks engine activation the server must handle
// Every type a placed item or an untouchable base has
const BLOCKED_TYPES = [FormType.Flora, FormType.Activator, FormType.Furniture, FormType.Container, ...FormTypeEx.itemTypes];

const PASS_MS = 200;
// Refs looked at per pass tick
const PASS_BUDGET = 128;

interface CellPass {
  id: number;
  cell: Cell;
  type: number;
  index: number;
}

export class StaticRefsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("update", () => this.onUpdate());
    this.controller.on("cellFullyLoaded", (e) => { if (e.cell) this.queueCell(e.cell); });
    this.controller.on("cellAttach", (e) => this.onCellAttach(e));
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
  }

  private onCustomPacketMessage(e: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(e);
    if (!content || content["customPacketType"] !== "untouchableBaseIds" || !Array.isArray(content["ids"])) return;
    ObjectReferenceEx.setUntouchableBaseIds((content["ids"] as unknown[]).map(Number).filter((id) => id > 0));
    // Refs that attached before the list arrived are looked at again
    const cell = this.sp.Game.getPlayer()?.getParentCell();
    if (cell) this.queueCell(cell);
  }

  // Fired per reference; a reattached cell recreates its refs without the block
  private onCellAttach(e: CellAttachDetachEvent): void {
    try {
      if (e.refr) this.blockIfServerOnly(e.refr);
    } catch (err) {
      logError(this, `cell attach failed: ${err}`);
    }
  }

  // One pass per loaded cell catches a ref whose attach event was missed
  private queueCell(cell: Cell): void {
    const id = cell.getFormID();
    const queued = this.passes.find((pass) => pass.id === id);
    if (queued) {
      queued.type = 0;
      queued.index = 0;
      return;
    }
    this.passes.push({ id, cell, type: 0, index: 0 });
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextPassAt) return;
    this.nextPassAt = now + PASS_MS;
    try {
      this.passSlice();
    } catch (err) {
      // A cell that went away drops out instead of failing every tick
      this.passes.shift();
      logError(this, `cell pass failed: ${err}`);
    }
  }

  // One cell at a time on a fixed budget, so a city load costs a few ticks
  private passSlice(): void {
    let budget = PASS_BUDGET;
    while (this.passes.length && budget > 0) {
      const pass = this.passes[0];
      if (pass.type >= BLOCKED_TYPES.length || !pass.cell.isAttached()) {
        this.passes.shift();
        continue;
      }
      const type = BLOCKED_TYPES[pass.type];
      const count = pass.cell.getNumRefs(type);
      if (pass.index >= count) {
        pass.type++;
        pass.index = 0;
        continue;
      }
      const take = Math.min(budget, count - pass.index);
      for (let i = 0; i < take; i++) {
        const ref = pass.cell.getNthRef(pass.index + i, type);
        if (ref) this.blockIfServerOnly(ref);
      }
      pass.index += take;
      budget -= take;
    }
  }

  // Placed pickups and untouchable decor only go through the server, which syncs or refuses them
  private blockIfServerOnly(ref: ObjectReference): void {
    const base = ref.getBaseObject();
    if (!base) return;
    // Runtime items are server-streamed (dealWithRef) or engine drops like a disarmed weapon, which must stay pickable
    const blocked = FormTypeEx.isItem(base.getType()) ? ref.getFormID() < 0xff000000 : ObjectReferenceEx.isUntouchable(base);
    if (blocked) ref.blockActivation(true);
  }

  private passes: CellPass[] = [];
  private nextPassAt = 0;
}
