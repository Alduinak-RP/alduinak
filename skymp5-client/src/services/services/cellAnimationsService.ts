import { ClientListener, CombinedController, Sp } from "./clientListener";
import { logError, logTrace } from "../../logging";

// Animation events sent to placed refs whenever their cell loads, for states a vanilla script would set but Papyrus is blocked here
const CELL_ANIMATIONS: Record<number, { ref: number; anim: string }[]> = {
  // HelgenKeep01: the hall collapse effect already fallen, as the opening quest leaves it
  0x0005de24: [{ ref: 0x000c7fa2, anim: "PlayAnim02" }],
};

// playAnimation fails until the ref's graph is ready, so pending entries are retried
const RETRY_MS = 500;

export class CellAnimationsService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.on("cellFullyLoaded", () => this.rearmCell());
    this.controller.on("loadGame", () => this.rearmCell());
    this.controller.on("cellDetach", (e) => this.onCellDetach(e.refr?.getFormID() ?? 0));
    this.controller.on("update", () => this.onUpdate());
    this.controller.emitter.on("playerWorldOrCellChanged", (e) => this.onPlayerWorldOrCellChanged(e.worldOrCell));
  }

  // The server's last animation of a ref it just created, replayed once the ref's 3D is in
  queue(refId: number, anim: string): void {
    this.pending.set(refId, anim);
  }

  private onCellDetach(refId: number): void {
    this.pending.delete(refId);
  }

  // CELL_ANIMATIONS keys are interior cells, where the world or cell is the cell itself
  private onPlayerWorldOrCellChanged(worldOrCell: number): void {
    this.cellId = worldOrCell;
    this.rearmCell();
  }

  // The player's cell entries are played again once its refs are back in
  private rearmCell(): void {
    this.applied.clear();
    this.cellDue = !!CELL_ANIMATIONS[this.cellId];
    this.nextTryAt = 0;
  }

  private onUpdate(): void {
    if (!this.pending.size && !this.cellDue) return;
    const now = Date.now();
    if (now < this.nextTryAt) return;
    this.nextTryAt = now + RETRY_MS;
    try {
      this.pending.forEach((anim, ref) => {
        if (this.play(ref, anim)) this.pending.delete(ref);
      });
      if (!this.cellDue) return;
      const entries = CELL_ANIMATIONS[this.cellId] ?? [];
      for (const entry of entries) {
        if (this.applied.has(entry.ref)) continue;
        if (this.play(entry.ref, entry.anim)) this.applied.add(entry.ref);
      }
      this.cellDue = entries.some((entry) => !this.applied.has(entry.ref));
    } catch (err) {
      logError(this, `update failed: ${err}`);
    }
  }

  private play(refId: number, anim: string): boolean {
    const ref = this.sp.ObjectReference.from(this.sp.Game.getFormEx(refId));
    if (!ref?.is3DLoaded() || !ref.playAnimation(anim)) return false;
    logTrace(this, `${anim} sent to ${refId.toString(16)} in cell ${this.cellId.toString(16)}`);
    return true;
  }

  private cellId = 0;
  // The cell has entries not played since it loaded
  private cellDue = false;
  private nextTryAt = 0;
  private applied = new Set<number>();
  private pending = new Map<number, string>();
}
