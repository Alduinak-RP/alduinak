import * as ui from "./ui";

// @ts-ignore
import * as sourceMapSupport from "source-map-support";
sourceMapSupport.install({
  retrieveSourceMap: function (source: string) {
    if (source.endsWith('skymp5-server.js')) {
      return {
        url: 'original.js',
        map: require('fs').readFileSync('dist_back/skymp5-server.js.map', 'utf8')
      };
    }
    return null;
  }
});

import * as scampNative from "./scampNative";
import { Settings } from "./settings";
import { System } from "./systems/system";
import { MasterClient } from "./systems/masterClient";
import { Spawn } from "./systems/spawn";
import { Login } from "./systems/login";
import { CaptureSystem } from "./systems/captureSystem";
import { DiscordBanSystem } from "./systems/discordBanSystem";
import { MasterApiBalanceSystem } from "./systems/masterApiBalanceSystem";
import { EventEmitter } from "events";
import { pid } from "process";
import * as fs from "fs";
import * as chokidar from "chokidar";
import * as path from "path";
import * as os from "os";

import * as manifestGen from "./manifestGen";
import { attachBackendFactionApi } from "./backendFactionApi";
import { createScampServer } from "./scampNative";
import { MetricsSystem, tickDurationHistogram, tickDurationSummary } from "./systems/metricsSystem";

const gamemodeCache = new Map<string, string>();

function requireTemp(module: string) {
  // https://blog.mastykarz.nl/create-temp-directory-app-node-js/
  let tmpDir;
  const appPrefix = 'skymp5-server';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), appPrefix));

    const contents = fs.readFileSync(module, 'utf8');
    const tempPath = path.join(tmpDir, Math.random() + '-' + Date.now() + '.js');
    fs.writeFileSync(tempPath, contents);

    require(tempPath);
  } catch (e) {
    console.error(e.stack);
  } finally {
    try {
      if (tmpDir) {
        fs.rmSync(tmpDir, { recursive: true });
      }
    } catch (e) {
      console.error(`An error has occurred while removing the temp folder at ${tmpDir}. Please remove it manually. Error: ${e}`);
    }
  }
}

function requireUncached(
  module: string,
  clear: () => void,
  server: scampNative.ScampServer
): void {
  let gamemodeContents = fs.readFileSync(require.resolve(module), "utf8");

  // Reload gamemode.js only if there are real changes
  const gamemodeContentsOld = gamemodeCache.get(module);
  if (gamemodeContentsOld !== gamemodeContents) {
    gamemodeCache.set(module, gamemodeContents);

    while (1) {
      try {
        clear();

        // Native module registers mp-api methods on ScampServer; aliasing global 'mp' lets code bound to it run
        // @ts-ignore
        globalThis.mp = globalThis.mp || server;

        requireTemp(module);
        return;
      } catch (e) {
        if (`${e}`.indexOf("'JsRun' returned error 0x30002") === -1) {
          throw e;
        } else {
          console.log("Bad syntax, ignoring");
          return;
        }
      }
    }
  }
}

const setupStreams = (scampNative: any) => {
  class LogsStream {
    constructor(private logLevel: string) {
    }

    write(chunk: Buffer, encoding: string, callback: () => void) {
      // @ts-ignore
      const str = chunk.toString(encoding);
      if (str.trim().length > 0) {
        scampNative.writeLogs(this.logLevel, str);
      }
      callback();
    }
  }

  const infoStream = new LogsStream('info');
  const errorStream = new LogsStream('error');
  // @ts-ignore
  process.stdout.write = (chunk: Buffer, encoding: string, callback: () => void) => {
    infoStream.write(chunk, encoding, callback);
  };
  // @ts-ignore
  process.stderr.write = (chunk: Buffer, encoding: string, callback: () => void) => {
    errorStream.write(chunk, encoding, callback);
  };
};

const setupGamemode = (server: any, gamemodePath: string) => {
  // Gamemode listeners are generation-scoped: every hot reload re-runs the
  // bundle, which re-registers its mp.on handlers. Route them through one
  // permanent forwarder per event and drop the old generation on reload,
  // otherwise each reload stacks a full extra set of live handlers.
  const gamemodeHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const forwarded = new Set<string>();
  const nativeOn = server.on.bind(server);
  server.on = (eventName: string, handler: (...args: unknown[]) => void) => {
    if (!forwarded.has(eventName)) {
      forwarded.add(eventName);
      nativeOn(eventName, (...args: unknown[]) => {
        for (const h of gamemodeHandlers.get(eventName) || []) {
          try {
            h(...args);
          } catch (e) {
            console.error(`gamemode '${eventName}' handler error:`, e);
          }
        }
      });
    }
    const handlers = gamemodeHandlers.get(eventName) || [];
    handlers.push(handler);
    gamemodeHandlers.set(eventName, handlers);
    return server;
  };

  const clear = () => {
    gamemodeHandlers.clear();
    server.clear();
  };

  const toAbsolute = (p: string) => {
    if (path.isAbsolute(p)) {
      return p;
    }
    return path.resolve("", p);
  };

  const absoluteGamemodePath = toAbsolute(gamemodePath);
  console.log(`Gamemode path is "${absoluteGamemodePath}"`);

  if (!fs.existsSync(absoluteGamemodePath)) {
    console.log(
      `Error during loading a gamemode from "${absoluteGamemodePath}" - file or directory does not exist`,
    );
    return;
  }

  try {
    requireUncached(absoluteGamemodePath, clear, server);
  } catch (e) {
    console.error(e);
  }

  const watcher = chokidar.watch(absoluteGamemodePath, {
    ignored: /^\./,
    persistent: true,
    awaitWriteFinish: true,
  });

  const numReloads = { n: 0 };

  const reloadGamemode = () => {
    try {
      requireUncached(absoluteGamemodePath, clear, server);
      numReloads.n++;
    } catch (e) {
      console.error(e);
    }
  };

  const reloadGamemodeTimeout = function () {
    const n = numReloads.n;
    setTimeout(
      () => (n === numReloads.n ? reloadGamemode() : undefined),
      1000,
    );
  };

  watcher.on("add", reloadGamemodeTimeout);
  watcher.on("addDir", reloadGamemodeTimeout);
  watcher.on("change", reloadGamemodeTimeout);
  watcher.on("unlink", reloadGamemodeTimeout);
  watcher.on("error", function (error) {
    console.error("Error happened in chokidar watch", error);
  });
};

const main = async () => {
  const settingsObject = await Settings.get();
  const {
    port, master, maxPlayers, name, masterKey, offlineMode, gamemodePath
  } = settingsObject;

  const log = console.log;
  const systems = new Array<System>();
  systems.push(
    new MetricsSystem(),
    new MasterClient(log, port, master, maxPlayers, name, masterKey, 5000, offlineMode),
    new Spawn(log),
    new Login(log, maxPlayers, master, port, masterKey, offlineMode),
    new CaptureSystem(log),
    new DiscordBanSystem(),
    new MasterApiBalanceSystem(log, maxPlayers, master, port, masterKey, offlineMode),
  );

  setupStreams(scampNative.getScampNative());

  manifestGen.generateManifest(settingsObject);
  ui.main(settingsObject);

  let server: any;

  try {
    server = createScampServer(settingsObject.allSettings);
    ui.setServer(server);
  } catch (e) {
    console.error(e);
    console.error(`Stopping the server due to the previous error`);
    process.exit(-1);
  }
  const ctx = { svr: server, gm: new EventEmitter() };

  console.log(`Current process ID is ${pid}`);

  (async () => {
    while (1) {
      const endTimerHistogram = tickDurationHistogram.startTimer();
      const endTimerSummary = tickDurationSummary.startTimer();
      try {
        server.tick();
        await new Promise((r) => setTimeout(r, 1));
      } catch (e) {
        console.error(`in server.tick:\n${e.stack}`);
      } finally {
        endTimerHistogram();
        endTimerSummary();
      }
    }
  })();

  for (const system of systems) {
    if (system.initAsync) {
      await system.initAsync(ctx);
    }
    log(`Initialized ${system.systemName}`);
    if (system.updateAsync)
      (async () => {
        while (1) {
          await new Promise((r) => setTimeout(r, 1));
          try {
            await system.updateAsync(ctx);
          } catch (e) {
            console.error(e);
          }
        }
      })();
  }

  server.on("connect", (userId: number) => {
    log("connect", userId);
    for (const system of systems) {
      try {
        if (system.connect) {
          system.connect(userId, ctx);
        }
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("disconnect", (userId: number) => {
    log("disconnect", userId);
    for (const system of systems) {
      try {
        if (system.disconnect) {
          system.disconnect(userId, ctx);
        }
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("customPacket", (userId: number, rawContent: string) => {
    const content = JSON.parse(rawContent);

    const type = `${content.customPacketType}`;
    delete content.customPacketType;

    for (const system of systems) {
      try {
        if (system.customPacket)
          system.customPacket(userId, type, content, ctx);
      } catch (e) {
        console.error(e);
      }
    }
  });

  server.on("customPacket", (userId: number, content: string) => {
    // At this moment we don't have any custom packets
  });

  // It's important to call this before gamemode
  try {
    server.attachSaveStorage();
  } catch (e) {
    console.error(e);
    console.error(`Stopping the server due to the previous error`);
    process.exit(-1);
  }

  // Attach before gamemode load (it probes mp.assignBackendFaction etc); a failed attach must degrade, never block the load
  try {
    attachBackendFactionApi(server, settingsObject);
  } catch (e) {
    console.error("attachBackendFactionApi failed, faction sync natives unavailable:", e);
  }

  setupGamemode(server, gamemodePath);
};

main();

// This is needed at least to handle axios errors in masterClient
// TODO: implement alerts
process.on("unhandledRejection", (...args) => {
  console.error("[!!!] unhandledRejection")
  console.error(...args);
});

// setTimeout on gamemode should not be able to kill the entire server
// TODO: implement alerts
process.on("uncaughtException", (...args) => {
  console.error("[!!!] uncaughtException")
  console.error(...args);
});
