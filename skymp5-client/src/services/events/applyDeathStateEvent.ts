import { Actor } from "skyrimPlatform";
import { NiPoint3 } from "../../sync/movement";

export interface ApplyDeathStateEvent {
    actor: Actor;
    isDead: boolean;
    // Which sync path asked for the death, and where the server holds the actor, for the kill log line
    trigger?: string;
    serverPos?: NiPoint3;
}
