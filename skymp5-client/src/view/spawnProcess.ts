import { ObjectReference, Game, Actor } from "skyrimPlatform";
import { Appearance, applyTints } from "../sync/appearance";
import { NiPoint3 } from "../sync/movement";
import { ObjectReferenceEx } from "../extensions/objectReferenceEx";

export class SpawnProcess {
  // isDead: a copy that arrives as a corpse is not stood up first, the first apply kills it
  constructor(
    appearance: Appearance | null,
    pos: NiPoint3,
    refrId: number,
    private callback: () => void,
    private isDead = false,
  ) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    refr.setPosition(...pos).then(() => this.enable(appearance, refrId));
  }

  private enable(appearance: Appearance | null, refrId: number) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac && appearance) {
      applyTints(ac, appearance);
    }
    refr.enable(false).then(() => this.resurrect(refrId));
  }

  private resurrect(refrId: number) {
    const refr = ObjectReference.from(Game.getFormEx(refrId));
    if (!refr || refr.getFormID() !== refrId) {
      return;
    }

    const ac = Actor.from(refr);
    if (ac) {
      if (this.isDead) {
        return this.callback();
      }
      return ac.resurrect().then(() => {
        this.callback();
      });
    }

    const base = refr.getBaseObject()!;
    ObjectReferenceEx.dealWithRef(refr, base);
    return this.callback();
  }
}
