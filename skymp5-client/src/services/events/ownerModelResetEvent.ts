import { FormModel } from "../../view/model";

// Emitted by RemoteServer when the own CreateActor replaces storage.ownerModel
export interface OwnerModelResetEvent {
    model: FormModel;
}
