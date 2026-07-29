import * as crypto from "crypto";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── Proximity voice chat (LiveKit) ───────────────────────────────────────────
//
// The client asks for a room token after login; the server mints a LiveKit
// HS256 access token whose identity is the player's server-side actor id in
// hex. Other clients already know every remote player's refrId, so they match
// LiveKit participants to actors (and gate volume by distance) without any
// extra identity sync. Minting server-side means identities cannot be spoofed.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "voiceTokenRequest" }
//   Server -> Client: { customPacketType: "voiceToken", enabled, url?, token?,
//                       room?, identity?, rangeUnits? }
//
// Settings (server-settings.json "voiceChat" object):
//   { "enabled": true, "url": "ws://host:7880", "apiKey": "...",
//     "apiSecret": "...", "room": "alduinak", "rangeUnits": 2000 }
// rangeUnits falls back to chatRanges.say, then 2000 game units.

// Short on purpose: LiveKit refreshes tokens over live connections, and a
// kicked/banned player's credential dies with the TTL (no admin-API revocation)
const TOKEN_TTL_SECONDS = 60 * 60;

function b64url(input: Buffer | string): string {
  return (typeof input === "string" ? Buffer.from(input) : input).toString("base64url");
}

// Hand-minted LiveKit access token; the payload shape matches livekit-server-sdk.
function mintLiveKitToken(apiKey: string, apiSecret: string, identity: string, room: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    iss: apiKey,
    sub: identity,
    jti: identity,
    iat: now,
    nbf: now - 10,
    exp: now + TOKEN_TTL_SECONDS,
    name: identity,
    video: { roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true },
  };
  const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.createHmac("sha256", apiSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export class VoiceSystem implements System {
  systemName = "VoiceSystem";
  constructor(private log: Log) { }

  private enabled = false;
  private url = "";
  private apiKey = "";
  private apiSecret = "";
  private room = "alduinak";
  // Voice modes cycled in-game with Alt+V. Units are game units (70 per meter):
  // whisper 2m, talk 12m, shout 45m by default.
  private modes: Array<{ key: string; label: string; units: number }> = [
    { key: "whisper", label: "Whisper", units: 140 },
    { key: "talk", label: "Talk", units: 840 },
    { key: "shout", label: "Shout", units: 3150 },
  ];

  async initAsync(_ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const vc = all?.["voiceChat"];
    if (!vc || typeof vc !== "object") {
      this.log("VoiceSystem: no voiceChat settings, voice disabled");
      return;
    }
    this.url = typeof vc.url === "string" ? vc.url : "";
    this.apiKey = typeof vc.apiKey === "string" ? vc.apiKey : "";
    this.apiSecret = typeof vc.apiSecret === "string" ? vc.apiSecret : "";
    if (typeof vc.room === "string" && vc.room) this.room = vc.room;

    // Optional override: voiceChat.modes = [{ key, label, meters }]
    if (Array.isArray(vc.modes) && vc.modes.length) {
      const parsed: Array<{ key: string; label: string; units: number }> = [];
      for (const m of vc.modes) {
        const key = String(m?.key ?? "");
        const meters = Number(m?.meters);
        const units = Number.isFinite(meters) && meters > 0 ? meters * 70 : Number(m?.units);
        if (key && Number.isFinite(units) && units > 0) {
          parsed.push({ key, label: String(m?.label ?? key), units: Math.round(units) });
        }
      }
      if (parsed.length) this.modes = parsed;
    }

    this.enabled = vc.enabled !== false && !!(this.url && this.apiKey && this.apiSecret);
    const modeDesc = this.modes.map(m => `${m.label} ${Math.round(m.units / 70)}m`).join(", ");
    this.log(`VoiceSystem: ${this.enabled ? `enabled, room '${this.room}', modes: ${modeDesc}` : "disabled (missing url/apiKey/apiSecret or enabled=false)"}`);
  }

  customPacket(userId: number, type: string, _content: Content, ctx: SystemContext): void {
    if (type !== "voiceTokenRequest") return;
    const mp = ctx.svr as Mp;
    if (!this.enabled) {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "voiceToken", enabled: false }));
      return;
    }
    let actorId = 0;
    try { actorId = mp.getUserActor(userId); } catch { }
    if (!actorId) return; // not spawned yet; the client re-requests after assign
    const identity = actorId.toString(16);
    try {
      const token = mintLiveKitToken(this.apiKey, this.apiSecret, identity, this.room);
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "voiceToken",
        enabled: true,
        url: this.url,
        token,
        room: this.room,
        identity,
        modes: this.modes,
      }));
    } catch (e) {
      this.log(`VoiceSystem: token mint failed for user ${userId}: ${e}`);
    }
  }
}
