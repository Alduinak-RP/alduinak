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

// printConsole never reaches skyrim-platform.log, a throw from its own update does and still prints
export function logToPlatformLog(service: ClientListener | string, ...rest: unknown[]) {
    const name = typeof service !== "string" ? service.constructor.name : service;
    const text = rest.map(String).join(" ");
    once("update", () => { throw new Error(`${name}: ${text}`); });
}
