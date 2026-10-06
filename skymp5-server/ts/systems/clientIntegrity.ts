import * as fs from "fs";
import * as path from "path";
import { Settings } from "../settings";
import { System, Log, SystemContext, Content } from "./system";
import { kickWithReason } from "./kickUtil";
import { discordAlert } from "./discordAlerts";
import { loc } from "../loc";

// Client integrity: the client reports its loaded plugins and the dlls from the game folder or any SKSE/Plugins folder,
// at login (gameData.integrity) and every few minutes (integrityReport). Plugins are compared with this server's
// data/manifest.json, dlls with the backend's client-modules list (every dll the launcher manifest ships).
//
// server-settings.json keys:
//   clientIntegrity.mode          "off" (default), "log" (log and alert staff) or "kick" (also kick the player)
//   clientIntegrity.allowModules  extra dll names allowed with any hash, e.g. ["dxgi.dll"]

type Mode = "off" | "log" | "kick";

interface PluginReport { name: string; crc32: number; size: number }
interface ModuleReport { path: string; size: number; sha256: string }
interface Report { plugins: PluginReport[] | null; modules: ModuleReport[] | null }
interface ModuleEntry { sha256: string; size: number | null }
interface ModuleList { modules: Record<string, ModuleEntry[]>; anyHashRoot: string[] }
interface ManifestMod { filename: string; crc32: number; size: number }

const MODULES_TTL_MS = 10 * 60000;
const MAX_ENTRIES = 4096;
const MAX_TEXT = 512;
const MAX_KICK_PROBLEMS = 5;
// The engine always loads these; store copies differ, so they are never hashed (the client's own rule)
const VANILLA_MASTERS = new Set(["skyrim.esm", "update.esm", "dawnguard.esm", "hearthfires.esm", "dragonborn.esm"]);
const IMPLICIT_PLUGINS = new Set(["_resourcepack.esl"]);
const CREATION_CLUB_RE = /^cc[a-z]{3}sse\d{3}-.*\.es[mlp]$/i;

const text = (v: unknown): string | null => typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT ? v : null;
const num = (v: unknown): number => typeof v === "number" && Number.isFinite(v) ? v : NaN;

// Untrusted input: anything malformed becomes null, which counts as a missing report
export function parseReport(raw: unknown): Report | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = <T>(v: unknown, item: (e: Record<string, unknown>) => T | null): T[] | null => {
    if (!Array.isArray(v) || v.length > MAX_ENTRIES) return null;
    const out: T[] = [];
    for (const e of v) {
      const parsed = e && typeof e === "object" ? item(e as Record<string, unknown>) : null;
      if (!parsed) return null;
      out.push(parsed);
    }
    return out;
  };
  const plugins = list(r.plugins, (e) => {
    const name = text(e.name);
    return name ? { name, crc32: num(e.crc32), size: num(e.size) } : null;
  });
  const modules = list(r.modules, (e) => {
    const p = text(e.path);
    return p ? { path: p, size: num(e.size), sha256: typeof e.sha256 === "string" ? e.sha256.toLowerCase() : "" } : null;
  });
  return { plugins, modules };
}

export function pluginProblems(plugins: PluginReport[] | null, loadOrder: string[], mods: ManifestMod[]): string[] {
  if (!plugins) return [loc("integrity.noPlugins")];
  const lower = (s: string) => s.toLowerCase();
  const expected = new Set(loadOrder.map(lower));
  const reported = new Set(plugins.map((p) => lower(p.name)));
  const byName = new Map(mods.map((m) => [lower(m.filename), m]));
  const problems: string[] = [];
  for (const p of plugins) {
    const key = lower(p.name);
    if (IMPLICIT_PLUGINS.has(key)) continue;
    if (!expected.has(key)) {
      problems.push(loc("integrity.extraPlugin", { name: p.name }));
      continue;
    }
    const mod = byName.get(key);
    if (!mod || VANILLA_MASTERS.has(key) || CREATION_CLUB_RE.test(p.name)) continue;
    if ((p.crc32 >>> 0) !== (mod.crc32 >>> 0) || p.size !== mod.size) {
      problems.push(loc("integrity.changedPlugin", { name: p.name }));
    }
  }
  for (const name of loadOrder) {
    if (!reported.has(lower(name))) problems.push(loc("integrity.missingPlugin", { name }));
  }
  return problems;
}

export function moduleProblems(modules: ModuleReport[] | null, list: ModuleList, allowModules: Set<string>): string[] {
  if (!modules) return [loc("integrity.noModules")];
  const problems: string[] = [];
  const anyHashRoot = new Set(list.anyHashRoot.map((n) => n.toLowerCase()));
  for (const m of modules) {
    const rel = m.path.replace(/\\/g, "/");
    const name = path.posix.basename(rel).toLowerCase();
    if (allowModules.has(name)) continue;
    if (anyHashRoot.has(name) && !rel.includes("/")) continue;
    const entries = list.modules[name];
    if (!entries) {
      problems.push(loc("integrity.unknownModule", { path: rel }));
      continue;
    }
    const ok = m.sha256
      ? entries.some((e) => e.sha256 === m.sha256)
      : entries.some((e) => e.size !== null && e.size === m.size);
    if (!ok) problems.push(loc("integrity.changedModule", { path: rel }));
  }
  return problems;
}

export class ClientIntegritySystem implements System {
  systemName = "ClientIntegrity";

  private mode: Mode = "off";
  private allowModules = new Set<string>();
  private authToken = "";
  private dataDir = "";
  private moduleList: { value: ModuleList; at: number } | null = null;
  private moduleListPending: Promise<ModuleList | null> | null = null;

  constructor(private log: Log, private masterUrl: string | null, private masterKey: string) { }

  async initAsync(ctx: SystemContext): Promise<void> {
    const s = await Settings.get();
    const all = s.allSettings as Record<string, any> | null;
    const cfg = all?.["clientIntegrity"];
    const mode = cfg?.mode;
    this.mode = mode === "log" || mode === "kick" ? mode : "off";
    if (Array.isArray(cfg?.allowModules)) {
      this.allowModules = new Set(cfg.allowModules.filter((n: unknown) => typeof n === "string").map((n: string) => n.toLowerCase()));
    }
    this.authToken = typeof all?.["masterApiAuthToken"] === "string" ? all["masterApiAuthToken"] : "";
    this.dataDir = s.dataDir;
    if (this.mode !== "off" && !this.masterUrl) {
      this.log("ClientIntegrity: no master url, dll checks cannot run");
    }
    this.log(`ClientIntegrity: mode ${this.mode}${this.allowModules.size ? `, extra dlls allowed: ${[...this.allowModules].join(", ")}` : ""}`);
  }

  get enabled(): boolean {
    return this.mode !== "off";
  }

  // False when the login must stop (kicked, or the slot changed hands during the check)
  async checkLogin(userId: number, profileId: number, discordId: string | null, raw: unknown, ctx: SystemContext): Promise<boolean> {
    if (!this.enabled) return true;
    const guid = ctx.svr.getUserGuid(userId);
    const problems = await this.problems(raw);
    if (!ctx.svr.isConnected(userId) || ctx.svr.getUserGuid(userId) !== guid) return false;
    return this.act(userId, profileId, discordId, problems, "login", ctx);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type !== "integrityReport" || !this.enabled) return;
    const guid = ctx.svr.getUserGuid(userId);
    this.problems(content["integrity"]).then((problems) => {
      if (!ctx.svr.isConnected(userId) || ctx.svr.getUserGuid(userId) !== guid) return;
      this.act(userId, null, null, problems, "recheck", ctx);
    }).catch((err) => console.error("ClientIntegrity: recheck failed:", err));
  }

  private async problems(raw: unknown): Promise<string[]> {
    const report = parseReport(raw);
    if (!report) return [loc("integrity.noReport")];
    const manifest = this.readManifest();
    const list = await this.getModuleList();
    return [
      ...(manifest ? pluginProblems(report.plugins, manifest.loadOrder, manifest.mods) : [loc("integrity.noServerManifest")]),
      ...(list ? moduleProblems(report.modules, list, this.allowModules) : [loc("integrity.noModuleList")]),
    ];
  }

  private act(userId: number, profileId: number | null, discordId: string | null, problems: string[], when: string, ctx: SystemContext): boolean {
    if (problems.length === 0) return true;
    const who = profileId !== null ? `profile ${profileId}` : this.describeUser(userId, ctx);
    const line = loc("integrity.alert", { who, slot: userId, when, action: this.mode === "kick" ? loc("integrity.kicked") : loc("integrity.logged"), problems: problems.join("; ") });
    console.log(`[ClientIntegrity] ${line}`);
    discordAlert("integrity", line, { discordIds: discordId ? [discordId] : [] });
    if (this.mode !== "kick") return true;
    const shown = problems.slice(0, MAX_KICK_PROBLEMS).join("\n");
    const more = problems.length > MAX_KICK_PROBLEMS ? `\n${loc("integrity.more", { count: problems.length - MAX_KICK_PROBLEMS })}` : "";
    kickWithReason(ctx.svr, userId, loc("integrity.kick", { problems: shown + more }));
    return false;
  }

  private describeUser(userId: number, ctx: SystemContext): string {
    try {
      const actorId = ctx.svr.getUserActor(userId);
      if (actorId) return `actor ${actorId.toString(16)}`;
    } catch { /* not mapped yet */ }
    return `user ${userId}`;
  }

  // Read on each check: the manifest is rewritten only at boot, and a missing file must not stop logins silently
  private readManifest(): { loadOrder: string[]; mods: ManifestMod[] } | null {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dataDir, "manifest.json"), "utf8"));
      return Array.isArray(m?.loadOrder) && Array.isArray(m?.mods) ? { loadOrder: m.loadOrder, mods: m.mods } : null;
    } catch (e) {
      console.error("ClientIntegrity: cannot read manifest.json:", e);
      return null;
    }
  }

  // Cached MODULES_TTL_MS; a failed refresh keeps the last list
  private async getModuleList(): Promise<ModuleList | null> {
    if (this.moduleList && Date.now() - this.moduleList.at < MODULES_TTL_MS) return this.moduleList.value;
    if (!this.moduleListPending) {
      this.moduleListPending = this.fetchModuleList().finally(() => { this.moduleListPending = null; });
    }
    const value = await this.moduleListPending;
    return value || (this.moduleList ? this.moduleList.value : null);
  }

  private async fetchModuleList(): Promise<ModuleList | null> {
    if (!this.masterUrl) return null;
    try {
      const response = await fetch(`${this.masterUrl}/api/servers/${this.masterKey}/client-modules`, { headers: { "X-Auth-Token": this.authToken } });
      if (!response.ok) {
        console.error(`ClientIntegrity: client-modules HTTP ${response.status}`);
        return null;
      }
      const value = await response.json() as ModuleList;
      if (!value || typeof value.modules !== "object" || !Array.isArray(value.anyHashRoot)) return null;
      this.moduleList = { value, at: Date.now() };
      return value;
    } catch (e) {
      console.error("ClientIntegrity: client-modules request failed:", e);
      return null;
    }
  }
}
