import { EventEmitterFactory } from "./events/events";
import { ClientListener, ClientListenerConstructor, CombinedController } from "./services/clientListener";
import { logToPlatformLog } from "../logging";
import * as sp from "skyrimPlatform";

type Subscribe = (eventName: string, callback: (...args: any[]) => void) => sp.EventHandle;

const nativeOn = sp.on as Subscribe;
const nativeOnce = sp.once as Subscribe;

interface FrameCallback {
    uid: number;
    callback: () => void;
    runOnce: boolean;
}

// The engine's sub-millisecond clock when it has one
declare const performance: { now(): number } | undefined;
const precise = typeof performance !== "undefined" && performance && typeof performance.now === "function" ? performance : null;
export const frameClock = (): number => (precise ? precise.now() : Date.now());

// Told how long each update or tick dispatch took, every callback of the frame included
export type DispatchWatcher = (eventName: "update" | "tick", ms: number) => void;

// Every update or tick callback runs from one native subscription, in registration order
class FrameEvent {
    constructor(private readonly eventName: "update" | "tick") {
    }

    static watcher: DispatchWatcher | null = null;

    add(callback: () => void, runOnce: boolean): sp.EventHandle {
        if (!this.subscribed) {
            this.subscribed = true;
            nativeOn(this.eventName, () => this.dispatch());
        }
        const uid = --FrameEvent.lastUid;
        this.callbacks = this.callbacks.concat({ uid, callback, runOnce });
        this.hasOnce = this.hasOnce || runOnce;
        return { uid, eventName: this.eventName };
    }

    remove(uid: number): void {
        this.callbacks = this.callbacks.filter((entry) => entry.uid !== uid);
    }

    // As in the native dispatch, callbacks added or removed by a callback count from the next frame
    private dispatch(): void {
        const watcher = FrameEvent.watcher;
        const startedAt = watcher ? frameClock() : 0;
        const callbacks = this.callbacks;
        if (this.hasOnce) {
            this.hasOnce = false;
            this.callbacks = callbacks.filter((entry) => !entry.runOnce);
        }
        for (const entry of callbacks) {
            try {
                entry.callback();
            } catch (e) {
                logToPlatformLog(`${entry.runOnce ? "once" : "on"}('${this.eventName}')`, e);
            }
        }
        if (watcher) watcher(this.eventName, frameClock() - startedAt);
    }

    private callbacks = new Array<FrameCallback>();
    private hasOnce = false;
    private subscribed = false;

    // Below zero, so a native handle's uid never matches
    private static lastUid = 0;
}

export class SpApiInteractor {
    static setup(listeners: ClientListener[]) {
        listeners.forEach(listener => SpApiInteractor.registerListenerForLookup(listener.constructor, listener));
    }

    static getControllerInstance(): CombinedController {
        if (SpApiInteractor.controller) {
            return SpApiInteractor.controller;
        }
        SpApiInteractor.controller = {
            on: (eventName: string, callback: (...args: any[]) => void) => SpApiInteractor.subscribe(eventName, callback, false),
            once: (eventName: string, callback: (...args: any[]) => void) => SpApiInteractor.subscribe(eventName, callback, true),
            unsubscribe: (handle: sp.EventHandle) => {
                const frameEvent = SpApiInteractor.frameEvents.get(handle.eventName);
                if (frameEvent && handle.uid < 0) {
                    frameEvent.remove(handle.uid);
                } else {
                    sp.unsubscribe(handle);
                }
            },
            emitter: EventEmitterFactory.makeEventEmitter(),
            lookupListener<T extends ClientListener>(constructor: ClientListenerConstructor<T>): T {
                const listener = SpApiInteractor.listenersForLookupByName.get(constructor);
                if (listener === undefined) {
                    throw new Error(`listener not found for name '${constructor.name}'`);
                }
                if (!(listener instanceof constructor)) {
                    throw new Error(`listener class mismatch for name '${constructor.name}'`);
                }
                return listener;
            },
        }
        return SpApiInteractor.controller;
    }

    // One watcher, FrameStatsService
    static watchDispatch(watcher: DispatchWatcher | null): void {
        FrameEvent.watcher = watcher;
    }

    private static subscribe(eventName: string, callback: (...args: any[]) => void, runOnce: boolean): sp.EventHandle {
        const frameEvent = SpApiInteractor.frameEvents.get(eventName);
        if (frameEvent) {
            return frameEvent.add(callback, runOnce);
        }
        return (runOnce ? nativeOnce : nativeOn)(eventName, callback);
    }

    private static registerListenerForLookup(constructor: Function, listener: ClientListener): void {
        if (SpApiInteractor.listenersForLookupByName.has(constructor)) {
            throw new Error(`listener re-registration for name '${constructor}'`);
        }
        SpApiInteractor.listenersForLookupByName.set(constructor, listener);
    }

    private static listenersForLookupByName = new Map<Function, ClientListener>();

    private static frameEvents = new Map<string, FrameEvent>([["update", new FrameEvent("update")], ["tick", new FrameEvent("tick")]]);

    private static controller?: CombinedController;
}
