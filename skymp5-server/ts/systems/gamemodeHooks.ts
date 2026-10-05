import { runMpHook } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;
type Handler = (...args: unknown[]) => unknown;

// mp hooks the server owns so a gamemode load never unhooks a system; systems chain them in initAsync, before the first load
export const GAMEMODE_HOOKS = ["onDeath", "onHitDamage", "onConsoleCommand"] as const;

const dispatchers = new Map<string, Handler>();
// What the last gamemode load assigned to a hook itself (an older gamemode); it runs after that load's handler lists
const assigned = new Map<string, Handler>();
const runningAssigned = new Set<string>();

// The handlers the gamemode registered with on(event, fn) for its current load, then what it assigned itself
const runGamemode = (mp: Mp, event: string, args: unknown[]): void => {
  const list: unknown = (globalThis as any).__alduinakHandlers?.[event];
  if (Array.isArray(list)) for (const handler of list) runMpHook(mp, event, handler, args);
  const own = assigned.get(event);
  if (!own) return;
  runningAssigned.add(event);
  try {
    runMpHook(mp, event, own, args);
  } finally {
    runningAssigned.delete(event);
  }
};

// Once, before the first gamemode load: each hook runs the systems' chain, whose verdict it returns, then the gamemode's handlers
export const ownGamemodeHooks = (mp: Mp): void => {
  if (dispatchers.size) return;
  (globalThis as any).__alduinakTsHooks = true;
  for (const event of GAMEMODE_HOOKS) {
    const systems: Handler | null = typeof mp[event] === "function" ? mp[event] : null;
    const dispatcher = (...args: unknown[]): boolean => {
      // An assigned function that calls the hook it replaced comes back here; the outer call runs everything once
      if (runningAssigned.has(event)) return true;
      const verdict = systems ? runMpHook(mp, event, systems, args) !== false : true;
      runGamemode(mp, event, args);
      return verdict;
    };
    mp[event] = dispatcher;
    dispatchers.set(event, dispatcher);
  }
};

// After every gamemode load: a hook the load assigned is kept to run after the lists, and the dispatcher goes back in place
export const reclaimGamemodeHooks = (mp: Mp): void => {
  for (const [event, dispatcher] of dispatchers) {
    const current = mp[event];
    if (current === dispatcher || typeof current !== "function") {
      assigned.delete(event);
    } else {
      assigned.set(event, current);
      console.log(`[gamemodeHooks] the gamemode assigned mp.${event} itself; it runs after the server's ${event} handlers`);
    }
    mp[event] = dispatcher;
  }
};
