import { ClientListener, CombinedController, Sp } from "./clientListener";
import { LoadOrderVerificationService, VANILLA_MASTERS, CREATION_CLUB_RE } from "./loadOrderVerificationService";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";
import { logError, logTrace } from "../../logging";

// The server's client check (ClientIntegritySystem): loaded plugins and the dlls of the game folder or any SKSE/Plugins
// folder go with the login and again every REPORT_INTERVAL_MS. Dlls elsewhere (Windows, overlays, drivers) are never sent.

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
  // A running game cannot load more plugins, so the list is read once in the first update
  private pluginNames: string[] | null = null;
  private nextReportAt = 0;

  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.readPluginNames());
    this.controller.emitter.on("connectionAccepted", () => { this.nextReportAt = Date.now() + REPORT_INTERVAL_MS; });
    this.controller.emitter.on("connectionDisconnect", () => { this.nextReportAt = 0; });
    this.controller.on("tick", () => this.onTick());
  }

  buildReport(): IntegrityReport {
    const report: IntegrityReport = { plugins: null, modules: null };
    try {
      report.plugins = this.pluginReport();
    } catch (e) {
      logError(this, "plugin report failed:", e);
    }
    try {
      report.modules = this.moduleReport();
    } catch (e) {
      logError(this, "dll report failed:", e);
    }
    logTrace(this, `report: ${report.plugins ? report.plugins.length : "no"} plugins, ${report.modules ? report.modules.length : "no"} dlls`);
    return report;
  }

  private onTick() {
    if (this.nextReportAt === 0 || Date.now() < this.nextReportAt) return;
    this.nextReportAt = Date.now() + REPORT_INTERVAL_MS;
    const message: CustomPacketMessage = {
      t: MsgType.CustomPacket,
      contentJsonDump: JSON.stringify({ customPacketType: "integrityReport", integrity: this.buildReport() }),
    };
    this.controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
  }

  private readPluginNames() {
    const loadOrder = this.controller.lookupListener(LoadOrderVerificationService);
    this.pluginNames = [...loadOrder.getFullPlugins(), ...loadOrder.getLightPlugins()];
  }

  // Vanilla masters and Creation Club files go unhashed, as in the load order check
  private pluginReport(): IntegrityReport["plugins"] {
    if (!this.pluginNames) return null;
    const loadOrder = this.controller.lookupListener(LoadOrderVerificationService);
    return this.pluginNames.map((name) => {
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

  // Null on a SkyrimPlatform without the module natives
  private moduleReport(): IntegrityReport["modules"] {
    const api = this.sp as Sp & ModuleApi;
    if (typeof api.getLoadedModules !== "function" || typeof api.getModuleSha256 !== "function") return null;
    const all = api.getLoadedModules();
    const exe = all.find((m) => m.path.toLowerCase().endsWith(".exe"));
    if (!exe) return null;
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
