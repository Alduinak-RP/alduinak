import * as fs from "fs";
import * as path from "path";
import { MAP_MARKER_LOCATIONS } from "./adminMapMarkers";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Player-written text and the audit trail around it, shared by the missive boards and writings

// The shared log directory, created on first use
export function logDirOf(all: Record<string, unknown> | null): string {
  const dir = process.env.ALDUINAK_LOG_DIR || String(all?.["logDir"] || "") || "C:\\logs";
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* appendFile will complain */ }
  return dir;
}

export function appendLog(dir: string, file: string, text: string): void {
  try {
    fs.appendFile(path.join(dir, file), new Date().toISOString() + " " + text + "\n", () => { });
  } catch { /* log only */ }
}

// The name others see: while masked the actor name is already the placeholder (maskName, 40_chat_commands.js)
export function displayNameOf(mp: Mp, actorId: number): string {
  try { return String(mp.getActorName(actorId) || "Unknown"); } catch { return "Unknown"; }
}

// The stashed original while masked, for the audit trail only.
export function realNameOf(mp: Mp, actorId: number): string {
  let stashed = "";
  try { stashed = String(mp.get(actorId, "maskName") || "").trim(); } catch { /* unmasked */ }
  return stashed || displayNameOf(mp, actorId);
}

export function profileIdOf(mp: Mp, actorId: number): number {
  try {
    const profileId = Number(mp.get(actorId, "profileId"));
    return Number.isFinite(profileId) ? profileId : -1;
  } catch {
    return -1;
  }
}

const NEAR_MARKER_DISTANCE = 8000;

// "near <map marker>" outdoors, "in <cell>" indoors, then the raw location for a teleport
export function whereOf(mp: Mp, actorId: number): string {
  let loc: any = null;
  try { loc = mp.get(actorId, "locationalData"); } catch { /* actor gone */ }
  const desc = String(loc?.cellOrWorldDesc || "");
  const pos = Array.isArray(loc?.pos) ? (loc.pos as unknown[]).map((v) => Math.round(Number(v))) : null;
  if (!desc || !pos) return "at an unknown place";
  let place = "";
  try {
    const id = mp.getIdFromDesc(desc) >>> 0;
    const name = (globalThis as any).__alduinakItemName?.(id) || "";
    if (String(mp.lookupEspmRecordById(id)?.record?.type ?? "") === "CELL") {
      place = name ? `in ${name}` : "";
    } else {
      let best = NEAR_MARKER_DISTANCE;
      for (const m of MAP_MARKER_LOCATIONS) {
        const d = Math.hypot(m.pos[0] - pos[0], m.pos[1] - pos[1]);
        if (m.cellOrWorldDesc.toLowerCase() === desc.toLowerCase() && d < best) { best = d; place = `near ${m.name}`; }
      }
      place ||= name ? `in ${name}` : "";
    }
  } catch { /* unknown form */ }
  return `${place ? place + ", " : ""}at ${desc} (${pos.join(", ")})`;
}

// JSON-quoted real name plus a fixed-position profile id, so a crafted character name cannot forge another player's line
export function describeActor(mp: Mp, actorId: number): string {
  const real = realNameOf(mp, actorId);
  const shown = displayNameOf(mp, actorId);
  const mask = shown !== real ? ` (as ${JSON.stringify(shown)})` : "";
  return `[profile ${profileIdOf(mp, actorId)}] ${JSON.stringify(real)}${mask}`;
}

// Keeps line breaks, drops every other control character.
export function sanitize(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let out = "";
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (ch === "\n") { out += ch; continue; }
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

export function sendJson(mp: Mp, userId: number, payload: Record<string, unknown>): void {
  if (userId < 0) return;
  try { mp.sendCustomPacket(userId, JSON.stringify(payload)); } catch { /* user gone */ }
}
