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
    const { settings } = this.sp;
    const showMe = settings['skymp5-client']['show-me'];
    this.state.formViews.syncFormView(model, !!showMe);
  }

  destroy() {
    this.state.formViews.resize(0);
    this.state.cloneFormViews.resize(0); // Recenrly added, not tested if it's needed
    this.state = this.makeEmptyState();
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
      this.state.formViews.resize(0);
      this.state.cloneFormViews.resize(0);
    }
    this.controller.emitter.emit("playerWorldOrCellChanged", e);
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
    const { settings } = this.sp;
    const state = this.state;

    if (!state.allowUpdate) {
      model = {
        forms: [],
        playerCharacterFormIdx: model.playerCharacterFormIdx,
        playerCharacterRefrId: model.playerCharacterRefrId
      }
    }

    const skipUpdates = settings['skymp5-client']['skipUpdates'];

    // skip 50% of updates if specified in the settings
    state.counter = !state.counter;
    if (state.counter && skipUpdates) {
      return;
    }

    state.formViews.resize(model.forms.length);

    const showMe = settings['skymp5-client']['show-me'];
    const showClones = settings['skymp5-client']['show-clones'];

    state.formViews.updateAll(model, !!showMe, false);

    if (showClones) {
      state.cloneFormViews.updateAll(model, false, true);
    } else {
      state.cloneFormViews.resize(0);
    }
  }

  private makeEmptyState() {
    return {
      formViews: new FormViewArray(),
      cloneFormViews: new FormViewArray(),
      allowUpdate: false,
      counter: false,
    }
  }

  private state: {
    formViews: FormViewArray;
    cloneFormViews: FormViewArray;
    allowUpdate: boolean;
    counter: boolean;
  };

  private oldView?: WorldView;
}
