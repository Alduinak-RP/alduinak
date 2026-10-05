import { FormView } from "./formView";
import { FormModel, WorldModel } from "./model";
import { NiPoint3 } from "../sync/movement";
import { SpApiInteractor } from "../services/spApiInteractor";
import { GamemodeUpdateService } from "../services/services/gamemodeUpdateService";

export class FormViewArray {
  updateForm(form: FormModel, i: number) {
    const view = this.formViews[i];
    if (!view) {
      const created = new FormView(form.refrId, (v, previous) => this.indexLocalId(v, previous));
      this.formViews[i] = created;
      if (form.refrId !== undefined && form.refrId >= 0xff000000) {
        this.viewByRemoteId.set(form.refrId, created);
      }
    } else {
      view.update(form);
    }
  }

  destroyForm(i: number) {
    const formView = this.formViews[i];
    if (formView === undefined) {
      return;
    }

    this.discard(formView);
    this.formViews[i] = undefined;
  }

  resize(newSize: number) {
    if (this.formViews.length > newSize) {
      this.formViews.slice(newSize).forEach((v) => v && this.discard(v));
    }
    this.formViews.length = newSize;
  }

  updateAll(model: WorldModel, showMe: boolean, isCloneView: boolean) {
    const gamemodeUpdateService = SpApiInteractor.getControllerInstance().lookupListener(GamemodeUpdateService);
    gamemodeUpdateService.setFormViewArray(this);

    const forms = model.forms;
    const n = forms.length;
    for (let i = 0; i < n; ++i) {
      const form = forms[i];

      if (!form || (model.playerCharacterFormIdx === i && !showMe)) {
        this.destroyForm(i);
        continue;
      }

      let realPos: NiPoint3 | undefined = undefined;
      const offset = model.playerCharacterFormIdx === i || isCloneView;

      if (offset && form.movement) {
        realPos = form.movement.pos;
        form.movement.pos = [
          realPos[0] + 128,
          realPos[1] + 128,
          realPos[2],
        ];
      }

      if (isCloneView) {
        // Prevent using the same refr by normal and clone views
        if (!form.refrId || form.refrId >= 0xff000000) {
          const backup = form.isHostedByOther;
          form.isHostedByOther = true;
          // TODO: Explain why do not GamemodeApiSupport.setI(i); here
          this.updateForm(form, i);
          form.isHostedByOther = backup;
        }
      } else {
        gamemodeUpdateService.setI(i);
        this.updateForm(form, i);
      }

      if (offset && form.movement && realPos) {
        form.movement.pos = realPos;
      }
    }
  }

  syncFormView(model: WorldModel, showMe: boolean,) {
    for (let i = 0; i < model.forms.length; ++i) {
      if (!model.forms[i] || (model.playerCharacterFormIdx === i && !showMe)) {
        this.destroyForm(i);
        continue;
      }
    }
  }

  getRemoteRefrId(clientsideRefrId: number): number {
    if (clientsideRefrId < 0xff000000)
      throw new Error("This function is only for 0xff forms");
    const formView = this.viewByLocalId.get(clientsideRefrId);
    return formView ? formView.getRemoteRefrId() : 0;
  }

  getLocalRefrId(remoteRefrId: number): number {
    if (remoteRefrId < 0xff000000)
      throw new Error("This function is only for 0xff forms");
    const formView = this.viewByRemoteId.get(remoteRefrId);
    return formView ? formView.getLocalRefrId() : 0;
  }

  getNthFormView(i: number): FormView | undefined {
    return this.formViews[i];
  }

  getFormViewsArrayLength(): number {
    return this.formViews.length;
  }

  // An entry is removed only while it still points at this view, so a duplicated id keeps the newer view
  private indexLocalId(view: FormView, previous: number) {
    if (this.viewByLocalId.get(previous) === view) {
      this.viewByLocalId.delete(previous);
    }
    const id = view.getLocalRefrId();
    if (id >= 0xff000000) {
      this.viewByLocalId.set(id, view);
    }
  }

  private discard(view: FormView) {
    view.destroy();
    const localId = view.getLocalRefrId();
    if (this.viewByLocalId.get(localId) === view) {
      this.viewByLocalId.delete(localId);
    }
    const remoteId = view.getRemoteRefrId();
    if (this.viewByRemoteId.get(remoteId) === view) {
      this.viewByRemoteId.delete(remoteId);
    }
  }

  private formViews = new Array<FormView | undefined>();
  private viewByLocalId = new Map<number, FormView>();
  private viewByRemoteId = new Map<number, FormView>();
}
