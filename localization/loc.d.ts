export type LocVars = Record<string, string | number>;

export function locLookup(section: unknown, key: string, vars?: LocVars): string;
