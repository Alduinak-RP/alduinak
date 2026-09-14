import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { AdminTier, AdminRoleConfig, readAdminRoleConfig, adminTierOf, capForRequest } from "./adminRoles";
import { NpcSpawnSystem } from "./npcSpawnSystem";
import { MasterySystem, MAX_GRANT } from "./masterySystem";
import { kickWithReason } from "./kickUtil";
import { MAP_MARKER_LOCATIONS } from "./adminMapMarkers";
import { addItemTo, userOf } from "./actorUtil";
import { CatalogItem, ITEM_TYPES, ARMO_NON_PLAYABLE, buildItemCatalog, searchItems, normaliseQuery, normaliseKind } from "./itemCatalog";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── In-game admin (Discord-role gated) ───────────────────────────────────────
// Admins resolve to a tier (senior | developer | gm) via adminRoles.ts from "adminRoles", the legacy "adminRoleIds" and "adminProfileIds".
// Every tier gets the Admin tab of the Personal Menu (client AdminMenuService, interact key X on nothing).
// Nobody gets the server console commands (additem, equipitem, placeatme, disable, markfordelete, mp): consoleCommandsAllowed is cleared on every assign and enableConsoleCommandsForAll must stay off; the client closes the local ~ console and refuses local cheat commands for everyone (ConsoleBlockService), but that is client-side, so the checks here stay the authority.
// globalThis.__alduinakIsAdmin exposes the tier check for the gamemode's isAdminActor; consoleCommandsAllowed is never an admin signal.
// Each request needs the tier cap REQUEST_CAP names (TIER_CAPS, overridable per tier by adminTierCaps); refusals are enforced here, never in the client.
// Bans post to the backend (master key + auth token), which snapshots discordId/hwid/ip into bans.json; connection-check then refuses the player permanently.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "debugInfoRequest" }  any player, answered before the admin gate
//                     { customPacketType: "adminMenuRequest" }
//                     { customPacketType: "npcZonesRequest" }
//                     { customPacketType: "adminAction", action, target }  action: teleportTo | summon | kick | ban (target: actor id hex) | teleportLoc (target: location name)
//                     { customPacketType: "adminAction", action: "toggleMode", mode, on? }  on: the client reports a mode it already left, recorded without an echo
//                     { customPacketType: "adminAction", action: "npcZoneAdd", zone }  zone: JSON string of one NPC-Spawns.json entry
//                     { customPacketType: "adminAction", action: "npcZoneTp" | "npcZoneReset" | "npcZoneDelete" | "npcZoneActivate" | "npcZoneDeactivate", target }  target: zone name
//                     { customPacketType: "adminAction", action: "npcZonePos" }  answered with adminPos, the admin's own location
//                     { customPacketType: "adminAction", action: "masteryGrant", target, amount }  worked hours to add (negative removes), any tier, self allowed
//                     { customPacketType: "adminAction", action: "masteryReset", target }  clears the character's chosen craft and its hours
//                     { customPacketType: "adminAction", action: "itemSearch", query, kind }  kind: "" or an item record type (WEAP, ARMO, ...)
//                     { customPacketType: "adminAction", action: "itemSpawn", target, item, count }  item: catalog desc, count 1..1000, self allowed
//   Server -> Client: { customPacketType: "debugInfo", serverName, serverTime, serverTzOffsetMin, actorId, profileId }  actorId: the requester's own actor id hex
//                     { customPacketType: "adminMenu", players: [{a?, p, n, d, dn, ip, hwid, online, ping, m?}], locations: [{name, kind}], modes: [{id, label, active}], npcZones: [ZoneSummary], tier, caps: {players, teleport, modes, npcs, items, ban}, mastery }
//                       players / locations / modes / npcZones are empty without the players / teleport / modes / npcs cap
//                       m / mastery: MasterySummary {profession, label, rank, rankName, hours} of the online row / of the admin's own character
//                     { customPacketType: "adminMode", mode, on }  also re-sent for every active mode when the admin's actor is assigned; speed and freecam are sent off there and on respawn
//                     { customPacketType: "npcZones", zones: [ZoneSummary] }  after npcZonesRequest and after every zone mutation
//                     { customPacketType: "adminPos", cellOrWorldDesc, pos }  after npcZonePos; fills the Add NPC form
//                     { customPacketType: "adminItems", query, kind, ready, total, items: [{desc, name, edid, type, plugin}] }  at most 50 rows; ready is false while the catalog builds
//                     { customPacketType: "adminActionResult", ok, text }
// The roster merges online actors with the backend's full player list (GET /:key/players);
// ips are masked to the first two octets before leaving the server (full ip stays in the backend).
// Non-admin requests are ignored silently; every Personal Menu open sends adminMenuRequest, so that refusal is logged once per user slot.

const MAX_USER_SLOTS = 1024;
const PING_CACHE_MS = 3000;
const MAX_ITEM_SPAWN = 1000;
const SPAWN_COOLDOWN_MS = 250;

const ADMIN_MODES: Array<{ id: string; label: string }> = [
  { id: "god", label: "God" },
  { id: "noclip", label: "NoClip" },
  { id: "invis", label: "Invisible" },
  { id: "ghost", label: "Ghost" },
  { id: "freecam", label: "Freecam" },
  { id: "smite", label: "Smite" },
  { id: "healhit", label: "Heal on Hit" },
  { id: "speed", label: "Speed" }, // the client raises SpeedMult
];

// Modes mirrored onto the neighbors-visible ff_adminModes actor property (registered in gamemode.js)
const MIRRORED_MODES = ["god", "smite", "healhit", "invis", "ghost"];

// Modes that end on respawn and at every actor assign; the off packet makes the client undo them
const SESSION_MODES = ["speed", "freecam"];

interface TeleportLocation {
  name: string;
  kind: string; // map marker type label, blank for settings entries without one
  cellOrWorldDesc: string;
  pos: number[];
  rot: number[];
}

interface OnlinePlayer {
  userId: number;
  actorId: number;
  profileId: number;
  name: string;
}

export class AdminSystem implements System {
  systemName = "AdminSystem";
  constructor(private log: Log, private npcSpawns: NpcSpawnSystem, private mastery: MasterySystem) { }

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
  private dataDir = "";
  private loadOrder: string[] = [];
  private catalog: CatalogItem[] | null = null;
  // lower-case desc -> item
  private catalogByDesc = new Map<string, CatalogItem>();
  private catalogBuild: Promise<void> | null = null;
  private spawnAt = new Map<number, number>();

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    this.serverName = typeof s.name === "string" ? s.name : "";
    this.dataDir = s.dataDir;
    this.loadOrder = s.loadOrder;
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.roleCfg = readAdminRoleConfig(all);
    for (const warning of this.roleCfg.capWarnings) this.log(`AdminSystem: ${warning}`);
    // Configured entries first; a generated map marker never shadows a name already listed
    const configured = Array.isArray(all?.["adminTeleportLocations"]) ? all["adminTeleportLocations"] : [];
    for (const raw of [...configured, ...MAP_MARKER_LOCATIONS]) {
      const loc = this.parseLocation(ctx.svr as Mp, raw);
      if (loc && !this.locations.some(l => l.name.toLowerCase() === loc.name.toLowerCase())) this.locations.push(loc);
    }

    this.installHitRefusalHook(ctx.svr as Mp);
    this.installRespawnHook(ctx.svr as Mp);
    (globalThis as any).__alduinakIsAdmin = (actorId: number) => this.isAdminActor(ctx.svr as Mp, actorId);
    if (all?.["enableConsoleCommandsForAll"] === true) this.log("AdminSystem: enableConsoleCommandsForAll is on, so every player can run console commands; turn it off");

    // Server console commands stay off for every character; admin modes follow the admin check
    ctx.gm.on("userAssignActor", (userId: number) => {
      const mp = ctx.svr as Mp;
      try {
        const actorId = mp.getUserActor(userId);
        if (!actorId) return;
        mp.set(actorId, "consoleCommandsAllowed", false);
        this.resyncModes(mp, userId, actorId, this.isAdminActor(mp, actorId));
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
      const kind = String(raw?.kind ?? "");
      const cellOrWorldDesc = String(raw?.cellOrWorldDesc ?? "");
      const pos = Array.isArray(raw?.pos) ? raw.pos.map(Number) : null;
      const rot = Array.isArray(raw?.rot) && raw.rot.length === 3 ? raw.rot.map(Number) : [0, 0, 0];
      if (!name || !cellOrWorldDesc || !pos || pos.length !== 3 || pos.some((n: number) => !Number.isFinite(n))) {
        this.log(`AdminSystem: teleport location '${name || "?"}' skipped, needs name/cellOrWorldDesc/pos`);
        return null;
      }
      mp.getIdFromDesc(cellOrWorldDesc);
      return { name, kind, cellOrWorldDesc, pos, rot };
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

  private onlinePlayers(mp: Mp): OnlinePlayer[] {
    const out: OnlinePlayer[] = [];
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
  private buildRoster(ctx: SystemContext, myActorId: number, adminProfile: number, backendPlayers: any[]): any[] {
    const mp = ctx.svr as Mp;
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
        m: this.mastery.summaryOf(ctx, p.actorId),
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
    this.spawnAt.delete(userId);
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
    const caps = this.roleCfg.tierCaps[tier];

    let adminProfile = 0;
    try { adminProfile = Number(mp.get(myActorId, "profileId")) || 0; } catch { }

    const key = type === "adminAction" ? String(content["action"] ?? "") : type;
    const need = capForRequest(key);
    if (need === undefined) {
      this.reply(mp, userId, false, `Unknown action '${key}'`);
      return;
    }
    const missing = need && !caps[need] ? need : key === "ban" && !caps.players ? "players" : null;
    if (missing) {
      this.log(`AdminSystem: profile ${adminProfile} (${tier}) refused '${key}': no ${missing} permission`);
      this.adminLog(`profile ${adminProfile} (${tier}) was refused ${key}: no ${missing} permission`);
      this.reply(mp, userId, false, `Your rank cannot use ${missing}`);
      return;
    }

    if (type === "adminMenuRequest") {
      if (caps.items) this.ensureCatalog();
      const send = (backendPlayers: any[] | null) => {
        try {
          // The fetch outlives the packet handler; the slot must still belong to the same admin
          if (mp.getUserActor(userId) !== myActorId) return;
          mp.sendCustomPacket(userId, JSON.stringify({
            customPacketType: "adminMenu",
            players: backendPlayers ? this.buildRoster(ctx, myActorId, adminProfile, backendPlayers) : [],
            locations: caps.teleport ? this.locations.map(l => ({ name: l.name, kind: l.kind })) : [],
            modes: caps.modes ? this.modesFor(adminProfile) : [],
            npcZones: caps.npcs ? this.npcSpawns.listZones() : [],
            tier,
            caps,
            mastery: this.mastery.summaryOf(ctx, myActorId),
          }));
        } catch (e) {
          this.log(`AdminSystem: adminMenu reply failed: ${e}`);
        }
      };
      if (caps.players) this.fetchBackendRoster().then(send);
      else send(null);
      return;
    }
    if (type === "npcZonesRequest") {
      this.sendZones(mp, userId, myActorId);
      return;
    }

    const action = String(content["action"] ?? "");

    if (action === "toggleMode") {
      this.toggleMode(mp, userId, myActorId, adminProfile, String(content["mode"] ?? ""), content["on"]);
      return;
    }
    if (action.startsWith("npcZone")) {
      this.npcZoneAction(mp, userId, myActorId, adminProfile, action, content);
      return;
    }
    if (action === "itemSearch") {
      this.sendItems(mp, userId, content);
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
    // Only currently-online player actors are valid targets; the admin's own row is absent from the roster, but mastery testing may target self
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
        try { kickWithReason(mp, target.userId, "You were kicked from the server by an admin."); } catch { }
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
      } else if (action === "masteryGrant") {
        const amount = Number(content["amount"]);
        const summary = this.mastery.grantPoints(ctx, target.actorId, amount);
        if (!summary) {
          this.reply(mp, userId, false, `Hours must be a whole number between -${MAX_GRANT} and ${MAX_GRANT}`);
        } else {
          const standing = summary.label ? `${summary.rankName} ${summary.label}` : "no craft chosen";
          this.adminLog(`profile ${adminProfile} granted ${amount} mastery hour(s) to ${target.name} (profile ${target.profileId}), now ${summary.hours}h, ${standing}`);
          this.reply(mp, userId, true, `${target.name}: ${summary.hours}h, ${standing}`);
        }
      } else if (action === "masteryReset") {
        const ok = this.mastery.resetCharacter(ctx, target.actorId);
        if (ok) this.adminLog(`profile ${adminProfile} reset the craft and hours of ${target.name} (profile ${target.profileId})`);
        this.reply(mp, userId, ok, ok ? `Reset the craft and hours of ${target.name}` : `${target.name} has no craft to reset`);
      } else if (action === "itemSpawn") {
        this.spawnItem(mp, userId, myActorId, adminProfile, tier, target, content);
      } else {
        this.reply(mp, userId, false, `Unknown action '${action}'`);
      }
    } catch (e) {
      this.log(`AdminSystem: action '${action}' by profile ${adminProfile} failed: ${e}`);
      this.reply(mp, userId, false, "Action failed, see server log");
    }
  }

  // Built once in the background on first use; a failed build is retried on the next call
  private ensureCatalog(): void {
    if (this.catalog || this.catalogBuild) return;
    const started = Date.now();
    this.catalogBuild = buildItemCatalog(this.dataDir, this.loadOrder, (line) => this.log(line))
      .then(items => {
        this.catalog = items;
        this.catalogByDesc = new Map(items.map(i => [i.desc.toLowerCase(), i]));
        this.log(`AdminSystem: item catalog ${items.length} item(s) in ${Date.now() - started} ms`);
      })
      .catch(e => this.log(`AdminSystem: item catalog build failed: ${e}`))
      .finally(() => { this.catalogBuild = null; });
  }

  private sendItems(mp: Mp, userId: number, content: Content): void {
    this.ensureCatalog();
    const query = normaliseQuery(content["query"]);
    const kind = normaliseKind(content["kind"]);
    const found = this.catalog ? searchItems(this.catalog, query, kind) : { total: 0, rows: [] };
    try {
      mp.sendCustomPacket(userId, JSON.stringify({
        customPacketType: "adminItems",
        query,
        kind,
        ready: !!this.catalog,
        total: found.total,
        items: found.rows.map(({ desc, name, edid, type, plugin }) => ({ desc, name, edid, type, plugin })),
      }));
    } catch (e) {
      this.log(`AdminSystem: adminItems reply failed: ${e}`);
    }
  }

  // The catalog is the allow-list; the native record is re-checked because C++ AddItem also accepts leveled lists and form lists
  private spawnItem(mp: Mp, userId: number, myActorId: number, adminProfile: number, tier: AdminTier, target: OnlinePlayer, content: Content): void {
    const now = Date.now();
    if (now - (this.spawnAt.get(userId) ?? 0) < SPAWN_COOLDOWN_MS) return;
    this.spawnAt.set(userId, now);
    if (!this.catalog) {
      this.ensureCatalog();
      this.reply(mp, userId, false, "The item list is still loading, try again shortly");
      return;
    }
    const entry = this.catalogByDesc.get(String(content["item"] ?? "").toLowerCase());
    if (!entry) {
      this.reply(mp, userId, false, "Unknown item");
      return;
    }
    const count = Number(content["count"]);
    if (!Number.isInteger(count) || count < 1 || count > MAX_ITEM_SPAWN) {
      this.reply(mp, userId, false, `Count must be a whole number between 1 and ${MAX_ITEM_SPAWN}`);
      return;
    }
    let itemId = 0;
    let record: any = null;
    try {
      itemId = mp.getIdFromDesc(entry.desc);
      record = mp.lookupEspmRecordById(itemId)?.record;
    } catch { }
    if (!record || !ITEM_TYPES.includes(record.type) || (record.type === "ARMO" && (record.flags & ARMO_NON_PLAYABLE))) {
      this.reply(mp, userId, false, "That is not a spawnable item");
      return;
    }
    addItemTo(mp, target.actorId, itemId, count);
    const text = `profile ${adminProfile} (${tier}) spawned ${count}x ${JSON.stringify(entry.name)} [${entry.desc} ${entry.type}] for ${JSON.stringify(target.name)} (profile ${target.profileId})`;
    this.log(`AdminSystem: ${text}`);
    this.adminLog(text);
    this.reply(mp, userId, true, `Gave ${count} x ${entry.name} to ${target.actorId === myActorId ? "you" : target.name}`);
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
    if (action === "npcZoneReset" || action === "npcZoneDeactivate") {
      const reset = action === "npcZoneReset";
      const ok = reset ? this.npcSpawns.resetZone(name) : this.npcSpawns.deactivateZone(name);
      if (ok) this.adminLog(`profile ${adminProfile} ${reset ? "reset" : "deactivated"} npc zone '${name}'`);
      this.reply(mp, userId, ok, !ok ? "Unknown zone" : reset ? `Reset zone ${name}` : `Deactivated zone ${name}, respawn timer started`);
      if (ok) this.sendZones(mp, userId, myActorId);
      return;
    }
    if (action === "npcZoneActivate") {
      const placed = this.npcSpawns.activateZone(name, myActorId);
      if (placed === null) {
        this.reply(mp, userId, false, "Unknown zone");
        return;
      }
      this.adminLog(`profile ${adminProfile} activated npc zone '${name}', ${placed} npc(s) placed`);
      this.reply(mp, userId, placed > 0, placed ? `Activated zone ${name}, ${placed} NPC(s) placed` : `Nothing placed in ${name}: every NPC is alive or the spawn failed (server log)`);
      this.sendZones(mp, userId, myActorId);
      return;
    }
    if (action === "npcZonePos") {
      try {
        const loc = mp.get(myActorId, "locationalData");
        const pos = (loc.pos as number[]).map(v => Math.round(v * 100) / 100);
        mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminPos", cellOrWorldDesc: loc.cellOrWorldDesc, pos }));
      } catch (e) {
        this.log(`AdminSystem: npcZonePos by profile ${adminProfile} failed: ${e}`);
        this.reply(mp, userId, false, "Position unavailable, see server log");
      }
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

  private toggleMode(mp: Mp, userId: number, actorId: number, adminProfile: number, mode: string, reported: unknown): void {
    if (!ADMIN_MODES.some(m => m.id === mode)) {
      this.reply(mp, userId, false, `Unknown mode '${mode}'`);
      return;
    }
    const state = this.modesByProfile.get(adminProfile) ?? {};
    state[mode] = typeof reported === "boolean" ? reported : !state[mode];
    this.modesByProfile.set(adminProfile, state);
    const on = !!state[mode];
    if (MIRRORED_MODES.includes(mode)) this.writeModeMirror(mp, actorId, state);
    if (typeof reported !== "boolean") this.sendMode(mp, userId, mode, on);
    this.adminLog(`profile ${adminProfile} turned mode ${mode} ${on ? "on" : "off"}${typeof reported === "boolean" ? " (client report)" : ""}`);
  }

  // Registration lives in gamemode.js; a missing property must not break the toggle
  private writeModeMirror(mp: Mp, actorId: number, state: Record<string, boolean>): void {
    try {
      const mirror: Record<string, boolean> = {};
      for (const m of MIRRORED_MODES) mirror[m] = !!state[m];
      mp.set(actorId, "ff_adminModes", mirror);
    } catch (e) {
      this.log(`AdminSystem: ff_adminModes mirror failed (property registered in gamemode.js?): ${e}`);
    }
  }

  private sendMode(mp: Mp, userId: number, mode: string, on: boolean): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMode", mode, on }));
    } catch { }
  }

  private profileOf(mp: Mp, actorId: number): number {
    try { return Number(mp.get(actorId, "profileId")) || 0; } catch { return 0; }
  }

  // Modes live in memory per profile but the mirror persists on the actor; re-push them on assign and clear a stale mirror
  private resyncModes(mp: Mp, userId: number, actorId: number, isAdmin: boolean): void {
    const profileId = this.profileOf(mp, actorId);
    // A character switch keeps the connection, so only these off packets make the client undo speed and freecam
    this.endSessionModes(mp, userId, profileId, "actor assign");
    if (!isAdmin) this.modesByProfile.delete(profileId);
    const state = this.modesByProfile.get(profileId) ?? {};
    let mirror: Record<string, unknown> | null = null;
    try { mirror = mp.get(actorId, "ff_adminModes") ?? null; } catch { }
    if (MIRRORED_MODES.some(m => !!mirror?.[m] !== !!state[m])) this.writeModeMirror(mp, actorId, state);
    for (const m of ADMIN_MODES) {
      if (state[m.id]) this.sendMode(mp, userId, m.id, true);
    }
  }

  // C++ fires onHitDamageAttempt before applying weapon and spell damage; returning false refuses it
  private installHitRefusalHook(mp: Mp): void {
    const previous = typeof mp.onHitDamageAttempt === "function" ? mp.onHitDamageAttempt : null;
    mp.onHitDamageAttempt = (aggressorId: number, targetId: number, sourceId: number, damage: number): boolean => {
      if (this.hasMode(mp, targetId, "god") || this.hasMode(mp, targetId, "ghost")) return false;
      if (!previous) return true;
      try {
        return previous.call(mp, aggressorId, targetId, sourceId, damage) !== false;
      } catch {
        return true;
      }
    };
  }

  private installRespawnHook(mp: Mp): void {
    const previous = typeof mp.onRespawn === "function" ? mp.onRespawn : null;
    mp.onRespawn = (...args: unknown[]) => {
      const result = previous ? previous.apply(mp, args) : undefined;
      try {
        const actorId = Number(args[0]) >>> 0;
        this.endSessionModes(mp, userOf(mp, actorId), this.profileOf(mp, actorId), "respawn");
      } catch (e) {
        this.log(`AdminSystem: mode reset on respawn failed: ${e}`);
      }
      return result;
    };
  }

  private endSessionModes(mp: Mp, userId: number, profileId: number, reason: string): void {
    const state = this.modesByProfile.get(profileId);
    for (const mode of SESSION_MODES) {
      if (!state?.[mode]) continue;
      delete state[mode];
      if (userId >= 0) this.sendMode(mp, userId, mode, false);
      this.log(`AdminSystem: profile ${profileId} mode ${mode} off on ${reason}`);
    }
  }

  private hasMode(mp: Mp, actorId: number, mode: string): boolean {
    if (this.modesByProfile.size === 0) return false;
    const profileId = this.profileOf(mp, actorId);
    return profileId > 0 && !!this.modesByProfile.get(profileId)?.[mode];
  }

  private banViaBackend(
    mp: Mp,
    ctx: SystemContext,
    userId: number,
    adminActorId: number,
    target: OnlinePlayer,
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
        try { kickWithReason(mp, target.userId, "You were banned from the server."); } catch { }
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
