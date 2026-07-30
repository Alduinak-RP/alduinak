import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// ── In-game admin (Discord-role gated) ───────────────────────────────────────
// Admins: players with any Discord role in "adminRoleIds" or a profile id in "adminProfileIds".
// They get the server console (consoleCommandsAllowed per assign; keep enableConsoleCommandsForAll OFF) and the admin menu (client AdminMenuService, Insert key): teleport to / summon / kick / ban.
// Bans post to the backend (master key + auth token), which snapshots discordId/hwid/ip into bans.json; connection-check then refuses the player permanently.
//
// Wire protocol (CustomPacket JSON):
//   Client -> Server: { customPacketType: "adminMenuRequest" }
//                     { customPacketType: "adminAction", action, target }  action: teleportTo | summon | kick | ban, target: actor id hex
//   Server -> Client: { customPacketType: "adminMenu", players: [{a, p, n}] }
//                     { customPacketType: "adminActionResult", ok, text }
// Non-admin requests are ignored silently.

const MAX_USER_SLOTS = 1024;

export class AdminSystem implements System {
  systemName = "AdminSystem";
  constructor(private log: Log) { }

  private adminRoleIds: string[] = [];
  private adminProfileIds: number[] = [];
  private masterUrl = "";
  private masterKey = "";
  private authToken = "";

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    this.masterUrl = typeof s.master === "string" ? s.master.replace(/\/+$/, "") : "";
    this.masterKey = typeof s.masterKey === "string" ? s.masterKey : "";
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    if (Array.isArray(all?.["adminRoleIds"])) {
      this.adminRoleIds = all["adminRoleIds"].map(String);
    }
    if (Array.isArray(all?.["adminProfileIds"])) {
      this.adminProfileIds = all["adminProfileIds"].map(Number).filter(Number.isFinite);
    }

    // Console rights follow the admin check on every actor assignment
    ctx.gm.on("userAssignActor", (userId: number) => {
      const mp = ctx.svr as Mp;
      try {
        const actorId = mp.getUserActor(userId);
        if (!actorId) return;
        const allowed = this.isAdminActor(mp, actorId);
        mp.set(actorId, "consoleCommandsAllowed", allowed);
        if (allowed) this.log(`AdminSystem: console granted to actor ${actorId.toString(16)}`);
      } catch (e) {
        this.log(`AdminSystem: assign hook failed: ${e}`);
      }
    });

    this.log(`AdminSystem: ${this.adminRoleIds.length} admin role(s), ${this.adminProfileIds.length} admin profile(s)`);
  }

  private isAdminActor(mp: Mp, actorId: number): boolean {
    try {
      const roles = mp.get(actorId, "private.discordRoles");
      if (Array.isArray(roles) && roles.some((r: unknown) => this.adminRoleIds.includes(String(r)))) {
        return true;
      }
    } catch { }
    try {
      const profileId = Number(mp.get(actorId, "profileId"));
      if (this.adminProfileIds.includes(profileId)) return true;
    } catch { }
    return false;
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

  private reply(mp: Mp, userId: number, ok: boolean, text: string): void {
    try {
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminActionResult", ok, text }));
    } catch { }
  }

  // Routes into the gamemode's admin.log + staff channel when loaded
  private adminLog(text: string): void {
    try { (globalThis as any).__alduinakAdminLog?.(text); } catch { }
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "adminMenuRequest" && type !== "adminAction") return;
    const mp = ctx.svr as Mp;
    let myActorId = 0;
    try { myActorId = mp.getUserActor(userId); } catch { }
    if (!myActorId || !this.isAdminActor(mp, myActorId)) {
      // Log the actor's real roles so a misconfigured adminRoleIds is diagnosable from the game
      let roles: unknown = [];
      try { roles = mp.get(myActorId, "private.discordRoles"); } catch { }
      this.log(`AdminSystem: refused '${type}' from actor ${myActorId.toString(16)} (not an admin). Their roles: ${JSON.stringify(roles)}. Configured: ${JSON.stringify(this.adminRoleIds)}`);
      return;
    }

    if (type === "adminMenuRequest") {
      const players = this.onlinePlayers(mp)
        .filter(p => p.actorId !== myActorId)
        .map(p => ({ a: p.actorId.toString(16), p: p.profileId, n: p.name || "(no name)" }));
      mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "adminMenu", players }));
      return;
    }

    const action = String(content["action"] ?? "");
    const targetId = parseInt(String(content["target"] ?? ""), 16);
    // Only currently-online player actors are valid targets
    const target = this.onlinePlayers(mp).find(p => p.actorId === targetId);
    if (!target) {
      this.reply(mp, userId, false, "Target is no longer online");
      return;
    }
    let adminProfile = 0;
    try { adminProfile = Number(mp.get(myActorId, "profileId")) || 0; } catch { }

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
        this.banViaBackend(mp, ctx, userId, myActorId, target, adminProfile);
      } else {
        this.reply(mp, userId, false, `Unknown action '${action}'`);
      }
    } catch (e) {
      this.log(`AdminSystem: action '${action}' by profile ${adminProfile} failed: ${e}`);
      this.reply(mp, userId, false, "Action failed, see server log");
    }
  }

  private banViaBackend(
    mp: Mp,
    ctx: SystemContext,
    userId: number,
    adminActorId: number,
    target: { userId: number; actorId: number; profileId: number; name: string },
    adminProfile: number
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
        bannedBy: `profile ${adminProfile}`,
      }),
    }).then(res => {
      if (res.ok) {
        // Boot AND drop the connection; connection-check refuses the reconnect
        try { ctx.svr.setEnabled(target.actorId, false); } catch { }
        try { (ctx.svr as Mp).kick(target.userId); } catch { }
        this.log(`AdminSystem: profile ${adminProfile} banned profile ${target.profileId} (${target.name})`);
        this.adminLog(`profile ${adminProfile} banned ${target.name} (profile ${target.profileId})`);
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
