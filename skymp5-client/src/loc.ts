import table from "../../localization/en_loc.json";
import { locLookup, LocVars } from "../../localization/loc";

// Line from the client section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
export const loc = (key: string, vars?: LocVars): string => locLookup(table.client, key, vars);

// Lines the client echoes before the gamemode's copy arrives
export const gamemodeLoc = (key: string, vars?: LocVars): string => locLookup(table.gamemode, key, vars);
