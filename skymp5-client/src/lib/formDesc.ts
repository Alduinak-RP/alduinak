import { Game } from "skyrimPlatform";

const LIGHT_MOD_HIGH = 0xfe;

// Runtime form id to "hex:Plugin" using the client's own load order (light plugins live in the 0xFE space); null for ids created in game
export const formDesc = (id: number): string | null => {
  let desc: string | null = null;
  const high = id >>> 24;
  try {
    if (high === LIGHT_MOD_HIGH) {
      const idx = (id >>> 12) & 0xfff;
      if (idx < Game.getLightModCount()) desc = (id & 0xfff).toString(16) + ":" + Game.getLightModName(idx);
    } else if (high < Game.getModCount()) {
      desc = (id & 0xffffff).toString(16) + ":" + Game.getModName(high);
    }
  } catch (err) { /* keep null */ }
  return desc && !desc.endsWith(":") ? desc : null;
};
