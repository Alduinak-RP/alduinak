import { Game, Utility, printConsole, createText, setTextSize } from "skyrimPlatform";
import { getScreenResolution } from "../../view/formView";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ServerManifest } from "../messages_http/serverManifest";
import { logTrace } from "../../logging";
import { SettingsService } from "./settingsService";

const STATE_KEY = 'loadOrderCheckState';

// Game.getModName reads light plugins from this index on (CallNativeApi.cpp)
const LIGHT_MOD_OFFSET = 0x100;
const MAX_LIGHT_MODS = 0x1000;

// Steam and GOG copies of these may differ, and Skyrim.esm is too big to hash on every connect
const VANILLA_MASTERS = new Set(['skyrim.esm', 'update.esm', 'dawnguard.esm', 'hearthfires.esm', 'dragonborn.esm']);

interface State {
  statusTextId?: number;
};

export class LoadOrderVerificationService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.once("update", () => this.verifyLoadOrder());
    // Re-check on every (re)connect so a stale error clears once the check passes
    this.controller.emitter.on("connectionAccepted", () => {
      this.controller.once("update", () => this.verifyLoadOrder());
    });
  }

  private verifyLoadOrder() {
    const settingsService = this.controller.lookupListener(SettingsService);

    this.resetText();
    const full = this.getFullPlugins();
    const light = this.getLightPlugins();
    printConsole(`Client full plugins: ${JSON.stringify(full)}`);
    printConsole(`Client light plugins: ${JSON.stringify(light)}`);
    return settingsService.getServerManifest()
      .then((manifest) => {
        if (!manifest || !Array.isArray(manifest.loadOrder)) {
          printConsole('Could not receive the server load order');
          return;
        }
        printConsole(`Server load order: ${JSON.stringify(manifest.loadOrder)}`);
        const problems = this.findProblems(manifest, full, light);
        if (problems.length === 0) {
          return;
        }
        problems.forEach((problem) => printConsole(problem));
        // Plugins out of step with the server get other form ids, so modded doors bounce the player back
        this.updateText(
          'LOAD ORDER MISMATCH: your plugins differ from the server.\nModded buildings, doors and items will not work.\nRe-run the Alduinak launcher (Repair Modlist). Details are in the console.',
          [255, 64, 64, 1], 30,
        );
      })
      .catch((err) => {
        printConsole(err);
      });
  };

  // Full and light plugins have separate form id spaces, so each must follow the server order on its own
  private findProblems(manifest: ServerManifest, full: string[], light: string[]): string[] {
    const lower = (name: string) => name.toLowerCase();
    const lightSet = new Set(light.map(lower));
    const problems = [
      ...this.orderProblems('Full', manifest.loadOrder.filter((name) => !lightSet.has(lower(name))), full),
      ...this.orderProblems('Light', manifest.loadOrder.filter((name) => lightSet.has(lower(name))), light),
    ];

    const serverMods = new Map((manifest.mods || []).map((mod) => [lower(mod.filename), mod]));
    for (const name of [...full, ...light]) {
      const serverMod = serverMods.get(lower(name));
      if (!serverMod || VANILLA_MASTERS.has(lower(name))) {
        continue;
      }
      const { crc32, size } = this.getFileInfoSafe(name);
      // Older SkyrimPlatform builds cannot hash names with spaces and return 0/0; the name check still applies
      if (crc32 === 0 && size === 0) {
        continue;
      }
      if ((crc32 >>> 0) !== (serverMod.crc32 >>> 0) || size !== serverMod.size) {
        problems.push(`${name} differs from the server copy. Server has ${JSON.stringify(serverMod)}, we have ${JSON.stringify({ crc32, size })}`);
      }
    }
    return problems;
  }

  private orderProblems(kind: string, server: string[], client: string[]): string[] {
    const count = Math.max(server.length, client.length);
    for (let i = 0; i < count; ++i) {
      if ((server[i] || '').toLowerCase() !== (client[i] || '').toLowerCase()) {
        return [`${kind} plugin #${i} does not match. Server has ${server[i] || '(nothing)'}, we have ${client[i] || '(nothing)'}`];
      }
    }
    return [];
  }

  private getFullPlugins(): string[] {
    const names: string[] = [];
    for (let i = 0; i < Game.getModCount(); ++i) {
      names.push(Game.getModName(i));
    }
    return names;
  }

  private getLightPlugins(): string[] {
    const names: string[] = [];
    for (let i = 0; i < MAX_LIGHT_MODS; ++i) {
      const name = Game.getModName(LIGHT_MOD_OFFSET + i);
      if (!name) {
        break;
      }
      names.push(name);
    }
    return names;
  }

  private getState(): State {
    if (typeof this.sp.storage[STATE_KEY] !== 'object') {
      return {};
    }
    return this.sp.storage[STATE_KEY] as State;
  };

  private setState(replacement: State) {
    const oldState = this.sp.storage[STATE_KEY] = this.getState();
    for (const [k, v] of Object.entries(replacement)) {
      (oldState as Record<string, any>)[k] = v;
    }
  };

  private resetText() {
    let { statusTextId } = this.getState();
    if (statusTextId) {
      this.sp.destroyText(statusTextId);
      statusTextId = undefined;
      this.setState({ statusTextId });
    }
  };

  private updateText(text: string, color: [number, number, number, number], clearDelay?: number) {
    const { width, height } = getScreenResolution();
    this.resetText();
    const statusTextId = createText(width / 2, height / 2, text, color);
    setTextSize(statusTextId, 0.5);
    this.setState({ statusTextId });
    if (clearDelay) {
      // Only clear the text this call created, never a newer one
      Utility.wait(clearDelay).then(() => {
        if (this.getState().statusTextId === statusTextId) this.resetText();
      });
    }
  }

  private getFileInfoSafe(filename: string) {
    try {
      return this.sp.getFileInfo(filename);
    } catch (e) {
      const message = (e as Record<string, unknown>).message;

      if (typeof message === "string" && message.includes('is not a valid argument')) {
        logTrace(this, `Failed to get file info for`, filename);
        return { crc32: 0, size: 0 };
      } else {
        throw e;
      }
    }
  }
}
