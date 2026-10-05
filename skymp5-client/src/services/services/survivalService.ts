import { Actor, MagicEffect, Menu, ObjectReference } from "skyrimPlatform";
import { ClientListener, CombinedController, Sp } from "./clientListener";
import { ConnectionMessage } from "../events/connectionMessage";
import { SpSnippetMessage } from "../messages/spSnippetMessage";
import { sendCustomPacket, CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { onWidgetsCleared } from "./widgetMenuUtil";
import { isMenuShown } from "./menuStateService";
import { NeedsService, UPDATE_ESM, globalOf, readGlobal } from "./needsService";
import { RemoteServer } from "./remoteServer";
import { applyAttributePenalty, COLD_PENALTY_AV } from "../../sync/attributePenalty";
import { refreshMovement } from "../../sync/actorvalues";
import { ObjectReferenceEx } from "../../extensions/objectReferenceEx";
import { FormModel } from "../../view/model";
import { logToPlatformLog } from "../../logging";

const PLAYER_ID = 0x14;
const ALDUINAK_PLUGIN = "AlduinakAdditions.esp";
// Survival_ColdAttributePenaltyPercent (SRCP), the health meter's red end, and Survival_TemperatureLevel (SRTP), the compass thermometer
const COLD_PENALTY_GLOBAL = 0x2ede;
const TEMPERATURE_GLOBAL = 0x2edd;
// Skyrim.esm FireCloakFFSelf, MGRJZargoFireCloakFFSelf and PowerDarkElfFireCloakFFSelf, the cloaks Survival_FreezingWaterCheck spares
const FLAME_CLOAK_EFFECTS = [0x3ae9e, 0x97ee2, 0xb8f30];

const range = (first: number, last: number): number[] => Array.from({ length: last - first + 1 }, (_, i) => first + i);

// Every Disease type spell of the load order: vanilla and trap diseases, Survival's stages and food poisoning, the plugin's AldDisease_* block
const DISEASE_SPELLS: Array<[string, number[]]> = [
  ["Skyrim.esm", [0xb877c, 0xb877e, 0xb877f, 0xb8780, 0xb8781, 0xb8782, 0xb8783, 0x10a24a, 0x10a24c, 0x10a24d, 0x10a24e, 0x10a24f, 0x10a250]],
  ["Dawnguard.esm", [0x37e9]],
  ["Dragonborn.esm", [0x1ff2e, 0x285c1]],
  ["ccQDRSSE001-SurvivalMode.esl", [0x82e, 0x830, 0x912, 0x914, 0x915, 0x918, ...range(0x984, 0x997)]],
  [ALDUINAK_PLUGIN, range(0x41341, 0x41391)],
];

const POLL_MS = 500;
const GUARD_MS = 60000;
// A hit or an effect on the player brings the disease guard forward to this long after it
const GUARD_AFTER_HARM_MS = 2000;
// A guard run after a harm or one that marked a disease is followed by another this long later; a harm never brings a run closer than this to the last
const GUARD_CONFIRM_MS = 10000;
// The server reads the worn warmth at its 15 s cold step, so the engine total goes out once one has run after the last change
const WARMTH_REPORT_MS = 20000;
// The server's stage and disease spells land after the state, and SpeedMult counts once their effects run
const MOVEMENT_REFRESH_MS = 2000;
// The HUD line is logged again when the penalty crosses one of these steps, in percent
const PENALTY_LOG_STEP = 5;
// Set by SurvivalSystem on each player: the contagious disease ids they carry, or null
const CONTAGIOUS_PROP = "ff_contagious";

interface ContagionCheck {
  seconds: number;
  range: number;
}

interface SurvivalState {
  cold: number;
  coldStage: number;
  coldStageName: string;
  coldPenalty: number;
  temperatureLevel: number;
  warmth: number;
  freezingArea: boolean;
  afflictions: string[];
  diseases: Array<{ name: string; stage: number }>;
  contagion: ContagionCheck | null;
}

const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

const parseContagion = (v: unknown): ContagionCheck | null => {
  const c = v && typeof v === "object" ? v as Record<string, unknown> : {};
  const seconds = num(c["seconds"], 0);
  const range = num(c["range"], 0);
  return seconds > 0 && range > 0 ? { seconds, range } : null;
};

const contagiousOf = (form: FormModel | undefined): string[] => {
  const v = form ? (form as Record<string, unknown>)[CONTAGIOUS_PROP] : null;
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === "string") : [];
};

const parseState = (content: Record<string, unknown>): SurvivalState => ({
  cold: num(content["cold"], -1),
  coldStage: num(content["coldStage"], -1),
  coldStageName: String(content["coldStageName"] || ""),
  coldPenalty: Math.max(0, Math.min(1, num(content["coldPenalty"], 0))),
  temperatureLevel: num(content["temperatureLevel"], 0),
  warmth: num(content["warmth"], 0),
  freezingArea: content["freezingArea"] === true,
  afflictions: Array.isArray(content["afflictions"]) ? (content["afflictions"] as unknown[]).map(String) : [],
  diseases: Array.isArray(content["diseases"])
    ? (content["diseases"] as unknown[]).filter((d) => d && typeof d === "object")
      .map((d) => ({ name: String((d as Record<string, unknown>)["name"] || ""), stage: num((d as Record<string, unknown>)["stage"], 1) }))
    : [],
  contagion: parseContagion(content["contagion"]),
});

const hex = (id: number): string => (id >>> 0).toString(16);
const listText = (items: string[]): string => items.join(", ") || "none";

/**
 * Survival on the client. The server (SurvivalSystem) owns cold, afflictions and diseases and pushes survivalState; this
 * service takes the cold share of maximum health like the hunger and fatigue penalties, drives the health meter's red
 * end and the compass thermometer, refreshes the movement speed when the stage or disease spells change, reports
 * swimming, a flame cloak and the engine's warmth total, and drops a disease the player's own engine gave that the
 * server never granted. The server deals the freezing water damage from the swimming report, so AldSurvival_FreezingArea
 * is never set and the plugin's own water damage spell stays inert. What the server granted is the spawn's
 * learnedSpells plus every Actor AddSpell and RemoveSpell snippet it sent the player since. Nothing runs until a
 * survivalState arrives.
 * Contagion is checked here so the server does no proximity work: every contagion.seconds, from a random first second,
 * the players this client has loaded within contagion.range (the chat whisper range) whose ff_contagious names a
 * disease the player's own ff_contagious lacks go out in one survivalExposure; nothing is sent when nobody is near. The
 * server checks the records and rolls. Skipping the report only spares this player; it can never infect anyone else.
 *
 *   Client -> Server: { "customPacketType": "survivalRequest" }
 *                     { "customPacketType": "survivalReport", "swimming", "flameCloak", "engineWarmth"? }
 *                     { "customPacketType": "survivalExposure", "sources": [{ "actorId", "diseases": [id] }] }
 *   Server -> Client: { "customPacketType": "survivalState", "cold", "coldStage", "coldStageName", "coldPenalty",
 *                       "temperatureLevel", "warmth", "freezingArea", "afflictions", "diseases", "contagion": { "seconds", "range" } | null }
 */
export class SurvivalService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    onCustomPacket(this.controller, "survivalState", (content) => this.onCustomPacketMessage(content));
    this.controller.emitter.on("spSnippetMessage", (e) => this.onSpSnippet(e));
    this.controller.emitter.on("createActorMessage", (e) => { if (e.message.isMe) this.serverSpells.clear(); });
    // A new actor starts over on the server: swimming false and no warmth compared yet
    onWidgetsCleared(this.controller, () => this.controller.once("update", () => {
      this.reported = "";
      this.unlistedSeen = [];
      this.warmthDueAt = 0;
      this.contagionAt = 0;
      this.firstState = true;
      this.cloakDue = true;
      this.request();
    }));
    // A load resets the globals and may carry a stale Variable04
    this.controller.on("loadGame", () => this.controller.once("update", () => {
      logToPlatformLog(this, `before load re-apply: ${this.describeHealth()}`);
      this.hudLogKey = "";
      this.cloakDue = true;
      this.apply();
      this.request();
    }));
    this.controller.on("equip", (e) => this.onEquipChange(e.actor));
    this.controller.on("unequip", (e) => this.onEquipChange(e.actor));
    this.controller.on("effectStart", (e) => this.onEffectStart(e.effect, e.target));
    this.controller.on("hit", (e) => this.onHarm(e.target));
    this.controller.on("magicEffectApply", (e) => this.onHarm(e.target));
    this.controller.on("update", () => this.onUpdate());
  }

  private request(): void {
    sendCustomPacket(this.controller, { customPacketType: "survivalRequest" });
  }

  private describeHealth(): string {
    const player = this.sp.Game.getPlayer();
    if (!player) return "no player";
    return `healthMax=${Math.round(player.getActorValueMax("Health"))} v04=${Math.round(player.getActorValue(COLD_PENALTY_AV))}`;
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const before = this.state;
    const state = parseState(content);
    this.state = state;
    const moveKey = JSON.stringify([state.coldStage, state.diseases]);
    if (before && moveKey !== this.moveKey) {
      this.refreshAt = Date.now() + MOVEMENT_REFRESH_MS;
      this.refreshWhy = `cold stage ${before.coldStage} -> ${state.coldStage}, diseases ${this.diseaseText(before)} -> ${this.diseaseText(state)}`;
    }
    this.moveKey = moveKey;
    if (this.firstState) {
      this.firstState = false;
      if (state.coldStage >= 0) this.warmthDueAt = Date.now() + WARMTH_REPORT_MS;
    }
    this.controller.lookupListener(NeedsService).setSurvivalReadout({
      coldStage: state.coldStage, coldStageName: state.coldStageName, warmth: state.coldStage >= 0 ? state.warmth : -1,
    });
    this.controller.once("update", () => this.apply());
  }

  private diseaseText(state: SurvivalState): string {
    return listText(state.diseases.map((d) => `${d.name} ${d.stage}`));
  }

  private apply(): void {
    const player = this.sp.Game.getPlayer();
    if (!this.state || !player) return;
    applyAttributePenalty(player, "Health", COLD_PENALTY_AV, this.state.coldPenalty);
    this.setHud();
  }

  private setHud(): void {
    const state = this.state;
    if (!state) return;
    const set = (id: number, value: number): void => globalOf(this.sp, id, UPDATE_ESM)?.setValue(value);
    set(COLD_PENALTY_GLOBAL, Math.round(state.coldPenalty * 100));
    set(TEMPERATURE_GLOBAL, state.temperatureLevel);
    const cold = readGlobal(this.sp, COLD_PENALTY_GLOBAL, UPDATE_ESM);
    const temperature = readGlobal(this.sp, TEMPERATURE_GLOBAL, UPDATE_ESM);
    const key = `${typeof cold === "number" ? Math.floor(cold / PENALTY_LOG_STEP) : cold}|${temperature}|${state.freezingArea}|${state.coldStage}`;
    if (key === this.hudLogKey) return;
    this.hudLogKey = key;
    logToPlatformLog(this, `survival hud cold=${cold} temperature=${temperature} (freezing water area ${state.freezingArea ? "yes" : "no"}), ` +
      `cold ${state.cold} stage ${state.coldStage} ${state.coldStageName || "off"}, warmth ${state.warmth}, ` +
      `afflictions ${listText(state.afflictions)}, diseases ${this.diseaseText(state)}, ${this.describeHealth()}`);
  }

  private onEquipChange(actor: ObjectReference | null): void {
    if (!this.state || this.state.coldStage < 0 || actor?.getFormID() !== PLAYER_ID) return;
    this.warmthDueAt = Date.now() + WARMTH_REPORT_MS;
  }

  // A cloak on the player is read at the next poll; one in force is read every poll, which also sees it end
  private onEffectStart(effect: MagicEffect | null, target: ObjectReference | null): void {
    if (this.cloakDue || this.flameCloak || !effect || FLAME_CLOAK_EFFECTS.indexOf(effect.getFormID()) === -1) return;
    if (target?.getFormID() === PLAYER_ID) this.cloakDue = true;
  }

  private onHarm(target: ObjectReference | null): void {
    if (this.harmed || target?.getFormID() !== PLAYER_ID) return;
    this.harmed = true;
    this.guardAt = Math.min(this.guardAt, Math.max(Date.now() + GUARD_AFTER_HARM_MS, this.guardRanAt + GUARD_CONFIRM_MS));
  }

  private onUpdate(): void {
    const now = Date.now();
    if (!this.state || now < this.pollAt) return;
    this.pollAt = now + POLL_MS;
    const player = this.sp.Game.getPlayer();
    if (!player || isMenuShown(Menu.Loading)) return;
    if (!this.bootLogged) this.logBoot();
    this.report(player, now);
    if (this.refreshAt && now >= this.refreshAt) {
      this.refreshAt = 0;
      refreshMovement(player);
      logToPlatformLog(this, `movement refreshed after ${this.refreshWhy}: SpeedMult ${player.getActorValue("SpeedMult").toFixed(1)}`);
    }
    if (now >= this.guardAt) {
      this.guardDiseases(player);
      this.guardAt = now + (this.harmed || this.unlistedSeen.length ? GUARD_CONFIRM_MS : GUARD_MS);
      this.guardRanAt = now;
      this.harmed = false;
    }
    if (this.state.contagion) this.checkContagion(player, now, this.state.contagion);
  }

  // Loaded players within range carrying a contagious disease the player lacks, reported in one packet; the first check at a random second
  private checkContagion(player: Actor, now: number, check: ContagionCheck): void {
    const every = check.seconds * 1000;
    if (!this.contagionAt) this.contagionAt = now + Math.random() * every;
    if (now < this.contagionAt) return;
    this.contagionAt = now + every;
    const world = this.controller.lookupListener(RemoteServer).getWorldModel();
    const mine = contagiousOf(world.forms[world.playerCharacterFormIdx]);
    const here = ObjectReferenceEx.getWorldOrCell(player);
    const pos = ObjectReferenceEx.getPos(player);
    const sources = new Array<{ actorId: number; diseases: string[] }>();
    const seen = new Array<string>();
    for (const form of world.forms) {
      if (!form || form.isMyClone || typeof form.refrId !== "number" || !form.movement || form.movement.worldOrCell !== here) continue;
      const diseases = contagiousOf(form).filter((id) => mine.indexOf(id) === -1);
      if (!diseases.length) continue;
      const distance = ObjectReferenceEx.getDistance(pos, form.movement.pos);
      if (distance > check.range) continue;
      sources.push({ actorId: form.refrId, diseases });
      seen.push(`${hex(form.refrId)} ${diseases.join("/")} at ${Math.round(distance)} units`);
    }
    if (!sources.length) return;
    sendCustomPacket(this.controller, { customPacketType: "survivalExposure", sources });
    logToPlatformLog(this, `contagion exposure reported: ${seen.join(", ")}`);
  }

  // Swimming and a flame cloak on change, the engine's warmth total once due
  private report(player: Actor, now: number): void {
    const swimming = player.isSwimming();
    if (this.cloakDue || this.flameCloak) this.readFlameCloak(player);
    const flameCloak = this.flameCloak;
    const key = `${swimming}|${flameCloak}`;
    const warmthDue = this.warmthDueAt > 0 && now >= this.warmthDueAt;
    if (key === this.reported && !warmthDue) return;
    this.reported = key;
    const payload: Record<string, unknown> = { customPacketType: "survivalReport", swimming, flameCloak };
    if (warmthDue) {
      this.warmthDueAt = 0;
      payload["engineWarmth"] = player.getWarmthRating();
      logToPlatformLog(this, `engine warmth ${payload["engineWarmth"]} reported, server warmth ${this.state?.warmth ?? "none"}`);
    }
    sendCustomPacket(this.controller, payload);
  }

  private readFlameCloak(player: Actor): void {
    this.cloakDue = false;
    this.flameCloak = FLAME_CLOAK_EFFECTS.some((id) => player.hasMagicEffect(this.sp.MagicEffect.from(this.sp.Game.getFormEx(id))));
  }

  // The server's spell grants and removals on the player after the spawn's learnedSpells, which the world model never gets
  private onSpSnippet(event: ConnectionMessage<SpSnippetMessage>): void {
    const msg = event.message;
    const fn = String(msg.function).toLowerCase();
    if (msg.selfId !== PLAYER_ID || String(msg.class).toLowerCase() !== "actor" || (fn !== "addspell" && fn !== "removespell")) return;
    const arg = msg.arguments[0] as { formId?: unknown } | undefined;
    const id = typeof arg?.formId === "number" ? arg.formId >>> 0 : 0;
    if (id) this.serverSpells.set(id, fn === "addspell");
  }

  // A disease on the player the server does not list at two checks in a row came from the player's own engine
  private guardDiseases(player: Actor): void {
    const remote = this.controller.lookupListener(RemoteServer);
    const learned = remote.getWorldModel().forms[remote.getMyActorIndex()]?.learnedSpells;
    if (!Array.isArray(learned)) return;
    const listed = new Set(learned.map((id) => id >>> 0));
    this.serverSpells.forEach((added, id) => (added ? listed.add(id) : listed.delete(id)));
    if (!listed.size) return;
    const seen = this.unlistedSeen;
    this.unlistedSeen = [];
    for (const id of this.diseaseIds()) {
      const spell = this.sp.Spell.from(this.sp.Game.getFormEx(id));
      if (!spell || listed.has(id) || !player.hasSpell(spell)) continue;
      if (seen.indexOf(id) === -1) {
        this.unlistedSeen.push(id);
        continue;
      }
      const removed = player.removeSpell(spell);
      const dispelled = player.dispelSpell(spell);
      logToPlatformLog(this, `local disease dropped ${hex(id)} ${spell.getName()}: not granted by the server (spawn list ${learned.length}, ` +
        `${this.serverSpells.size} server grant(s) and removal(s) since), removed ${removed}, dispelled ${dispelled}`);
    }
  }

  private diseaseIds(): number[] {
    if (!this.diseases) {
      const ids = new Array<number>();
      for (const [plugin, locals] of DISEASE_SPELLS) {
        for (const local of locals) {
          const id = this.sp.Game.getFormFromFile(local, plugin)?.getFormID();
          if (id) ids.push(id >>> 0);
        }
      }
      this.diseases = ids;
    }
    return this.diseases;
  }

  // Once per session, with every number in force
  private logBoot(): void {
    this.bootLogged = true;
    const state = this.state!;
    const total = DISEASE_SPELLS.reduce((n, [, ids]) => n + ids.length, 0);
    const cloaks = FLAME_CLOAK_EFFECTS.filter((id) => this.sp.Game.getFormEx(id)).length;
    logToPlatformLog(this, `survival client on: cold ${state.cold} (${state.coldStageName || "off"}, stage ${state.coldStage}), penalty ${Math.round(state.coldPenalty * 100)}%, ` +
      `temperature ${state.temperatureLevel}, warmth ${state.warmth}, freezing area ${state.freezingArea ? "yes" : "no"}, afflictions ${listText(state.afflictions)}, ` +
      `diseases ${this.diseaseText(state)}; swim poll every ${POLL_MS} ms, flame cloak read on its effectStart and every poll while on ` +
      `(${cloaks} of ${FLAME_CLOAK_EFFECTS.length} cloak effects found), ` +
      `engine warmth ${WARMTH_REPORT_MS / 1000} s after the last equip change, movement refresh ${MOVEMENT_REFRESH_MS / 1000} s after a stage or disease change, ` +
      `disease guard every ${GUARD_MS / 1000} s, ${GUARD_AFTER_HARM_MS / 1000} s after a hit or effect on the player and again ${GUARD_CONFIRM_MS / 1000} s later ` +
      `(a harm never brings it under ${GUARD_CONFIRM_MS / 1000} s after the last run), over ${this.diseaseIds().length} of ${total} disease spells (dropped when neither the spawn list nor a later ` +
      `server AddSpell names it at two checks in a row, ${this.serverSpells.size} server grant(s) and removal(s) so far), ` +
      `contagion ${state.contagion ? `check every ${state.contagion.seconds} s within ${state.contagion.range} units of the loaded players' ${CONTAGIOUS_PROP}` : "off"}`);
  }

  private state: SurvivalState | null = null;
  private firstState = true;
  private bootLogged = false;
  private moveKey = "";
  private refreshAt = 0;
  private refreshWhy = "";
  private pollAt = 0;
  private guardAt = 0;
  private guardRanAt = 0;
  // A hit or effect on the player since the last guard run
  private harmed = false;
  private warmthDueAt = 0;
  private contagionAt = 0;
  private reported = "";
  private flameCloak = false;
  private cloakDue = true;
  private hudLogKey = "";
  private unlistedSeen: number[] = [];
  private diseases: number[] | null = null;
  // Spell id -> true when the server's last snippet on the player added it, false when it removed it
  private serverSpells = new Map<number, boolean>();
}
