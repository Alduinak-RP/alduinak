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
import { Content, System, WORLD_LOADED_EVENT } from "./systems/system";
import { MasterClient } from "./systems/masterClient";
import { Spawn } from "./systems/spawn";
import { Login } from "./systems/login";
import { ClientIntegritySystem } from "./systems/clientIntegrity";
import { QueueSystem } from "./systems/queueSystem";
import { HousingSystem } from "./systems/housingSystem";
import { MasterySystem } from "./systems/masterySystem";
import { NeedsSystem } from "./systems/needsSystem";
import { RacialSystem } from "./systems/racialSystem";
import { GatheringSystem } from "./systems/gatheringSystem";
import { FactionCraftSystem } from "./systems/factionCraftSystem";
import { HuntingSystem } from "./systems/huntingSystem";
import { SurvivalSystem } from "./systems/survivalSystem";
import { BountyBoardSystem } from "./systems/bountyBoardSystem";
import { WritingSystem } from "./systems/writingSystem";
import { CaptureSystem } from "./systems/captureSystem";
import { BleedoutSystem } from "./systems/bleedoutSystem";
import { WorldFloorSystem } from "./systems/worldFloorSystem";
import { ExecutionSystem } from "./systems/executionSystem";
import { TradeSystem } from "./systems/tradeSystem";
import { CraftedExtrasSystem } from "./systems/craftedExtrasSystem";
import { SearchSystem } from "./systems/searchSystem";
import { SoulTrapSystem } from "./systems/soulTrapSystem";
import { AfterlifeSystem } from "./systems/afterlifeSystem";
import { BodySystem } from "./systems/bodySystem";
import { VoiceSystem } from "./systems/voiceSystem";
import { AdminSystem } from "./systems/adminSystem";
import { AfkSystem } from "./systems/afkSystem";
import { GoldWatchSystem } from "./systems/goldWatchSystem";
import { TimeSystem } from "./systems/timeSystem";
import { WeatherSystem } from "./systems/weatherSystem";
import { FurnitureSeatSystem } from "./systems/furnitureSeatSystem";
import { DoorTeleportSystem } from "./systems/doorTeleportSystem";
import { LeverLinkSystem } from "./systems/leverLinkSystem";
import { NpcSpawnSystem } from "./systems/npcSpawnSystem";
import { DiscordBanSystem } from "./systems/discordBanSystem";
import { DiscordAlerts, discordAlert } from "./systems/discordAlerts";
import { loc, gamemodeLoc } from "./loc";
import { TorchSystem } from "./systems/torchSystem";
import { PlacedItemSystem } from "./systems/placedItemSystem";
import { CombatReadoutSystem } from "./systems/combatReadoutSystem";
import { DurabilitySystem } from "./systems/durabilitySystem";
import { CompanionSystem } from "./systems/companionSystem";
import { HostingSystem } from "./systems/hostingSystem";
import { PetSystem } from "./systems/petSystem";
import { ConjurationSystem } from "./systems/conjurationSystem";
import { KnowledgeSystem } from "./systems/knowledgeSystem";
import { FactionSystem } from "./systems/factionSystem";
import { JobSystem } from "./systems/jobSystem";
import { trackConnections } from "./systems/actorUtil";
import { trackOnline } from "./systems/onlineSnapshot";
import { notePreLoginPacket, trackPreLogin } from "./systems/preLoginPackets";
import { startPolls } from "./systems/timers";
import { ownGamemodeHooks, reclaimGamemodeHooks } from "./systems/gamemodeHooks";
import { EventEmitter } from "events";
import { pid } from "process";
import * as fs from "fs";
import * as chokidar from "chokidar";
import * as path from "path";
import * as os from "os";

import * as manifestGen from "./manifestGen";
import { attachBackendFactionApi } from "./backendFactionApi";
import { createScampServer } from "./scampNative";
import { MetricsSystem } from "./systems/metricsSystem";

const gamemodeCache = new Map<string, string>();
// Basename of the temp copy the bundle last ran from; a load error's frame is found through it
let gamemodeTempName = "";

function requireTemp(module: string) {
  // https://blog.mastykarz.nl/create-temp-directory-app-node-js/
  let tmpDir;
  const appPrefix = 'skymp5-server';
  gamemodeTempName = "";
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), appPrefix));

    const contents = fs.readFileSync(module, 'utf8');
    const tempPath = path.join(tmpDir, Math.random() + '-' + Date.now() + '.js');
    gamemodeTempName = path.basename(tempPath);
    fs.writeFileSync(tempPath, contents);

    // A load error reaches the caller, which reports it
    require(tempPath);
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
        // The parts call loc() over the gamemode section of en_loc.json; a bundle carrying its own prelude shadows this one
        (globalThis as any).loc = (globalThis as any).loc || gamemodeLoc;

        // The server's hook dispatchers go back in place after a failed load too
        try {
          requireTemp(module);
        } finally {
          reclaimGamemodeHooks(server);
        }
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

// A gamemode that does not load leaves chat, introductions, admin tools and every ff_ property off: the server log and the Discord admin alerts both say so
const reportGamemodeLoadFailure = (gamemodePath: string, e: unknown, hotReload: boolean) => {
  const stack = String((e as Error)?.stack || e);
  // The bundle runs from a random temp copy, so the frame naming that copy is mapped back to gamemode.js
  const at = gamemodeTempName ? stack.indexOf(`${gamemodeTempName}:`) : -1;
  const frame = at === -1 ? null : stack.slice(at + gamemodeTempName.length).match(/^:(\d+)(?::(\d+))?/);
  const where = frame ? ` at ${path.basename(gamemodePath)}:${frame[1]}${frame[2] ? `:${frame[2]}` : ""}` : "";
  const error = `${e}${where}`;
  const line = hotReload
    ? loc("gamemode.reloadFailed", { path: gamemodePath, error })
    : loc("gamemode.loadFailed", { path: gamemodePath, error });
  console.error(line);
  console.error(stack);
  discordAlert("admin", line);
};

const setupGamemode = (server: any, gamemodePath: string, hotReload: boolean) => {
  // NOTE: ScampServer.on is a read-only native property, so listener stacking
  // across hot reloads cannot be fixed here by wrapping it (assignment
  // silently no-ops in sloppy mode, throws in strict). The gamemode bundle
  // guards itself instead: each generation tags globalThis.__ffGen and stale
  // generations' handlers and timers self-mute.
  const clear = () => server.clear();
  ownGamemodeHooks(server);

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
    reportGamemodeLoadFailure(absoluteGamemodePath, e, false);
  }

  if (!hotReload) {
    console.log("Gamemode hot reload is off (gamemodeHotReload), changes load at the next start");
    return;
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
      reportGamemodeLoadFailure(absoluteGamemodePath, e, true);
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
  // The admin panel's NPCs tab drives the spawner and its Players tab grants mastery hours.
  const hostingSystem = new HostingSystem(log);
  const npcSpawnSystem = new NpcSpawnSystem(log);
  const masterySystem = new MasterySystem(log);
  const needsSystem = new NeedsSystem(log, masterySystem);
  // Race numbers from racialPassives scale hunger drain and fatigue costs
  const racialSystem = new RacialSystem(log);
  needsSystem.addModifierSource(racialSystem);
  // Base magicka keeps the race's bonus, a mage's on top of the rank value, and the race check compares what was sent
  masterySystem.setRacial(racialSystem);
  racialSystem.writtenMagicka = (actorId) => masterySystem.lastMagicka(actorId);
  const furnitureSeatSystem = new FurnitureSeatSystem(log);
  const companionSystem = new CompanionSystem(log, hostingSystem);
  // NPC AI runs on the client that hosts it; the audit moves hosting to the aggro holder, the owner or the nearest player
  hostingSystem.addProvider(() => npcSpawnSystem.liveNpcs());
  // A zone whose NPCs are fighting a player does not despawn under them
  npcSpawnSystem.inCombat = (id) => hostingSystem.inCombat(id);
  hostingSystem.addProvider(() => companionSystem.hostables());
  const captureSystem = new CaptureSystem(log);
  // Players brought to 0 health bleed out; capture and carry rescue them
  const bleedoutSystem = new BleedoutSystem(log, captureSystem);
  // A fall below a space's floor is a death and a temple respawn, and a player outside the world border is put back inside
  const worldFloorSystem = new WorldFloorSystem(log, bleedoutSystem);
  // Sovngarde and the Soul Cairn: soul trap, finish off and execution send characters there
  const afterlifeSystem = new AfterlifeSystem(log);
  const housingSystem = new HousingSystem(log);
  // Living NPCs are searched too; hosting's aggro says whether one is fighting
  const searchSystem = new SearchSystem(log, hostingSystem);
  const huntingSystem = new HuntingSystem(log, masterySystem, needsSystem);
  // A hunter's interaction with a dead animal, a dead player's own body or a PK body skins it before it is searched
  searchSystem.bodyAction = (ctx, searcherId, bodyId, chosen) => huntingSystem.trySkin(ctx, searcherId, bodyId, true, chosen);
  // The interact menu on a dead player's body offers Skin to a hunter holding the knife
  captureSystem.menuFlagProviders.push((requesterId, bodyId) => huntingSystem.menuFlags(requesterId, bodyId));
  searchSystem.hidesItem = (ctx, _viewerId, bodyId, baseId) => huntingSystem.hidesMeat(ctx, bodyId, baseId);
  // Pets: owned by a character and hosted by their owner; the housing menu offers them at doors and the admin panel grants them
  const petSystem = new PetSystem(log, hostingSystem, companionSystem, housingSystem, searchSystem, captureSystem);
  hostingSystem.addProvider(() => petSystem.hostables());
  // A living pet, companion or animal is not searched
  searchSystem.ownedBy = (id) => petSystem.ownerOf(id) || (companionSystem.info(id)?.ownerId ?? 0);
  searchSystem.isAnimal = (ctx, id) => huntingSystem.isAnimal(ctx, id);
  // Out dogs fight through the companion targeting, and no pet of the owner is ever a valid target
  companionSystem.setAllySource(() => petSystem.fighters(), (id) => petSystem.ownerOf(id));
  housingSystem.petCategoryOf = (actorId, refrId) => petSystem.categoryOfDoor(actorId, refrId);
  const adminSystem = new AdminSystem(log, npcSpawnSystem, masterySystem);
  // Staff in NoClip may pass the world border, in play and at login
  const spawn = new Spawn(log);
  worldFloorSystem.exempt = (mp, actorId) => adminSystem.hasMode(mp, actorId, "noclip");
  spawn.exempt = worldFloorSystem.exempt;
  adminSystem.setPetSystem(petSystem);
  adminSystem.setAfterlifeSystem(afterlifeSystem);
  // Passive jobs: a job carrier neither carries nor is carried, and the admin panel places the jobs
  const jobSystem = new JobSystem(log, captureSystem, masterySystem);
  captureSystem.jobLoadOf = (actorId) => jobSystem.loadOf(actorId);
  adminSystem.setJobSystem(jobSystem);
  // Per-region weather; the admin panel's Weather sub-tab forces and clears it
  const weatherSystem = new WeatherSystem(log);
  adminSystem.setWeatherSystem(weatherSystem);
  // Survival Mode on the server; its diseases scale needs like the race factors
  const survivalSystem = new SurvivalSystem(log, racialSystem, huntingSystem, weatherSystem);
  needsSystem.addModifierSource(survivalSystem);
  const factionSystem = new FactionSystem(log, housingSystem);
  // A PK leaves a lootable body at the spot of death
  const bodySystem = new BodySystem(log);
  // A player's own body or a PK body is not searched while a hunter skins it
  searchSystem.bodyRefusal = (searcherId, bodyId) => huntingSystem.searchRefusal(bodyId) || bodySystem.refusalFor(searcherId, bodyId);
  // A PK body holds the victim's keys and writings, taken from its window like any other item
  searchSystem.namedLoot = (bodyId) => !!bodySystem.bodyOf(bodyId);
  huntingSystem.leftBody = (victimId) => bodySystem.hasBodyFor(victimId);
  huntingSystem.pkBodyOf = (bodyId) => bodySystem.bodyOf(bodyId);
  // A skinned PK body hands its whole pack to the skinner
  huntingSystem.emptyPkBody = (bodyId, skinnerId) => bodySystem.emptyInto(bodyId, skinnerId, "skinned");
  // Finish off: holders of the execute permission kill a downed player and send them to Sovngarde
  const executionSystem = new ExecutionSystem(log, captureSystem, bleedoutSystem, factionSystem, afterlifeSystem, bodySystem, furnitureSeatSystem);
  adminSystem.setExecutionSystem(executionSystem);
  const bountyBoardSystem = new BountyBoardSystem(log);
  bountyBoardSystem.canRemove = (actorId, boardName) => factionSystem.canRemoveBoardPosts(actorId, boardName);
  bountyBoardSystem.canManage = (actorId, boardName) => factionSystem.canManageBoard(actorId, boardName);
  bountyBoardSystem.titleOf = (actorId) => factionSystem.titleOfActor(actorId);
  // Letters pinned to doors from the housing menu
  const writingSystem = new WritingSystem(log, factionSystem);
  const clientIntegritySystem = new ClientIntegritySystem(log, master, masterKey);
  housingSystem.writings = writingSystem;
  systems.push(
    new MetricsSystem(),
    new MasterClient(log, port, master, maxPlayers, name, masterKey, 5000, offlineMode),
    spawn,
    clientIntegritySystem,
    new Login(log, maxPlayers, master, port, masterKey, offlineMode, clientIntegritySystem),
    // Holds verified logins while the play slots are full and releases them to Spawn in arrival order
    new QueueSystem(log),
    // First activation hook, so it is the last one called: a door refused by any other system never reaches the override
    new DoorTeleportSystem(log),
    // Keep AdminSystem before capture/trade: its console grant/revoke is security-relevant and must not be skipped by an earlier listener throwing
    adminSystem,
    captureSystem,
    // Early, so the hit observers wrapped after it (hosting, companions) never see a refused hit on a downed player
    bleedoutSystem,
    worldFloorSystem,
    afterlifeSystem,
    housingSystem,
    factionSystem,
    bodySystem,
    executionSystem,
    new TradeSystem(log),
    // Its tempers take the rank cap from mastery and their fatigue from needs
    new CraftedExtrasSystem(log, masterySystem, needsSystem),
    searchSystem,
    new SoulTrapSystem(log, companionSystem, afterlifeSystem, factionSystem, bodySystem, captureSystem),
    new VoiceSystem(log),
    new AfkSystem(log),
    new GoldWatchSystem(log),
    new TimeSystem(log),
    weatherSystem,
    furnitureSeatSystem,
    // Before needs, whose boot line lists the race factors this one parses
    racialSystem,
    // Before mastery, whose hooks wrap this one's, so a craft refused for fatigue is never credited
    needsSystem,
    masterySystem,
    // After mastery so a refused tool check is never credited as work.
    new GatheringSystem(log, masterySystem, needsSystem, furnitureSeatSystem),
    new FactionCraftSystem(log, factionSystem),
    huntingSystem,
    // After hunting, whose raw meat it reads, and after needs, whose eat hook it wraps
    survivalSystem,
    // After needs, so the repair menu of a bench opens for a player too tired to craft at it
    new DurabilitySystem(log, masterySystem, needsSystem),
    bountyBoardSystem,
    writingSystem,
    new TorchSystem(log),
    new PlacedItemSystem(log),
    // The lines of the /armor chat command, on only with the rebalance or durability
    new CombatReadoutSystem(log),
    // Observes hits for the hosting audit; before the spawner and the companions that feed it
    hostingSystem,
    npcSpawnSystem,
    // After AdminSystem: its onHitDamageAttempt hook wraps the god-mode one
    companionSystem,
    new ConjurationSystem(log, companionSystem),
    // After companions: its host and activate hooks wrap theirs
    petSystem,
    new KnowledgeSystem(log),
    new DiscordBanSystem(),
    new DiscordAlerts(),
    // After every other activate hook but the job one, so only an allowed pull moves the linked gate
    new LeverLinkSystem(log),
    // Last: its hit and activate hooks wrap every other one
    jobSystem,
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
  // Every system listens once to the shared events; a count past this still flags a real leak
  ctx.gm.setMaxListeners(40);
  trackConnections(server);
  trackOnline(ctx);
  trackPreLogin(ctx);

  console.log(`Current process ID is ${pid}`);

  (async () => {
    while (1) {
      try {
        server.tick();
        await new Promise((r) => setTimeout(r, 1));
      } catch (e) {
        console.error(`in server.tick:\n${e.stack}`);
      }
    }
  })();

  for (const system of systems) {
    if (system.initAsync) {
      await system.initAsync(ctx);
    }
    log(`Initialized ${system.systemName}`);
  }
  startPolls();

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

  // The gamemode parses packets itself unless this is set
  (globalThis as any).__alduinakTsRouter = true;

  server.on("customPacket", (userId: number, rawContent: string) => {
    let content: Content;
    let type: string;
    // Gamemode route key: customPacketType, or the chat packet's type
    let route: string;
    try {
      content = JSON.parse(rawContent);
      if (!content || typeof content !== "object" || Array.isArray(content)) return;
      type = `${content.customPacketType}`;
      route = content.customPacketType === undefined ? `${content.type}` : type;
    } catch {
      return;
    }
    notePreLoginPacket(userId, route);
    delete content.customPacketType;

    for (const system of systems) {
      try {
        if (system.customPacket)
          system.customPacket(userId, type, content, ctx);
      } catch (e) {
        console.error(e);
      }
    }

    const gamemodeRoute = (globalThis as any).__alduinakPacketRoutes?.get?.(route);
    if (typeof gamemodeRoute === "function") {
      try {
        gamemodeRoute(userId, content);
      } catch (e) {
        console.error(e);
      }
    }
  });

  // It's important to call this before gamemode
  try {
    server.attachSaveStorage();
  } catch (e) {
    console.error(e);
    console.error(`Stopping the server due to the previous error`);
    process.exit(-1);
  }

  try {
    ctx.gm.emit(WORLD_LOADED_EVENT);
  } catch (e) {
    console.error(e);
  }

  // Attach before gamemode load (FactionSystem and the gamemode use it); a failed attach must degrade, never block the load
  try {
    attachBackendFactionApi(server, settingsObject);
  } catch (e) {
    console.error("attachBackendFactionApi failed, faction sync natives unavailable:", e);
  }

  setupGamemode(server, gamemodePath, settingsObject.allSettings?.gamemodeHotReload === true);
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
