import { CombinedController, Sp } from "./clientListener";
import { showSystemNotification } from "./systemNotification";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { MsgType } from "../../messages";

// Shared by the widget menu services: same reliable CustomPacket shape, notifications deferred to next update.

export type CustomPacketContent = Record<string, unknown>;
export type CustomPacketHandler = (content: CustomPacketContent) => void;

// Handlers by customPacketType, one router per controller
const routers = new WeakMap<object, Map<string, CustomPacketHandler[]>>();

export function sendCustomPacket(controller: CombinedController, payload: Record<string, unknown>): void {
  const message: CustomPacketMessage = {
    t: MsgType.CustomPacket,
    contentJsonDump: JSON.stringify(payload),
  };
  controller.emitter.emit("sendMessage", { message, reliability: "reliable" });
}

export function parseCustomPacket(contentJsonDump: string): CustomPacketContent | null {
  try {
    const content = JSON.parse(contentJsonDump);
    return content && typeof content === "object" ? content : null;
  } catch {
    return null;
  }
}

// Every handler of a type receives the same parsed object, so handlers must not mutate it
export function onCustomPacket(controller: CombinedController, types: string | string[], handler: CustomPacketHandler): void {
  let router = routers.get(controller.emitter);
  if (!router) {
    router = new Map();
    routers.set(controller.emitter, router);
  }
  for (const type of typeof types === "string" ? [types] : types) {
    const handlers = router.get(type);
    if (handlers) {
      handlers.push(handler);
    } else {
      router.set(type, [handler]);
    }
  }
}

export function dispatchCustomPacket(controller: CombinedController, content: CustomPacketContent): void {
  const type = content["customPacketType"];
  const handlers = typeof type === "string" ? routers.get(controller.emitter)?.get(type) : undefined;
  if (!handlers) return;
  for (const handler of handlers) {
    handler(content);
  }
}

export function notifyNextUpdate(controller: CombinedController, sp: Sp, text: string): void {
  controller.once("update", () => {
    showSystemNotification(sp, text);
  });
}
