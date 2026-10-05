import { once, printConsole } from "@skyrim-platform/skyrim-platform";
import { ClientListener } from "./services/services/clientListener";

// Evaluated with the bundle's first imports, so it stands for the client script's start
export const clientScriptStartedAt = Date.now();

const withStack = (item: unknown): unknown => item instanceof Error ? item.stack || item.message : item;

// TODO: redirect this to spdlog
export function logError(service: ClientListener | string, ...rest: unknown[]) {
    printConsole(`Error in ${typeof service !== "string" ? service.constructor.name : service}:`, ...rest.map(withStack));
}

// TODO: redirect this to spdlog
export function logTrace(service: ClientListener | string, ...rest: unknown[]) {
    printConsole(`Trace in ${typeof service !== "string" ? service.constructor.name : service}:`, ...rest.map(withStack));
}

// printConsole never reaches a file and writeLogs needs a Data/Platform/Logs folder we do not ship, a throw from its own tick reaches skyrim-platform.log
// tick fires every frame, in the main menu and pausing menus too, where update does not
export function logToPlatformLog(service: ClientListener | string, ...rest: unknown[]) {
    const name = typeof service !== "string" ? service.constructor.name : service;
    const text = rest.map((item) => String(withStack(item))).join(" ");
    once("tick", () => { throw new Error(`${name}: ${text}`); });
}
