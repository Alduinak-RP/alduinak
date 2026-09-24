import * as fs from "fs";
import * as path from "path";
import { REST, Routes } from "discord.js";
import { Settings } from "../settings";
import { System, SystemContext } from "./system";
import { appendLog, describeActor, displayNameOf, logDirOf, whereOf } from "./playerText";
import { hex, isPlayerActor } from "./actorUtil";

type Mp = any;

// Staff alerts to every discordAuth.guilds[].eventLogChannelId, batched per FLUSH_MS; discord.js REST queues around rate limits
// Only the kinds in discordAlertKinds (default DEFAULT_ALERT_KINDS) are posted, every other kind is dropped in discordAlert
// ADMIN_TAB_KINDS also reach online staff's in-game Admin tab, whatever discordAlertKinds lists

export type AlertKind = "death" | "execute" | "admin" | "ticket" | "keyword" | "login";
export interface AlertOptions { here?: boolean; discordIds?: string[] }

const LABELS: Record<AlertKind, string> = { death: "Death", execute: "Execution", admin: "Admin", ticket: "Staff call", keyword: "Keyword", login: "Login" };
const DEFAULT_ALERT_KINDS: AlertKind[] = ["death", "execute", "ticket"];
let allowedKinds = new Set<string>(DEFAULT_ALERT_KINDS);
const ADMIN_TAB_KINDS = new Set<string>(["death", "execute"]);
const FLUSH_MS = 2000;
const MAX_MESSAGE = 2000;
const MAX_LINE = 1800;
const MAX_PENDING = 40;
// Owner-edited, next to server-settings.json; re-read when its mtime changes
const KEYWORD_FILE = "alert-keywords.json";
const KEYWORD_CHECK_MS = 5000;
const DEFAULT_KEYWORD_COOLDOWN_S = 60;
// Player links must not unfurl into previews
const SUPPRESS_EMBEDS = 4;
const DEATH_ALERTED_MS = 10000;
const ADMIN_LOG_FILE = "admin.log";

interface Target { rest: REST; channelIds: string[] }

let target: Promise<Target | null> | null = null;
let logDir = "";
const pending: { line: string; here: boolean }[] = [];
let skipped = 0;
let flushTimer: NodeJS.Timeout | null = null;

const targetOf = (): Promise<Target | null> => {
  target ??= Settings.get().then((s) => {
    const auth = s.discordAuth;
    const channelIds = [...new Set((auth?.guilds || []).map((g) => g.eventLogChannelId || "").filter((id) => id))];
    if (s.offlineMode || !auth?.botToken || !channelIds.length) return null;
    return { rest: new REST({ version: "10" }).setToken(auth.botToken), channelIds };
  }).catch((e) => {
    console.error(`[discordAlerts] disabled: ${e}`);
    return null;
  });
  return target;
};

// One line, no pings, no markdown from player text
const clean = (text: string): string =>
  String(text).replace(/\s+/g, " ").trim().replace(/[\\*_~`|>[\]]/g, "\\$&").replace(/@/g, "@\u200b").slice(0, MAX_LINE);

// Joins lines into as few messages as fit in room characters each
const chunk = (lines: string[], room: number): string[] => {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.slice(0, room);
    const last = out.length - 1;
    if (last >= 0 && out[last].length + 1 + line.length <= room) out[last] += "\n" + line;
    else out.push(line);
  }
  return out;
};

async function flush(): Promise<void> {
  flushTimer = null;
  const batch = pending.splice(0);
  if (skipped) {
    batch.push({ line: `(${skipped} more alert(s) skipped in the burst, see the server logs)`, here: false });
    skipped = 0;
  }
  const t = await targetOf();
  if (!t || !batch.length) return;
  const prefix = batch.some((b) => b.here) ? "@here\n" : "";
  chunk(batch.map((b) => b.line), MAX_MESSAGE - prefix.length).forEach((text, i) => {
    const content = i === 0 ? prefix + text : text;
    const allowed_mentions = { parse: prefix && i === 0 ? ["everyone"] : [] };
    for (const id of t.channelIds) {
      t.rest.post(Routes.channelMessages(id), { body: { content, allowed_mentions, flags: SUPPRESS_EMBEDS } })
        .catch((e) => console.error(`[discordAlerts] post to ${id} failed: ${e?.message ?? e}`));
    }
  });
}

// Raw event-log line, sent as is and unfiltered: callers go through discordAlert
function postEventLog(line: string, here = false): void {
  if (pending.length >= MAX_PENDING && !here) skipped++;
  else pending.push({ line, here });
  flushTimer ??= setTimeout(() => void flush(), FLUSH_MS);
}

// Through the gamemode's __alduinakStaffLine (35_admin_chat.js), which colors and sanitizes the line
function adminTabLine(label: string, text: string): void {
  try {
    (globalThis as any).__alduinakStaffLine?.(label, text);
  } catch (e) {
    console.error(`[discordAlerts] Admin tab line failed: ${e}`);
  }
}

export function discordAlert(kind: AlertKind, text: string, opts: AlertOptions = {}): void {
  if (ADMIN_TAB_KINDS.has(kind)) adminTabLine(LABELS[kind], text);
  if (!allowedKinds.has(kind)) return;
  const mentions = (opts.discordIds || []).filter((id) => /^\d{5,25}$/.test(String(id))).map((id) => ` <@${id}>`).join("");
  postEventLog(`**[${LABELS[kind] || clean(String(kind))}]** ${clean(text)}${mentions}`, !!opts.here);
}
(globalThis as any).__alduinakDiscordAlert = discordAlert;

// Staff audit: admin.log, plus the admin alert kind unless alert is false
export function adminAudit(text: string, alert = true): void {
  appendLog(logDir, ADMIN_LOG_FILE, text);
  if (alert) discordAlert("admin", text);
}

const actorLabel = (mp: Mp, actorId: number): string =>
  isPlayerActor(mp, actorId) ? describeActor(mp, actorId) : `${JSON.stringify(displayNameOf(mp, actorId))} (${hex(actorId)})`;

const deathAlertedAt = new Map<number, number>();

// A kill that already posted its own line (execute, finish off) skips the [Death] line that follows
export function markDeathAlerted(actorId: number): void {
  deathAlertedAt.set(actorId >>> 0, Date.now());
}
(globalThis as any).__alduinakMarkDeathAlerted = markDeathAlerted;

export function deathAlert(mp: Mp, actorId: number, killerId: number, how = "died"): void {
  const markedAt = deathAlertedAt.get(actorId);
  deathAlertedAt.delete(actorId);
  if (markedAt !== undefined && Date.now() - markedAt < DEATH_ALERTED_MS) return;
  if (!isPlayerActor(mp, actorId)) return;
  const killer = killerId && killerId !== actorId ? `, killed by ${actorLabel(mp, killerId)}` : "";
  discordAlert("death", `${describeActor(mp, actorId)} ${how}${killer}, ${whereOf(mp, actorId)}`);
}

interface KeywordState { checkedAt: number; mtimeMs: number; words: { word: string; re: RegExp }[]; cooldownMs: number }
const keywordState: KeywordState = { checkedAt: 0, mtimeMs: -1, words: [], cooldownMs: DEFAULT_KEYWORD_COOLDOWN_S * 1000 };
const keywordLastAlert = new Map<string, number>();

// Whole words or phrases, case-insensitive; a trailing * matches any word ending
const keywordRegex = (word: string): RegExp => {
  const body = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+").replace(/\\\*$/, "[\\p{L}\\p{N}_]*");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`, "iu");
};

export function loadKeywords(file = path.resolve(KEYWORD_FILE), now = Date.now()): KeywordState {
  if (now - keywordState.checkedAt < KEYWORD_CHECK_MS) return keywordState;
  keywordState.checkedAt = now;
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch { /* no file, no keywords */ }
  if (mtimeMs === keywordState.mtimeMs) return keywordState;
  keywordState.mtimeMs = mtimeMs;
  if (!mtimeMs) {
    keywordState.words = [];
    return keywordState;
  }
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const list: unknown[] = Array.isArray(json?.keywords) ? json.keywords : [];
    const words = [...new Set(list.filter((w): w is string => typeof w === "string" && !!w.trim()).map((w) => w.trim()))];
    keywordState.words = words.map((word) => ({ word, re: keywordRegex(word) }));
    const cooldown = Number(json?.cooldownSeconds);
    keywordState.cooldownMs = (Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_KEYWORD_COOLDOWN_S) * 1000;
    console.log(`[discordAlerts] ${keywordState.words.length} alert keyword(s) loaded from ${file}`);
  } catch (e) {
    // A broken edit keeps the previous list
    console.error(`[discordAlerts] ${file} is not valid JSON, keeping the previous keywords: ${e}`);
  }
  return keywordState;
}

// Words of one chat line that are not on cooldown for this speaker
export function matchKeywords(speaker: string, text: string, now = Date.now()): string[] {
  const { words, cooldownMs } = loadKeywords(undefined, now);
  const hits = words.filter(({ word, re }) => {
    if (!re.test(text)) return false;
    const key = `${speaker}\u0000${word.toLowerCase()}`;
    if (now - (keywordLastAlert.get(key) ?? -Infinity) < cooldownMs) return false;
    keywordLastAlert.set(key, now);
    return true;
  }).map(({ word }) => word);
  if (keywordLastAlert.size > 1000) keywordLastAlert.forEach((at, key) => { if (now - at >= cooldownMs) keywordLastAlert.delete(key); });
  return hits;
}

export function keywordAlert(mp: Mp, actorId: number, channel: string, text: string): void {
  const hits = matchKeywords(String(actorId >>> 0), text);
  if (hits.length) discordAlert("keyword", `${describeActor(mp, actorId)} in ${channel}: ${JSON.stringify(text)} (matched ${hits.join(", ")})`);
}

// Registers the hooks the gamemode calls: g.__alduinakDeathAlert from onDeath, g.__alduinakKeywordAlert from chat
export class DiscordAlerts implements System {
  systemName = "DiscordAlerts";

  async initAsync(ctx: SystemContext): Promise<void> {
    const mp = ctx.svr as unknown as Mp;
    const g = globalThis as any;
    g.__alduinakDeathAlert = (actorId: number, killerId: number) => deathAlert(mp, actorId >>> 0, killerId >>> 0);
    g.__alduinakKeywordAlert = (actorId: number, channel: string, text: string) => keywordAlert(mp, actorId >>> 0, String(channel), String(text));
    loadKeywords();
    const all = (await Settings.get()).allSettings;
    logDir = logDirOf(all);
    const kinds = all?.["discordAlertKinds"];
    if (Array.isArray(kinds) && kinds.length && kinds.every((k) => typeof k === "string")) allowedKinds = new Set(kinds);
    const unknown = Array.isArray(kinds) ? kinds.filter((k) => !(typeof k === "string" && k in LABELS)) : [];
    if (unknown.length) console.log(`[discordAlerts] discordAlertKinds names no such kind: ${unknown.join(", ")}`);
    if (!(await targetOf())) console.log("[discordAlerts] no Discord event log channel, game alerts are off");
    else console.log(`[discordAlerts] posting ${[...allowedKinds].join(", ")}`);
  }
}
