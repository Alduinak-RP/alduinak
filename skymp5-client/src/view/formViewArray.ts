import { FormView } from "./formView";
import { FormModel, WorldModel } from "./model";
import { SpApiInteractor } from "../services/spApiInteractor";
import { GamemodeUpdateService } from "../services/services/gamemodeUpdateService";

export class FormViewArray {
  updateForm(form: FormModel, i: number, tagPass: boolean) {
    const view = this.formViews[i];
    if (!view) {
      const created = new FormView(form.refrId, (v, previous) => this.indexLocalId(v, previous));
      this.formViews[i] = created;
      if (form.refrId !== undefined && form.refrId >= 0xff000000) {
        this.viewByRemoteId.set(form.refrId, created);
      }
    } else {
      view.update(form, tagPass);
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

  updateAll(model: WorldModel, tagPass: boolean) {
    const gamemodeUpdateService = SpApiInteractor.getControllerInstance().lookupListener(GamemodeUpdateService);
    gamemodeUpdateService.setFormViewArray(this);

    const forms = model.forms;
    const n = forms.length;
    for (let i = 0; i < n; ++i) {
      const form = forms[i];

      if (!form || model.playerCharacterFormIdx === i) {
        this.destroyForm(i);
        continue;
      }

      gamemodeUpdateService.setI(i);
      this.updateForm(form, i, tagPass);
    }
  }

  syncFormView(model: WorldModel) {
    for (let i = 0; i < model.forms.length; ++i) {
      if (!model.forms[i] || model.playerCharacterFormIdx === i) {
        this.destroyForm(i);
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

  noteOpenClose(localId: number) {
    this.viewByLocalId.get(localId)?.noteOpenClose();
  }

  forgetLoaded3D() {
    this.formViews.forEach((v) => v?.forgetLoaded3D());
  }

  getNthFormView(i: number): FormView | undefined {
    return this.formViews[i];
  }

  getFormViewsArrayLength(): number {
    return this.formViews.length;
  }

  // An entry is removed only while it still points at this view, so a duplicated id keeps the newer view; plugin doors are indexed for their open and close events
  private indexLocalId(view: FormView, previous: number) {
    if (this.viewByLocalId.get(previous) === view) {
      this.viewByLocalId.delete(previous);
    }
    const id = view.getLocalRefrId();
    if (id) {
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
