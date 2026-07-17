import {
  Game,
  Utility,
  once
} from "skyrimPlatform";
import { SkympClient } from "./services/services/skympClient";

import * as sp from "skyrimPlatform";

import { BlockPapyrusEventsService } from './services/services/blockPapyrusEventsService';
import { EnforceLimitationsService } from './services/services/enforceLimitationsService';
import { LoadGameService } from './services/services/loadGameService';
import { SendInputsService } from './services/services/sendInputsService';
import { SinglePlayerService } from './services/services/singlePlayerService';
import { SpApiInteractor } from './services/spApiInteractor';
import { TimeService } from "./services/services/timeService";
import { SpVersionCheckService } from "./services/services/spVersionCheckService";
import { ConsoleCommandsService } from "./services/services/consoleCommandsService";
import { LastInvService } from "./services/services/lastInvService";
import { ActivationService } from "./services/services/activationService";
import { CraftService } from "./services/services/craftService";
import { DropItemService } from "./services/services/dropItemService";
import { HitService } from "./services/services/hitService";
import { RagdollService } from "./services/services/ragdollService";
import { DeathService } from "./services/services/deathService";
import { DeathScreenService } from "./services/services/deathScreenService";
import { ContainersService } from "./services/services/containersService";
import { NetworkingService } from "./services/services/networkingService";
import { RemoteServer } from "./services/services/remoteServer";
import { SpSnippetService } from "./services/services/spSnippetService";
import { SweetTaffyDynamicPerksService } from "./services/services/sweetTaffyDynamicPerksService";
import { SweetTaffySweetCantDropService } from "./services/services/sweetTaffySweetCantDropService";
import { SweetTaffyStaticPerksService } from "./services/services/sweetTaffyStaticPerksService";
import { DisableSkillAdvanceService } from "./services/services/disableSkillAdvanceService";
import { DisableFastTravelService } from "./services/services/disableFastTravelService";
import { DisableDifficultySelectionService } from "./services/services/disableDifficultySelectionService";
import { SweetTaffyPlayerCombatService } from "./services/services/sweetTaffyPlayerCombatService";
import { WorldCleanerService } from "./services/services/worldCleanerService";
import { SweetTaffySkillMenuService } from "./services/services/sweetTaffySkillMenuService";
import { LoadOrderVerificationService } from "./services/services/loadOrderVerificationService";
import { BrowserService } from "./services/services/browserService";
import { AuthService } from "./services/services/authService";
import { CharacterSelectService } from "./services/services/characterSelectService";
import { HousingService } from "./services/services/housingService";
import { RefDecorService } from "./services/services/refDecorService";
import { PlayerActionService } from "./services/services/playerActionService";
import { RestraintService } from "./services/services/restraintService";
import { CaptureConsentService } from "./services/services/captureConsentService";
import { SearchService } from "./services/services/searchService";
import { PersonalMenuService } from "./services/services/personalMenuService";
import { ChatService } from "./services/services/chatService";
import { FactionService } from "./services/services/factionService";
import { TradeService } from "./services/services/tradeService";
import { NetInfoService } from "./services/services/netInfoService";
import { AnimDebugService } from "./services/services/animDebugService";
import { TimersService } from "./services/services/timersService";
import { PlayerBowShotService } from "./services/services/playerBowShotService";
import { GamemodeEventSourceService } from "./services/services/gamemodeEventSourceService";
import { GamemodeUpdateService } from "./services/services/gamemodeUpdateService";
import { FrontHotReloadService } from "./services/services/frontHotReloadService";
import { BlockedAnimationsService } from "./services/services/blockedAnimationsService";
import { WorldView } from "./view/worldView";
import { KeyboardEventsService } from "./services/services/keyboardEventsService";
import { MagicSyncService } from "./services/services/magicSyncService";
import { ProfilingService } from "./services/services/profilingService";
import { SettingsService } from "./services/services/settingsService";
import { SweetCameraEnforcementService } from "./services/services/sweetCameraEnforcementService";
import { SweetTaffyNicknamesService } from "./services/services/sweetTaffyNicknamesService";
import { ServerJsVerificationService } from "./services/services/serverJsVerificationService";
import { SweetTaffyEvalService } from "./services/services/sweetTaffyEvalService";
import { NotificationService } from "./services/services/notificationService";

once("update", () => {
  Utility.setINIBool("bAlwaysActive:General", true);
  Game.setGameSettingInt("iDeathDropWeaponChance", 0);
  Utility.setINIFloat("fAutoVanityModeDelay:Camera", 3600);
});

const main = () => {
  try {
    const controller = SpApiInteractor.getControllerInstance();

    const listeners = [
      new BlockPapyrusEventsService(sp, controller),
      new LoadGameService(sp, controller),
      new SinglePlayerService(sp, controller),
      new EnforceLimitationsService(sp, controller),
      new SendInputsService(sp, controller),
      new SkympClient(sp, controller),
      new TimeService(sp, controller),
      new SpVersionCheckService(sp, controller),
      new ConsoleCommandsService(sp, controller),
      new LastInvService(sp, controller),
      new ActivationService(sp, controller),
      new CraftService(sp, controller),
      new DropItemService(sp, controller),
      new HitService(sp, controller),
      new RagdollService(sp, controller),
      new DeathService(sp, controller),
      new DeathScreenService(sp, controller),
      new ContainersService(sp, controller),
      new NetworkingService(sp, controller),
      new RemoteServer(sp, controller),
      new SpSnippetService(sp, controller),
      new SettingsService(sp, controller),
      new SweetTaffyDynamicPerksService(sp, controller),
      new SweetTaffyStaticPerksService(sp, controller),
      new SweetTaffySweetCantDropService(sp, controller),
      new SweetTaffyPlayerCombatService(sp, controller),
      new SweetTaffySkillMenuService(sp, controller),
      new SweetCameraEnforcementService(sp, controller),
      new SweetTaffyEvalService(sp, controller),
      new DisableSkillAdvanceService(sp, controller),
      new DisableFastTravelService(sp, controller),
      new DisableDifficultySelectionService(sp, controller),
      new WorldCleanerService(sp, controller),
      new LoadOrderVerificationService(sp, controller),
      new BrowserService(sp, controller),
      new AuthService(sp, controller),
      new CharacterSelectService(sp, controller),
      new HousingService(sp, controller),
      new RefDecorService(sp, controller),
      new PlayerActionService(sp, controller),
      new RestraintService(sp, controller),
      new CaptureConsentService(sp, controller),
      new SearchService(sp, controller),
      new PersonalMenuService(sp, controller),
      new FactionService(sp, controller),
      new TradeService(sp, controller),
      new NetInfoService(sp, controller),
      new AnimDebugService(sp, controller),
      new TimersService(sp, controller),
      new PlayerBowShotService(sp, controller),
      new GamemodeEventSourceService(sp, controller),
      new GamemodeUpdateService(sp, controller),
      new ChatService(sp, controller),
      new FrontHotReloadService(sp, controller),
      new BlockedAnimationsService(sp, controller),
      new WorldView(sp, controller),
      new KeyboardEventsService(sp, controller),
      new MagicSyncService(sp, controller),
      new ProfilingService(sp, controller),
      new SweetTaffyNicknamesService(sp, controller),
      new ServerJsVerificationService(sp, controller),
      new NotificationService(sp, controller)
    ];
    SpApiInteractor.setup(listeners);
  } catch (e) {
    // TODO: handle setup failure. will output to game console by default
    throw e;
  }
};

// [18.08.2023]
// I saw "attempt to call hooks.add while in hook context" error
// I'm not sure if it's a C++ bug in SkyrimPlatform or an artifact of webpack+hotreload
// But let's for now ensure that "main" executes inside tick context
once("tick", main);
