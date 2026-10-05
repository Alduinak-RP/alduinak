import { OpenCloseEvent } from 'skyrimPlatform';
import { WorldModel } from './model';
import { FormViewArray } from './formViewArray';
import { PlayerCharacterDataHolder } from './playerCharacterDataHolder';
import { ClientListener, CombinedController, Sp } from '../services/services/clientListener';
import { logTrace } from "../logging";
import { SinglePlayerService } from "../services/services/singlePlayerService";
import { RemoteServer } from "../services/services/remoteServer";
import { PlayerWorldOrCellChangedEvent } from "../services/events/playerWorldOrCellChangedEvent";

export class WorldView extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();

    controller.on("update", () => this.onUpdate());
    controller.once("update", () => this.onceUpdate());
    controller.on("crosshairRefChanged", (e) => PlayerCharacterDataHolder.setCrosshairRef(e.reference));
    controller.on("open", (e) => this.onOpenClose(e));
    controller.on("close", (e) => this.onOpenClose(e));
    controller.on("loadGame", () => this.state.formViews.forgetLoaded3D());

    this.state = this.makeEmptyState();

    const oldView = this.sp.storage["view"];

    // can't use instanceof here because each hot reload creates a new class
    this.oldView = typeof oldView === "object" ? oldView as WorldView : undefined;

    this.sp.storage["view"] = this;
  }

  getRemoteRefrId(clientsideRefrId: number): number {
    return this.state.formViews.getRemoteRefrId(clientsideRefrId);
  }

  getLocalRefrId(remoteRefrId: number): number {
    return this.state.formViews.getLocalRefrId(remoteRefrId);
  }

  syncFormArray(model: WorldModel) {
    this.state.formViews.syncFormView(model);
  }

  destroy() {
    this.resetFormViews();
    this.state = this.makeEmptyState();
  }

  resetFormViews() {
    this.state.formViews.resize(0);
  }

  getFormViews() {
    return this.state.formViews;
  }

  private onUpdate() {
    const worldOrCellChange = PlayerCharacterDataHolder.updateData();
    if (worldOrCellChange) {
      this.onPlayerWorldOrCellChanged(worldOrCellChange);
    }
    // Copies spawn at the player, so form views wait while the player has no world or cell
    if (!PlayerCharacterDataHolder.getWorldOrCell()) {
      return;
    }

    const singlePlayerService = this.controller.lookupListener(SinglePlayerService);
    if (!singlePlayerService.isSinglePlayer) {
      const modelSource = this.controller.lookupListener(RemoteServer);
      this.updateWorld(modelSource.getWorldModel());
    }
  }

  private onceUpdate() {
    PlayerCharacterDataHolder.setCrosshairRef(this.sp.Game.getCurrentCrosshairRef());
    if (this.oldView) {
      this.oldView.destroy();
      this.oldView = undefined;
      logTrace(this, 'Previous View destroyed');
    }
    this.waitGameTimeAndAllowFormViewUpdate(1.0);
  }

  private onPlayerWorldOrCellChanged(e: PlayerWorldOrCellChangedEvent) {
    if (e.previous) {
      logTrace(this, 'Reset all form views');
      this.resetFormViews();
    }
    this.controller.emitter.emit("playerWorldOrCellChanged", e);
  }

  private onOpenClose(e: OpenCloseEvent) {
    const localId = e.target?.getFormID();
    if (localId) {
      this.state.formViews.noteOpenClose(localId);
    }
  }

  // Work around showRaceMenu issue
  // Default nord in Race Menu will have very ugly face
  // If other players are spawning when we show this menu
  // TODO: separate listener
  public waitGameTimeAndAllowFormViewUpdate(seconds: number) {
    // Wait 1s game time (time spent in Race Menu isn't counted)
    this.sp.Utility.wait(seconds).then(() => {
      this.state.allowUpdate = true;
      logTrace(this, 'Update is now allowed');
    });
  }

  public setFormViewUpdateAllowed(allowed: boolean) {
    this.state.allowUpdate = allowed;
    logTrace(this, 'Update is now', allowed ? 'allowed' : 'disallowed');
  }

  private updateWorld(model: WorldModel): void {
    const state = this.state;

    if (!state.allowUpdate) {
      model = {
        forms: [],
        playerCharacterFormIdx: model.playerCharacterFormIdx,
        playerCharacterRefrId: model.playerCharacterRefrId
      }
    }

    state.formViews.resize(model.forms.length);
    state.formViews.updateAll(model);
  }

  private makeEmptyState() {
    return {
      formViews: new FormViewArray(),
      allowUpdate: false,
    }
  }

  private state: {
    formViews: FormViewArray;
    allowUpdate: boolean;
  };

  private oldView?: WorldView;
}
