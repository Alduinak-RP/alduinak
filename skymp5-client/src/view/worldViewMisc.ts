import { Game, ObjectReference, storage } from "skyrimPlatform";
import { WorldView } from "./worldView";
import { SpApiInteractor } from '../services/spApiInteractor';
import { RemoteServer } from "../services/services/remoteServer";
import { FormModel } from "./model";

export const getViewFromStorage = (): WorldView | undefined => {
  const res = storage["view"] as WorldView;
  // can't use instanceof here because each hot reload creates a new class
  if (typeof res === "object") {
    return res;
  }
  return undefined;
};

export const localIdToRemoteId = (localFormId: number, newCast: boolean = false): number => {
  if (newCast && localFormId == 0x14) {
    return SpApiInteractor.getControllerInstance().lookupListener(RemoteServer).getMyRemoteRefrId();
  }

  if (localFormId >= 0xff000000) {
    const view = getViewFromStorage();
    if (!view) {
      return 0;
    }
    localFormId = view.getRemoteRefrId(localFormId);
    if (!localFormId) {
      return 0;
    }
    // serverside ids are 64bit
    if (localFormId >= 0x100000000) {
      localFormId -= 0x100000000;
    }
  }
  return localFormId;
};

export const remoteIdToLocalId = (remoteFormId: number): number => {
  if (remoteFormId >= 0xff000000) {
    const view = getViewFromStorage();
    if (!view) {
      return 0;
    }
    remoteFormId = view.getLocalRefrId(remoteFormId);
    if (!remoteFormId) {
      return 0;
    }
  }
  return remoteFormId;
};

// Hosted ids are remote ids, some stored with the 64-bit server offset
export const isRemoteHostedByMe = (remoteId: number): boolean => {
  const hosted = storage["hosted"];
  return remoteId !== 0 && Array.isArray(hosted) && (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000));
};

export const isHostedByMe = (localFormId: number): boolean => isRemoteHostedByMe(localIdToRemoteId(localFormId));

// The server also routes isHostedByOther to the host; a HostStart outranks it while the NPC is loaded here, where a stale one soon gets its HostStop
export const isModelHostedByOther = (model: FormModel): boolean => {
  if (model.isHostedByOther !== true) {
    return false;
  }
  const remoteId = model.refrId ?? 0;
  return !isRemoteHostedByMe(remoteId) || !ObjectReference.from(Game.getFormEx(remoteIdToLocalId(remoteId)))?.is3DLoaded();
};

// True once the local player was introduced to this remote character (ff_knownIds owner prop); a gamemode without introductions knows everyone
export const knowsCharacter = (remoteId: number): boolean => {
  if (storage["ownerModelSet"] !== true) {
    return true;
  }
  const owner = storage["ownerModel"] as Record<string, unknown> | undefined;
  const known = owner ? owner["ff_knownIds"] : undefined;
  return !Array.isArray(known) || known.includes(remoteId);
};

// A player character's name for the local player: display name once introduced, else Body or Stranger (GetName is empty on references)
export const introducedName = (ref: ObjectReference, remoteId: number, dead: boolean): string => {
  const name = (ref.getDisplayName() || "").trim();
  return name && knowsCharacter(remoteId) ? name : dead ? "Body" : "Stranger";
};

// "hex:Plugin" to this client's form id, 0 when the plugin or record is missing; natives need a game context
export const formIdFromDesc = (desc: unknown): number => {
  if (typeof desc !== "string") return 0;
  const sep = desc.indexOf(":");
  if (sep <= 0) return 0;
  try {
    const form = Game.getFormFromFile(parseInt(desc.slice(0, sep), 16), desc.slice(sep + 1));
    return form ? form.getFormID() : 0;
  } catch {
    return 0;
  }
};

export const getObjectReference = (i: number): ObjectReference | null => {
  const view = getViewFromStorage();
  if (view) {
    const formView = view.getFormViews().getNthFormView(i);
    if (formView) {
      const refrId = formView.getLocalRefrId();
      if (refrId > 0) {
        const refr = ObjectReference.from(Game.getFormEx(refrId));
        if (refr !== null) {
          return refr;
        }
      }
    }
  }
  return null;
};
