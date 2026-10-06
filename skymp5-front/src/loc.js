import table from '../../localization/en_loc.json';
import { locLookup } from '../../localization/loc';

// Line from the front section of localization/en_loc.json with {placeholders} filled; a missing key returns the key
export const loc = (key, vars) => locLookup(table.front, key, vars);
