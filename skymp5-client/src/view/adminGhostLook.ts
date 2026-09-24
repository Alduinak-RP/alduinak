import { Actor, EffectShader, Game } from "skyrimPlatform";

// Skyrim.esm GhostEtherealFXShader, the Become Ethereal look
const ghostShaderId = 0x64d67;

export const adminGhostAlpha = 0.5;

// Stopping first keeps a replay from stacking a second copy of the shader; the afterlife looks pass their own EFSH and alpha
export function setAdminGhostShader(actor: Actor, on: boolean, shaderId = ghostShaderId, alpha?: number): void {
  const shader = EffectShader.from(Game.getFormEx(shaderId));
  shader?.stop(actor);
  if (on) {
    shader?.play(actor, -1);
  }
  if (alpha !== undefined) {
    actor.setAlpha(alpha, false);
  }
}

// The realm look of a model's ff_afterlife ({ realm, shader, alpha }): a global EFSH id, 0 without one
export function afterlifeLookOf(model: Record<string, unknown> | undefined): { shaderId: number; alpha: number } {
  const look = model?.["ff_afterlife"] as { shader?: unknown; alpha?: unknown } | null | undefined;
  if (!look || typeof look !== "object") {
    return { shaderId: 0, alpha: 1 };
  }
  const alpha = typeof look.alpha === "number" && look.alpha >= 0 && look.alpha <= 1 ? look.alpha : 1;
  return { shaderId: Number(look.shader) >>> 0, alpha };
}
