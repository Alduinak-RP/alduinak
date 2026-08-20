import { Game, Utility, printConsole, createText, setTextSize } from "skyrimPlatform";
import { getScreenResolution } from "../../view/formView";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { Mod } from "../messages_http/serverManifest";
import { logTrace } from "../../logging";
import { SettingsService } from "./settingsService";

const STATE_KEY = 'loadOrderCheckState';

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
    const clientMods = this.getClientMods();
    this.printModOrder('Client load order:', clientMods);
    return settingsService.getServerMods()
      .then((serverMods) => {
        this.printModOrder('Server load order:', serverMods);
        if (clientMods.length < serverMods.length) {
          throw new Error(`Missing some server mods. Server has ${serverMods.length}, we have ${clientMods.length}`);
        }
        if (clientMods.length > serverMods.length) {
          this.updateText(
            'LOAD ORDER WARNING: you have more mods than server!\n(or could not receive server mod list)\nCheck console for details.',
            [255, 255, 0, 1], 5,
          );
        }
        let fail = [];
        for (let i = 0; i < serverMods.length; ++i) {
          // Need case-insensitive check for 1.6+
          const nameMismatch = clientMods[i].filename.toLowerCase() !== serverMods[i].filename.toLowerCase();
          // Older SkyrimPlatform builds reject plugin names with spaces from
          // getFileInfo, so the client cannot hash them (crc32/size come back
          // as the 0/0 sentinel). Don't treat that as a content mismatch - the
          // name still has to match; the native fix restores real hashing.
          const unhashable = clientMods[i].crc32 === 0 && clientMods[i].size === 0;
          const contentMismatch = !unhashable &&
            (clientMods[i].size !== serverMods[i].size || clientMods[i].crc32 !== serverMods[i].crc32);
          if (nameMismatch || contentMismatch) {
            fail.push(i);
            printConsole(`${i}-th mod (numbered from 0) does not match.`);
            printConsole(`Server has ${JSON.stringify(serverMods[i])}`);
            printConsole(`We have ${JSON.stringify(clientMods[i])}`);
          }
        }
        if (fail.length !== 0) {
          throw new Error('Load order check failed! Indices: ' + JSON.stringify(fail));
        }
      })
      .catch((err) => {
        // Mismatches only log to console; the master launch-check enforces mods.
        printConsole(err);
      });
  };

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

  private enumerateClientMods(getCount: (() => number), getAt: ((idx: number) => string)) {
    const result = [];
    for (let i = 0; i < getCount(); ++i) {
      const filename = getAt(i);
      const { crc32, size } = this.getFileInfoSafe(filename);
      result.push({ filename, crc32, size });
    }
    return result;
  }

  private getClientMods() {
    return this.enumerateClientMods(Game.getModCount, Game.getModName);
  };

  private printModOrder(header: string, order: Mod[]) {
    printConsole(header);
    for (const [i, mod] of Object.entries(order)) {
      printConsole(`#${i} ${JSON.stringify(mod)}`);
    }
  };

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
