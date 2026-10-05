import { LOGIN_VERIFIED_EVENT, SystemContext } from "./system";
import { every } from "./timers";

// Log-only: counts the packet types users send before LOGIN_VERIFIED, refusing nothing
const SUMMARY_MS = 10 * 60 * 1000;
const MAX_TYPES = 100;
const MAX_TYPE_LENGTH = 64;
const OTHER = "(other)";

const verified = new Set<number>();
const counts = new Map<string, number>();
let changed = false;

const logSummary = (): void => {
  if (!changed) return;
  changed = false;
  console.log(`[preLogin] packet types before login since start: ${JSON.stringify(Object.fromEntries(counts))}`);
};

export const trackPreLogin = (ctx: SystemContext): void => {
  ctx.svr.on("connect", (userId: number) => { verified.delete(userId); });
  ctx.svr.on("disconnect", (userId: number) => { verified.delete(userId); });
  ctx.gm.on(LOGIN_VERIFIED_EVENT, (userId: number) => { verified.add(userId); });
  every("preLogin.summary", SUMMARY_MS, logSummary);
};

export const notePreLoginPacket = (userId: number, type: string): void => {
  if (verified.has(userId)) return;
  let key = type.slice(0, MAX_TYPE_LENGTH);
  if (!counts.has(key) && counts.size >= MAX_TYPES) key = OTHER;
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  changed = true;
  if (n === 1) console.log(`[preLogin] first ${JSON.stringify(key)} packet before login, from user ${userId}`);
};
