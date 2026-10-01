import { Log } from "./system";
import { addSpellTo, hex, removeSpellFrom } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Server-granted abilities that must survive the client's load: stage abilities (one of a group held at a time, such as the hunger
// stages) and permanent grants (a group of one spell, held or not).
// The client wipes and re-applies learnedSpells about a second after its load; a change has to land after that. The load can outlast
// the first delay, so the packets the client sends once per load (weatherRequest and gameTimeRequest at its loadGame, a system's own
// request at its createActor) each schedule a re-send of any ability changed during the login window, which the wipe would otherwise
// have dropped. A snippet only goes out when the server's list changes, so a re-send adds then removes each spell of a group that is
// not held and removes then adds the held one.

export const LOGIN_SYNC_DELAY_MS = 5000;
export const RESYNC_DELAY_MS = 3000;
export const LOGIN_WINDOW_MS = 3 * 60000;
export const LOAD_PACKETS = new Set(["weatherRequest", "gameTimeRequest"]);

// The spells one field may hold and the one it holds, 0 for none
export interface AbilityGroup {
  what: string;
  held: number;
  stages: number[];
}

interface Tracked {
  assignedAt: number;
  // Changes wait until then after an assign, 0 once the delay ran out
  syncAt: number;
  // A re-send is due then, 0 for none
  resyncAt: number;
  // An ability changed inside the login window
  swapped: boolean;
}

export class StageAbilityTracker {
  // tag names the system in the log lines, as "[needs]"
  constructor(private tag: string, private log: Log) { }

  // A character came online: changes wait LOGIN_SYNC_DELAY_MS and those inside the login window get re-sent
  begin(actorId: number, now = Date.now()): void {
    this.actors.set(actorId, { assignedAt: now, syncAt: now + LOGIN_SYNC_DELAY_MS, resyncAt: 0, swapped: false });
  }

  end(actorId: number): void {
    this.actors.delete(actorId);
  }

  // True while the login delay holds changes back
  waiting(actorId: number, now = Date.now()): boolean {
    const t = this.actors.get(actorId);
    return !!t && !!t.syncAt && now < t.syncAt;
  }

  // True once, when the login delay has run out
  takeLoginSync(actorId: number, now: number): boolean {
    const t = this.actors.get(actorId);
    if (!t || !t.syncAt || now < t.syncAt) return false;
    t.syncAt = 0;
    return true;
  }

  // A once-per-load packet arrived
  scheduleResend(actorId: number, now = Date.now()): void {
    const t = this.actors.get(actorId);
    if (t) t.resyncAt = now + RESYNC_DELAY_MS;
  }

  // True once, when a scheduled re-send is due
  takeResend(actorId: number, now: number): boolean {
    const t = this.actors.get(actorId);
    if (!t || !t.resyncAt || now < t.resyncAt) return false;
    t.resyncAt = 0;
    return true;
  }

  swappedSinceLogin(actorId: number): boolean {
    return !!this.actors.get(actorId)?.swapped;
  }

  // Past the login window no load wipe is left to undo a change
  expire(actorId: number, now: number): void {
    const t = this.actors.get(actorId);
    if (t && t.swapped && now - t.assignedAt > LOGIN_WINDOW_MS) t.swapped = false;
  }

  // Removes held and learns want; true when they differ and both calls went through, and the caller then stores want
  swap(mp: Mp, actorId: number, held: number, want: number, what: string): boolean {
    if (held === want) return false;
    try {
      if (held) removeSpellFrom(mp, actorId, held);
      if (want) addSpellTo(mp, actorId, want);
    } catch (e) {
      this.log(`[${this.tag}] ${what} swap failed for ${hex(actorId)}: ${e}`);
      return false;
    }
    this.noteChange(actorId);
    return true;
  }

  // Learns a spell the character must hold whatever its record says; true when it was not known yet
  grant(mp: Mp, actorId: number, spellId: number, what: string): boolean {
    if (!spellId) return false;
    try {
      if (!addSpellTo(mp, actorId, spellId)) return false;
    } catch (e) {
      this.log(`[${this.tag}] ${what} grant failed for ${hex(actorId)}: ${e}`);
      return false;
    }
    this.noteChange(actorId);
    return true;
  }

  // Undoes each group's changes the load wipe may have dropped, when any fell inside the login window
  resend(mp: Mp, actorId: number, groups: AbilityGroup[]): void {
    if (!this.swappedSinceLogin(actorId)) return;
    for (const { what, held, stages } of groups) {
      try {
        for (const stale of stages) {
          if (!stale || stale === held) continue;
          addSpellTo(mp, actorId, stale);
          removeSpellFrom(mp, actorId, stale);
        }
        if (held) {
          removeSpellFrom(mp, actorId, held);
          addSpellTo(mp, actorId, held);
        }
        this.log(`[${this.tag}] ${hex(actorId)} ${held ? `ability resent after login ${hex(held)}, other stages cleared` : `${what} stages cleared after login`}`);
      } catch (e) {
        this.log(`[${this.tag}] ${what} re-send failed for ${hex(actorId)}: ${e}`);
      }
    }
  }

  private noteChange(actorId: number): void {
    const t = this.actors.get(actorId);
    if (t && Date.now() - t.assignedAt < LOGIN_WINDOW_MS) t.swapped = true;
  }

  private actors = new Map<number, Tracked>();
}
