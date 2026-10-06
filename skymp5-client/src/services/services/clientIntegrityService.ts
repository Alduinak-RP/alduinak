import { ClientListener, CombinedController, Sp } from "./clientListener";
import { LoadOrderVerificationService, VANILLA_MASTERS, CREATION_CLUB_RE } from "./loadOrderVerificationService";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logError, logToPlatformLog } from "../../logging";

// The server's client check (ClientIntegritySystem): loaded plugins and the dlls of the game folder or any SKSE/Plugins
// folder go with the login and again every REPORT_INTERVAL_MS. Dlls elsewhere (Windows, overlays, drivers) are never sent.
// A part that cannot be built goes to skyrim-platform.log, as do the counts of the login report.

const REPORT_INTERVAL_MS = 5 * 60000;
// libcef and libnode are too big to hash on the game thread; the server compares their size
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const SKSE_PLUGINS = "\\skse\\plugins\\";

interface ModuleApi {
  getLoadedModules?: () => { path: string, size: number }[];
  getModuleSha256?: (path: string) => string;
}

export interface IntegrityReport {
  plugins: { name: string, crc32: number, size: number }[] | null;
  modules: { path: string, size: number, sha256: string }[] | null;
}

export class ClientIntegrityService extends ClientListener {
  // A running game cannot load more plugins, so the list is read once, by the first report that needs it
  private pluginNames: string[] | null = null;
  private nextReportAt = 0;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("connectionAccepted", () => { this.nextReportAt = Date.now() + REPORT_INTERVAL_MS; });
    this.controller.emitter.on("connectionDisconnect", () => { this.nextReportAt = 0; });
    this.controller.on("tick", () => this.onTick());
  }

  // Game.getModName reads TESDataHandler directly, so the plugins can be listed from the main menu too
  buildReport(login = true): IntegrityReport {
    const report: IntegrityReport = { plugins: null, modules: null };
    try {
      report.plugins = this.pluginReport();
    } catch (e) {
      logToPlatformLog(this, "no plugin list for the report:", e instanceof Error ? e.message : e);
    }
    try {
      report.modules = this.moduleReport();
    } catch (e) {
      logToPlatformLog(this, "no dll list for the report:", e instanceof Error ? e.message : e);
    }
    if (login) {
      logToPlatformLog(this, `login report: ${report.plugins ? report.plugins.length : "no"} plugins, ${report.modules ? report.modules.length : "no"} dlls`);
    }
    return report;
  }

  private onTick() {
    if (this.nextReportAt === 0 || Date.now() < this.nextReportAt) return;
    this.nextReportAt = Date.now() + REPORT_INTERVAL_MS;
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: "integrityReport", integrity: this.buildReport(false) }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private readPluginNames(): string[] {
    if (!this.pluginNames) {
      const loadOrder = this.controller.lookupListener(LoadOrderVerificationService);
      this.pluginNames = [...loadOrder.getFullPlugins(), ...loadOrder.getLightPlugins()];
    }
    return this.pluginNames;
  }

  // Vanilla masters and Creation Club files go unhashed, as in the load order check
  private pluginReport(): NonNullable<IntegrityReport["plugins"]> {
    const loadOrder = this.controller.lookupListener(LoadOrderVerificationService);
    return this.readPluginNames().map((name) => {
      if (VANILLA_MASTERS.has(name.toLowerCase()) || CREATION_CLUB_RE.test(name)) return { name, crc32: 0, size: 0 };
      try {
        const { crc32, size } = loadOrder.getFileInfoCached(name);
        return { name, crc32, size };
      } catch (e) {
        logError(this, `cannot hash ${name}:`, e);
        return { name, crc32: 0, size: 0 };
      }
    });
  }

  // Throws on a SkyrimPlatform without the module natives
  private moduleReport(): NonNullable<IntegrityReport["modules"]> {
    const api = this.sp as Sp & ModuleApi;
    if (typeof api.getLoadedModules !== "function" || typeof api.getModuleSha256 !== "function") {
      throw new Error("this SkyrimPlatformImpl.dll has no getLoadedModules/getModuleSha256");
    }
    const all = api.getLoadedModules();
    const exe = all.find((m) => m.path.toLowerCase().endsWith(".exe"));
    if (!exe) throw new Error("no exe among the loaded modules");
    const gameDir = exe.path.slice(0, exe.path.lastIndexOf("\\") + 1).toLowerCase();
    const modules: NonNullable<IntegrityReport["modules"]> = [];
    for (const m of all) {
      if (m === exe) continue;
      const path = m.path.replace(/\//g, "\\");
      const lower = path.toLowerCase();
      const skse = lower.indexOf(SKSE_PLUGINS);
      const rel = gameDir && lower.startsWith(gameDir) ? path.slice(gameDir.length)
        : skse >= 0 ? "...\\" + path.slice(skse + 1)
          : null;
      if (rel === null) continue;
      let sha256 = "";
      if (m.size > 0 && m.size <= MAX_HASH_BYTES) {
        try {
          sha256 = api.getModuleSha256(m.path);
        } catch (e) {
          logError(this, `cannot hash ${rel}:`, e);
        }
      }
      modules.push({ path: rel, size: m.size, sha256 });
    }
    return modules;
  }
}
