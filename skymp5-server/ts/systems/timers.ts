// Scheduling for the systems: polls, one-shots, keyed one-shots and next-turn work, each guarded so an error is logged, never thrown

export interface Poll {
  stop(): void;
}

// Node fires a longer setTimeout after 1 ms
const MAX_DELAY_MS = 0x7fffffff;
const ERRORS_KEPT = 100;

let polling = false;
const waiting: Array<() => void> = [];

const errorText = (e: unknown): string => (e instanceof Error ? e.stack || e.message : String(e));

// The message and the throwing frame; the frames below it differ between runs of an async poll
const errorKey = (e: unknown): string => {
  if (!(e instanceof Error)) return String(e);
  const frame = (e.stack || "").split("\n").find((line) => line.trimStart().startsWith("at ")) || "";
  return `${e.message} ${frame.trim()}`;
};

const run = (fn: () => unknown): void => {
  try {
    const result = fn();
    if (result instanceof Promise) result.catch((e) => console.error(`[timers] ${errorText(e)}`));
  } catch (e) {
    console.error(`[timers] ${errorText(e)}`);
  }
};

// Called once by the server when every system is initialized; polls created before it wait for it, so tests never start one
export const startPolls = (): void => {
  polling = true;
  for (const start of waiting.splice(0)) start();
};

// Runs fn ms after the previous run ended, async runs included; each distinct error is logged once and the poll goes on
export const every = (name: string, ms: number, fn: () => unknown): Poll => {
  const logged = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = () => {
    if (!stopped) timer = setTimeout(tick, ms);
  };
  const tick = async () => {
    timer = undefined;
    try {
      await fn();
    } catch (e) {
      const key = errorKey(e);
      if (!logged.has(key)) {
        if (logged.size >= ERRORS_KEPT) logged.clear();
        logged.add(key);
        console.error(`[poll ${name}] ${errorText(e)}`);
      }
    } finally {
      schedule();
    }
  };
  if (polling) schedule();
  else waiting.push(schedule);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
};

export const after = (ms: number, fn: () => unknown): NodeJS.Timeout => setTimeout(() => run(fn), ms);

// Next event loop turn, outside the native call stack that asked for it
export const soon = (fn: () => unknown): void => {
  setImmediate(() => run(fn));
};

// One pending one-shot per key at an absolute time; setting a key again replaces its timer
export class KeyedTimers<K> {
  private timers = new Map<K, NodeJS.Timeout>();

  set(key: K, dueAt: number, fn: () => unknown): void {
    this.clear(key);
    const delay = dueAt - Date.now();
    const timer = delay > MAX_DELAY_MS
      ? setTimeout(() => this.set(key, dueAt, fn), MAX_DELAY_MS)
      : setTimeout(() => {
        this.timers.delete(key);
        run(fn);
      }, Math.max(0, delay));
    this.timers.set(key, timer);
  }

  clear(key: K): void {
    const timer = this.timers.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  has(key: K): boolean {
    return this.timers.has(key);
  }
}
