import table from "../../localization/en_loc.json";
import { locLookup, LocVars } from "../../localization/loc";

// Line from the server section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
export const loc = (key: string, vars?: LocVars): string => locLookup(table.server, key, vars);

// Line from the gamemode section: the loc() the gamemode bundle calls when it carries no prelude of its own
export const gamemodeLoc = (key: string, vars?: LocVars): string => locLookup(table.gamemode, key, vars);
