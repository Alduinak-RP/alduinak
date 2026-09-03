import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { AdminTier, AdminRoleConfig, TIER_CAPS, readAdminRoleConfig, adminTierOf } from "./adminRoles";
import { NpcSpawnSystem } from "./npcSpawnSystem";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── In-game admin (Discord-role gated) ───────────────────────────────────────
// Admins resolve to a tier (senior | developer | gm) via adminRoles.ts from "adminRoles", the legacy "adminRoleIds" and "adminProfileIds".
// Every tier gets the server console (consoleCommandsAllowed per assign; keep enableConsoleCommandsForAll OFF) and the tabbed admin panel (client AdminMenuService, Insert key).
// Only tiers with TIER_CAPS.ban may ban; the refusal is enforced here, never in the client.
// Bans post to the backend (master key + auth token), which snapshots discordId/hwid/ip into bans.json; connection-check then refuses the player permanently.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "debugInfoRequest" }  any player, answered before the admin gate
//                     { customPacketType: "adminMenuRequest" }
//                     { customPacketType: "npcZonesRequest" }
//                     { customPacketType: "adminAction", action, target }  action: teleportTo | summon | kick | ban (target: actor id hex) | teleportLoc (target: location name)
//                     { customPacketType: "adminAction", action: "toggleMode", mode }
//                     { customPacketType: "adminAction", action: "npcZoneAdd", zone }  zone: JSON string of one NPC-Spawns.json entry
//                     { customPacketType: "adminAction", action: "npcZoneTp" | "npcZoneReset" | "npcZoneDelete", target }  target: zone name
//   Server -> Client: { customPacketType: "debugInfo", serverName, serverTime, serverTzOffsetMin, actorId, profileId }  actorId: the requester's own actor id hex
//                     { customPacketType: "adminMenu", players: [{a?, p, n, d, dn, ip, hwid, online, ping}], locations: [{name}], modes: [{id, label, active}], npcZones: [ZoneSummary], tier, caps: {ban} }
//                     { customPacketType: "adminMode", mode, on }
//                     { customPacketType: "npcZones", zones: [ZoneSummary] }  after npcZonesRequest and after every zone mutation
//                     { customPacketType: "adminActionResult", ok, text }
// The roster merges online actors with the backend's full player list (GET /:key/players);
// ips are masked to the first two octets before leaving the server (full ip stays in the backend).
// Non-admin requests are ignored silently; every Insert press sends adminMenuRequest, so that refusal is logged once per user slot.

const MAX_USER_SLOTS = 1024;
const PING_CACHE_MS = 3000;

const ADMIN_MODES: Array<{ id: string; label: string }> = [
  { id: "god", label: "God" },
  { id: "noclip", label: "NoClip" },
  { id: "invis", label: "Invisible" },
  { id: "ghost", label: "Ghost" },
  { id: "freecam", label: "Freecam" },
  { id: "smite", label: "Smite" },
  { id: "healhit", label: "Heal on Hit" },
];

// Modes mirrored onto the neighbors-visible ff_adminModes actor property (registered in gamemode.js)
const MIRRORED_MODES = ["god", "smite", "healhit", "invis"];

interface TeleportLocation {
  name: string;
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

export class AdminSystem implements System {
  systemName = "AdminSystem";
  constructor(private log: Log, private npcSpawns: NpcSpawnSystem) { }

  private roleCfg: AdminRoleConfig = readAdminRoleConfig(null);
  private masterUrl = "";
  private masterKey = "";
  private authToken = "";
  private locations: TeleportLocation[] = [];
  private modesByProfile = new Map<number, Record<string, boolean>>();
  private pingCache = new Map<number, number>();
  private pingCacheAt = 0;
  private serverName = "";
  private menuRefusalLogged = new Set<number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    this.serverName = typeof s.name === "string" ? s.name : "";
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.roleCfg = readAdminRoleConfig(all);
    if (Array.isArray(all?.["adminTeleportLocations"])) {
      const mp = ctx.svr as Mp;
      for (const raw of all["adminTeleportLocations"]) {
        const loc = this.parseLocation(mp, raw);
        if (loc) this.locations.push(loc);
      }
    }

    // Console rights follow the admin check on every actor assignment
    ctx.gm.on("userAssignActor", (userId: number) => {
      const mp = ctx.svr as Mp;
      try {
        const actorId = mp.getUserActor(userId);
        if (!actorId) return;
        const tier = this.tierOf(mp, actorId);
        mp.set(actorId, "consoleCommandsAllowed", tier !== null);
        if (tier) this.log(`AdminSystem: console granted to actor ${actorId.toString(16)} (${tier})`);
      } catch (e) {
        this.log(`AdminSystem: assign hook failed: ${e}`);
      }
    });

    const { tierRoles, adminRoleIds, adminProfileIds } = this.roleCfg;
    this.log(`AdminSystem: tier roles senior ${tierRoles.senior.length} / developer ${tierRoles.developer.length} / gm ${tierRoles.gm.length}, ${adminRoleIds.length} legacy admin role(s), ${adminProfileIds.length} admin profile(s), ${this.locations.length} teleport location(s)`);
  }

  // Validated like npcSpawnSystem zones; bad descs are dropped at boot
  private parseLocation(mp: Mp, raw: any): TeleportLocation | null {
    try {
      const name = String(raw?.name ?? "");
      const cellOrWorldDesc = String(raw?.cellOrWorldDesc ?? "");
      const pos = Array.isArray(raw?.pos) ? raw.pos.map(Number) : null;
      const rot = Array.isArray(raw?.rot) && raw.rot.length === 3 ? raw.rot.map(Number) : [0, 0, 0];
      if (!name || !cellOrWorldDesc || !pos || pos.length !== 3 || pos.some((n: number) => !Number.isFinite(n))) {
        this.log(`AdminSystem: teleport location '${name || "?"}' skipped, needs name/cellOrWorldDesc/pos`);
        return null;
      }
      mp.getIdFromDesc(cellOrWorldDesc);
      return { name, cellOrWorldDesc, pos, rot };
    } catch (e) {
      this.log(`AdminSystem: bad teleport location skipped: ${e}`);
      return null;
    }
  }

  private tierOf(mp: Mp, actorId: number): AdminTier | null {
    return adminTierOf(mp, actorId, this.roleCfg);
  }

  private isAdminActor(mp: Mp, actorId: number): boolean {
    return this.tierOf(mp, actorId) !== null;
  }

  private onlinePlayers(mp: Mp): Array<{ userId: number; actorId: number; profileId: number; name: string }> {
    const out: Array<{ userId: number; actorId: number; profileId: number; name: string }> = [];
    for (let userId = 0; userId < MAX_USER_SLOTS; userId++) {
      try { if (!mp.isConnected(userId)) continue; } catch { continue; }
      let actorId = 0;
      try { actorId = mp.getUserActor(userId); } catch { continue; }
      if (!actorId) continue;
      let name = "";
      try { name = String(mp.get(actorId, "appearance")?.name ?? ""); } catch { }
      let profileId = 0;
      try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { }
      out.push({ userId, actorId, profileId, name });
    }
    return out;
  }

  // Per-slot ping in ms parsed from the prometheus text; cached to match the C++ update period
  private pings(mp: Mp): Map<number, number> {
    const now = Date.now();
    if (now - this.pingCacheAt < PING_CACHE_MS) return this.pingCache;
    this.pingCache = new Map();
    this.pingCacheAt = now;
    try {
      const text = String(mp.getPrometheusMetrics() ?? "");
      const re = /skymp_server_ping_per_slot_seconds\{networking_user_id="(\d+)"\}\s+([0-9.eE+-]+)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        this.pingCache.set(Number(m[1]), Math.round(Number(m[2]) * 1000));
      }
    } catch { }
    return this.pingCache;
  }

  // In-game ip display conflicts with hideIpRoleId; only the first two octets leave the server
  private maskIp(ip: unknown): string {
    const text = String(ip ?? "").trim();
    if (!text) return "";
    const parts = text.split(".");
    if (parts.length !== 4) return "x.x.x.x";
    return `${parts[0]}.${parts[1]}.x.x`;
  }

  private async fetchBackendRoster(): Promise<any[]> {
    if (!this.masterUrl || !this.masterKey || !this.authToken) return [];
    try {
      const res = await fetch(`${this.masterUrl}/api/servers/${this.masterKey}/players`, {
        headers: { "X-Auth-Token": this.authToken },
      });
      if (!res.ok) {
        this.log(`AdminSystem: backend roster fetch failed with status ${res.status}`);
        return [];
      }
      const body: any = await res.json();
      return Array.isArray(body?.players) ? body.players : [];
    } catch (e) {
      this.log(`AdminSystem: backend roster fetch failed: ${e}`);
      return [];
    }
  }

  // Offline backend records merged with live actors; online rows win their profile slot
  private buildRoster(mp: Mp, myActorId: number, adminProfile: number, backendPlayers: any[]): any[] {
    const pings = this.pings(mp);
    const byProfile = new Map<number, any>();
    for (const raw of backendPlayers) {
      const profileId = Number(raw?.profileId);
      if (!Number.isFinite(profileId) || profileId <= 0) continue;
      byProfile.set(profileId, {
        p: profileId,
        n: "",
        d: String(raw?.discordId ?? ""),
        dn: String(raw?.displayName || raw?.username || ""),
        ip: this.maskIp(raw?.lastIp),
        hwid: String(raw?.hwid ?? ""),
        online: false,
        ping: null,
      });
    }
    const extra: any[] = [];
    for (const p of this.onlinePlayers(mp)) {
      if (p.actorId === myActorId) continue;
      const base = byProfile.get(p.profileId);
      let discordId = "";
      try { discordId = String(mp.get(p.actorId, "private.skympDiscordId") ?? ""); } catch { }
      if (!discordId) {
        try { discordId = String(mp.get(p.actorId, "private.indexed.discordId") ?? ""); } catch { }
      }
      let ip = "";
      try { ip = String(mp.getUserIp(p.userId) ?? ""); } catch { }
      let guid = "";
      try { guid = String(mp.getUserGuid(p.userId) ?? ""); } catch { }
      const row = {
        a: p.actorId.toString(16),
        p: p.profileId,
        n: p.name || "(no name)",
        d: discordId || (base ? base.d : ""),
        dn: base ? base.dn : "",
        ip: this.maskIp(ip) || (base ? base.ip : ""),
        hwid: (base && base.hwid) ? base.hwid : guid,
        online: true,
        ping: pings.get(p.userId) ?? null,
      };
      if (p.profileId > 0) byProfile.set(p.profileId, row);
      else extra.push(row);
    }
    byProfile.delete(adminProfile);
    const rows = Array.from(byProfile.values()).concat(extra);
    rows.sort((a, b) => (a.online === b.online) ? a.p - b.p : (a.online ? -1 : 1));
    return rows;
  }

  private modesFor(adminProfile: number): Array<{ id: string; label: string; active: boolean }> {
    const state = this.modesByProfile.get(adminProfile) ?? {};
    return ADMIN_MODES.map(m => ({ id: m.id, label: m.label, active: !!state[m.id] }));
  }

  private reply(mp: Mp, userId: number, ok: boolean, text: string): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminActionResult", ok, text }));
    } catch { }
  }

  // Routes into the gamemode's admin.log + staff channel when loaded
  private adminLog(text: string): void {
    try { (globalThis as any).__alduinakAdminLog?.(text); } catch { }
  }

  // Any player with an actor may ask; the reply carries nothing about other players
  private sendDebugInfo(mp: Mp, userId: number): void {
    let actorId = 0;
    try { actorId = mp.getUserActor(userId); } catch { }
    if (!actorId) return;
    let profileId = 0;
    try { profileId = Number(mp.get(actorId, "profileId")) || 0; } catch { }
    try {
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "debugInfo",
        serverName: this.serverName,
        serverTime: Date.now(),
        serverTzOffsetMin: new Date().getTimezoneOffset(),
        actorId: actorId.toString(16),
        profileId,
      }));
    } catch (e) {
      this.log(`AdminSystem: debugInfo reply failed: ${e}`);
    }
  }

  // Slots are reused, so the next player in this slot gets the refusal diagnostic again
  disconnect(userId: number): void {
    this.menuRefusalLogged.delete(userId);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === "debugInfoRequest") {
      this.sendDebugInfo(ctx.svr as Mp, userId);
      return;
    }
    if (type !== "adminMenuRequest" && type !== "adminAction" && type !== "npcZonesRequest") return;
    const mp = ctx.svr as Mp;
    let myActorId = 0;
    try { myActorId = mp.getUserActor(userId); } catch { }
    if (!myActorId || !this.isAdminActor(mp, myActorId)) {
      if (type === "adminMenuRequest" && myActorId) {
        if (this.menuRefusalLogged.has(userId)) return;
        this.menuRefusalLogged.add(userId);
      }
      // Log the actor's real roles so a misconfigured adminRoleIds is diagnosable from the game
      let roles: unknown = [];
      try { roles = mp.get(myActorId, "private.discordRoles"); } catch { }
      this.log(`AdminSystem: refused '${type}' from actor ${myActorId.toString(16)} (not an admin). Their roles: ${JSON.stringify(roles)}. Configured: ${JSON.stringify({ ...this.roleCfg.tierRoles, legacy: this.roleCfg.adminRoleIds })}`);
      return;
    }
    const tier = this.tierOf(mp, myActorId) as AdminTier;
    const caps = TIER_CAPS[tier];

    let adminProfile = 0;
    try { adminProfile = Number(mp.get(myActorId, "profileId")) || 0; } catch { }

    if (type === "adminMenuRequest") {
      this.fetchBackendRoster().then(backendPlayers => {
        try {
          // The fetch outlives the packet handler; the slot must still belong to the same admin
          if (mp.getUserActor(userId) !== myActorId) return;
          mp.sendCustomPacket(userId, JSON.stringify({
            customPacketType: "adminMenu",
            players: this.buildRoster(mp, myActorId, adminProfile, backendPlayers),
            locations: this.locations.map(l => ({ name: l.name })),
            modes: this.modesFor(adminProfile),
            npcZones: this.npcSpawns.listZones(),
            tier,
            caps,
          }));
        } catch (e) {
          this.log(`AdminSystem: adminMenu reply failed: ${e}`);
        }
      });
      return;
    }
    if (type === "npcZonesRequest") {
      this.sendZones(mp, userId, myActorId);
      return;
    }

    const action = String(content["action"] ?? "");

    if (action === "toggleMode") {
      this.toggleMode(mp, userId, myActorId, adminProfile, String(content["mode"] ?? ""));
      return;
    }
    if (action.startsWith("npcZone")) {
      this.npcZoneAction(mp, userId, myActorId, adminProfile, action, content);
      return;
    }
    if (action === "teleportLoc") {
      const name = String(content["target"] ?? "");
      const loc = this.locations.find(l => l.name === name);
      if (!loc) {
        this.reply(mp, userId, false, "Unknown location");
        return;
      }
      try {
        mp.set(myActorId, "locationalData", { cellOrWorldDesc: loc.cellOrWorldDesc, pos: loc.pos, rot: loc.rot });
        this.adminLog(`profile ${adminProfile} teleported to location '${loc.name}'`);
        this.reply(mp, userId, true, `Teleported to ${loc.name}`);
      } catch (e) {
        this.log(`AdminSystem: teleportLoc '${name}' by profile ${adminProfile} failed: ${e}`);
        this.reply(mp, userId, false, "Teleport failed, see server log");
      }
      return;
    }

    const targetId = parseInt(String(content["target"] ?? ""), 16);
    // Only currently-online player actors are valid targets
    const target = this.onlinePlayers(mp).find(p => p.actorId === targetId);
    if (!target) {
      this.reply(mp, userId, false, "Target is no longer online");
      return;
    }

    try {
      if (action === "teleportTo") {
        mp.set(myActorId, "locationalData", mp.get(target.actorId, "locationalData"));
        this.adminLog(`profile ${adminProfile} teleported to ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Teleported to ${target.name}`);
      } else if (action === "summon") {
        mp.set(target.actorId, "locationalData", mp.get(myActorId, "locationalData"));
        this.adminLog(`profile ${adminProfile} summoned ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Summoned ${target.name}`);
      } else if (action === "kick") {
        // Disable boots to the menu; kick drops the connection so they can't re-enter from character select
        ctx.svr.setEnabled(target.actorId, false);
        try { (ctx.svr as Mp).kick(target.userId); } catch { }
        this.log(`AdminSystem: profile ${adminProfile} kicked profile ${target.profileId} (${target.name})`);
        this.adminLog(`profile ${adminProfile} kicked ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, true, `Kicked ${target.name}`);
      } else if (action === "ban") {
        if (!caps.ban) {
          this.log(`AdminSystem: profile ${adminProfile} (${tier}) refused a ban on profile ${target.profileId} (${target.name})`);
          this.adminLog(`profile ${adminProfile} (${tier}) was refused a ban on ${target.name} (profile ${target.profileId})`);
          this.reply(mp, userId, false, "Your rank cannot ban players");
        } else {
          this.banViaBackend(mp, ctx, userId, myActorId, target, adminProfile, tier);
        }
      } else {
        this.reply(mp, userId, false, `Unknown action '${action}'`);
      }
    } catch (e) {
      this.log(`AdminSystem: action '${action}' by profile ${adminProfile} failed: ${e}`);
      this.reply(mp, userId, false, "Action failed, see server log");
    }
  }

  // Every tier may manage NPC zones; the slot must still belong to the admin because add/delete finish asynchronously
  private sendZones(mp: Mp, userId: number, adminActorId: number): void {
    try {
      if (mp.getUserActor(userId) !== adminActorId) return;
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "npcZones", zones: this.npcSpawns.listZones() }));
    } catch (e) {
      this.log(`AdminSystem: npcZones reply failed: ${e}`);
    }
  }

  private npcZoneAction(mp: Mp, userId: number, myActorId: number, adminProfile: number, action: string, content: Content): void {
    const name = String(content["target"] ?? "");
    if (action === "npcZoneAdd") {
      let raw: unknown;
      try { raw = JSON.parse(String(content["zone"] ?? "")); } catch { raw = null; }
      if (!raw || typeof raw !== "object") {
        this.reply(mp, userId, false, "Bad zone data");
        return;
      }
      const zoneName = String((raw as Record<string, unknown>)["Name"] ?? "");
      this.npcSpawns.addZone(raw).then(err => {
        if (!err) this.adminLog(`profile ${adminProfile} added npc zone '${zoneName}'`);
        this.replyIfSameAdmin(mp, userId, myActorId, !err, err ?? `Added zone ${zoneName}`);
        if (!err) this.sendZones(mp, userId, myActorId);
      }).catch(e => {
        this.log(`AdminSystem: npcZoneAdd by profile ${adminProfile} failed: ${e}`);
        this.replyIfSameAdmin(mp, userId, myActorId, false, "Action failed, see server log");
      });
      return;
    }
    if (action === "npcZoneDelete") {
      this.npcSpawns.deleteZone(name).then(ok => {
        if (ok) this.adminLog(`profile ${adminProfile} deleted npc zone '${name}'`);
        this.replyIfSameAdmin(mp, userId, myActorId, ok, ok ? `Deleted zone ${name}` : "Unknown zone");
        if (ok) this.sendZones(mp, userId, myActorId);
      }).catch(e => {
        this.log(`AdminSystem: npcZoneDelete '${name}' by profile ${adminProfile} failed: ${e}`);
        this.replyIfSameAdmin(mp, userId, myActorId, false, "Action failed, see server log");
      });
      return;
    }
    if (action === "npcZoneReset") {
      const ok = this.npcSpawns.resetZone(name);
      if (ok) this.adminLog(`profile ${adminProfile} reset npc zone '${name}'`);
      this.reply(mp, userId, ok, ok ? `Reset zone ${name}` : "Unknown zone");
      if (ok) this.sendZones(mp, userId, myActorId);
      return;
    }
    if (action === "npcZoneTp") {
      const target = this.npcSpawns.teleportTarget(name);
      if (!target) {
        this.reply(mp, userId, false, "Unknown zone");
        return;
      }
      try {
        mp.set(myActorId, "locationalData", { cellOrWorldDesc: target.cellOrWorldDesc, pos: target.pos, rot: [0, 0, 0] });
        this.adminLog(`profile ${adminProfile} teleported to npc zone '${name}'`);
        this.reply(mp, userId, true, `Teleported to ${name}`);
      } catch (e) {
        this.log(`AdminSystem: npcZoneTp '${name}' by profile ${adminProfile} failed: ${e}`);
        this.reply(mp, userId, false, "Teleport failed, see server log");
      }
      return;
    }
    this.reply(mp, userId, false, `Unknown action '${action}'`);
  }

  private toggleMode(mp: Mp, userId: number, actorId: number, adminProfile: number, mode: string): void {
    if (!ADMIN_MODES.some(m => m.id === mode)) {
      this.reply(mp, userId, false, `Unknown mode '${mode}'`);
      return;
    }
    const state = this.modesByProfile.get(adminProfile) ?? {};
    state[mode] = !state[mode];
    this.modesByProfile.set(adminProfile, state);
    const on = !!state[mode];
    if (MIRRORED_MODES.includes(mode)) {
      // Registration lives in gamemode.js; a missing property must not break the toggle
      try {
        const mirror: Record<string, boolean> = {};
        for (const m of MIRRORED_MODES) mirror[m] = !!state[m];
        mp.set(actorId, "ff_adminModes", mirror);
      } catch (e) {
        this.log(`AdminSystem: ff_adminModes mirror failed (property registered in gamemode.js?): ${e}`);
      }
    }
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMode", mode, on }));
    } catch { }
    this.adminLog(`profile ${adminProfile} turned mode ${mode} ${on ? "on" : "off"}`);
  }

  private banViaBackend(
    mp: Mp,
    ctx: SystemContext,
    userId: number,
    adminActorId: number,
    target: { userId: number; actorId: number; profileId: number; name: string },
    adminProfile: number,
    tier: AdminTier
  ): void {
    if (!this.masterUrl || !this.masterKey || !this.authToken) {
      this.reply(mp, userId, false, "Ban unavailable: master api not configured");
      return;
    }
    if (!target.profileId) {
      this.reply(mp, userId, false, "Ban unavailable: target has no profile id");
      return;
    }
    fetch(`${this.masterUrl}/api/servers/${this.masterKey}/ban`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": this.authToken },
      body: JSON.stringify({
        profileId: target.profileId,
        reason: "in-game admin ban",
        bannedBy: `profile ${adminProfile} (${tier})`,
      }),
    }).then(res => {
      if (res.ok) {
        // Boot AND drop the connection; connection-check refuses the reconnect
        try { ctx.svr.setEnabled(target.actorId, false); } catch { }
        try { (ctx.svr as Mp).kick(target.userId); } catch { }
        this.log(`AdminSystem: profile ${adminProfile} (${tier}) banned profile ${target.profileId} (${target.name})`);
        this.adminLog(`profile ${adminProfile} (${tier}) banned ${target.name} (profile ${target.profileId})`);
        this.replyIfSameAdmin(mp, userId, adminActorId, true, `Banned ${target.name}`);
      } else {
        this.log(`AdminSystem: backend ban failed with status ${res.status}`);
        this.replyIfSameAdmin(mp, userId, adminActorId, false, `Ban failed (backend ${res.status})`);
      }
    }).catch(e => {
      this.log(`AdminSystem: backend ban request failed: ${e}`);
      this.replyIfSameAdmin(mp, userId, adminActorId, false, "Ban failed: backend unreachable");
    });
  }

  // The HTTP round-trip outlives the packet handler; verify the userId slot still belongs to the same admin before sending the toast
  private replyIfSameAdmin(mp: Mp, userId: number, adminActorId: number, ok: boolean, text: string): void {
    try {
      if (mp.getUserActor(userId) !== adminActorId) return;
    } catch {
      return;
    }
    this.reply(mp, userId, ok, text);
  }
}
