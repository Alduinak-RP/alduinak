import { Sp } from "./clientListener";

// Sets each game setting (i prefix as int, else float) and appends "name was -> now" to applied
export const setGameSettings = (sp: Sp, settings: Record<string, number>, applied: string[]): void => {
  for (const [name, value] of Object.entries(settings)) {
    const isInt = name.startsWith("i");
    const read = () => (isInt ? sp.Game.getGameSettingInt(name) : sp.Game.getGameSettingFloat(name));
    const was = read();
    if (isInt) sp.Game.setGameSettingInt(name, value);
    else sp.Game.setGameSettingFloat(name, value);
    applied.push(`${name} ${was} -> ${read()}`);
  }
};
