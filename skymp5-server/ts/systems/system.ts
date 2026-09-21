/* eslint-disable @typescript-eslint/no-explicit-any */

import { EventEmitter } from "events";
import { ScampServer } from "../scampNative";

export interface SystemContext {
  svr: ScampServer;
  gm: EventEmitter;
}

// Emitted on SystemContext.gm once attachSaveStorage has loaded the world DB, after every system's initAsync
export const WORLD_LOADED_EVENT = "worldLoaded";

// Emitted on SystemContext.gm (userId, actorId) when a player opens character select from the game; the body stays until the logout grace ends
export const USER_MENU_QUIT_EVENT = "userMenuQuit";

// Emitted on SystemContext.gm (profileId, CharacterListEntry[]) whenever Spawn sends a character select list
export const CHARACTER_LIST_EVENT = "characterList";

export interface CharacterListEntry {
  slot: number;
  actorId: number;
  dead: boolean;
}

// Emitted on SystemContext.gm (profileId, slot, actorId) just before a character is deleted
export const CHARACTER_RETIRED_EVENT = "characterRetired";

// Emitted on SystemContext.gm (profileId, slot, actorId, realm, reason) when AfterlifeSystem sends a character to Sovngarde or the Soul Cairn; slot is -1 when unknown
export const AFTERLIFE_EVENT = "afterlife";

// Emitted on SystemContext.gm (profileId, access) when a profile's faction access changed in game; access covers every character
export const ACCESS_REFRESHED_EVENT = "accessRefreshed";

export interface System {
  systemName: string;
  initAsync?: (ctx: SystemContext) => Promise<void>;
  updateAsync?: (ctx: SystemContext) => Promise<void>;
  connect?: (userId: number, ctx: SystemContext) => void;
  disconnect?: (userId: number, ctx: SystemContext) => void;
  customPacket?: (
    userId: number,
    type: string,
    content: Content,
    ctx: SystemContext
  ) => void;
}

export type Content = Record<string, any>;
export type Log = (...args: any) => void;
