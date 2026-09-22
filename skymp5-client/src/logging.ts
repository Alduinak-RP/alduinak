import { once, printConsole } from "@skyrim-platform/skyrim-platform";
import { ClientListener } from "./services/services/clientListener";

// TODO: redirect this to spdlog
export function logError(service: ClientListener | string, ...rest: unknown[]) {

    const restProcessed = rest.map(item => {
        if (item instanceof Error) {
            return item.stack || item.message;
        }

        return item;
    });

    printConsole(`Error in ${typeof service !== "string" ? service.constructor.name : service}:`, ...restProcessed);
}

// TODO: redirect this to spdlog
export function logTrace(service: ClientListener | string, ...rest: unknown[]) {
    const restProcessed = rest.map(item => {
        if (item instanceof Error) {
            return item.stack || item.message;
        }

        return item;
    });

    printConsole(`Trace in ${typeof service !== "string" ? service.constructor.name : service}:`, ...restProcessed);
}

// printConsole never reaches a file and writeLogs needs a Data/Platform/Logs folder we do not ship, a throw from its own tick reaches skyrim-platform.log
// tick fires every frame, in the main menu and pausing menus too, where update does not
export function logToPlatformLog(service: ClientListener | string, ...rest: unknown[]) {
    const name = typeof service !== "string" ? service.constructor.name : service;
    const text = rest.map(String).join(" ");
    once("tick", () => { throw new Error(`${name}: ${text}`); });
}
