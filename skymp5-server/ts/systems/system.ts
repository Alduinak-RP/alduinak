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
