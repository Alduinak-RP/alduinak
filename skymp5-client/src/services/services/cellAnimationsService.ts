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
    this.controller.on("cellFullyLoaded", () => this.applied.clear());
    this.controller.on("cellDetach", (e) => this.onCellDetach(e.refr?.getFormID() ?? 0));
    this.controller.on("update", () => this.onUpdate());
  }

  // The server's last animation of a ref it just created, replayed once the ref's 3D is in
  queue(refId: number, anim: string): void {
    this.pending.set(refId, anim);
  }

  private onCellDetach(refId: number): void {
    this.pending.delete(refId);
  }

  private onUpdate(): void {
    const now = Date.now();
    if (now < this.nextTryAt) return;
    this.nextTryAt = now + RETRY_MS;
    try {
      const cellId = this.sp.Game.getPlayer()?.getParentCell()?.getFormID() ?? 0;
      if (cellId !== this.cellId) {
        this.cellId = cellId;
        this.applied.clear();
      }
      this.pending.forEach((anim, ref) => {
        if (this.play(ref, anim, cellId)) this.pending.delete(ref);
      });
      const entries = CELL_ANIMATIONS[cellId];
      if (!entries) return;
      for (const entry of entries) {
        if (this.applied.has(entry.ref)) continue;
        if (this.play(entry.ref, entry.anim, cellId)) this.applied.add(entry.ref);
      }
    } catch (err) {
      logError(this, `update failed: ${err}`);
    }
  }

  private play(refId: number, anim: string, cellId: number): boolean {
    const ref = this.sp.ObjectReference.from(this.sp.Game.getFormEx(refId));
    if (!ref?.is3DLoaded() || !ref.playAnimation(anim)) return false;
    logTrace(this, `${anim} sent to ${refId.toString(16)} in cell ${cellId.toString(16)}`);
    return true;
  }

  private cellId = 0;
  private nextTryAt = 0;
  private applied = new Set<number>();
  private pending = new Map<number, string>();
}
