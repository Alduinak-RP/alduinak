import { Actor, EffectShader, Game } from "skyrimPlatform";

// Skyrim.esm GhostEtherealFXShader, the Become Ethereal look
const ghostShaderId = 0x64d67;

export const adminGhostAlpha = 0.5;

// Stopping first keeps a replay from stacking a second copy of the shader
export function setAdminGhostShader(actor: Actor, on: boolean): void {
  const shader = EffectShader.from(Game.getFormEx(ghostShaderId));
  shader?.stop(actor);
  if (on) {
    shader?.play(actor, -1);
  }
}
