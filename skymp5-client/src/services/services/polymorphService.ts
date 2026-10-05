import { ClientListener, CombinedController, Sp } from "./clientListener";
import { CustomPacketContent, onCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { RestraintService } from "./restraintService";
import { applyAppearanceToPlayer } from "../../sync/appearance";
import { syncRaceAbilities } from "../../sync/spell";
import { Entry, getInventory } from "../../sync/inventory";
import { countWorn, equipEntries, getUnwornSaved } from "../../sync/equipment";
import { logToPlatformLog } from "../../logging";
import { buttonEventKeyCode, isGameInputBlocked } from "./widgetMenuUtil";
import { ButtonEvent, DxScanCode, EquipEvent, Menu } from "skyrimPlatform";

const PLAYER_FORM_ID = 0x14;
// The race switch reloads the 3D; the look and the gear go on after it
const SETTLE_SEC = 1.5;
const RETRY_SEC = 1;
const MAX_TRIES = 30;
const ATTACK_CONTROL = "Right Attack/Block";
const ATTACK_GAP_MS = 900;
const ATTACK_STALE_MS = 200;
// Menus with a cursor that isGameInputBlocked does not cover
const CLICK_MENUS = [Menu.Dialogue, Menu.Magic, Menu.Favorites, Menu.MessageBox, Menu.Sleep];
const ATTACK_CHECK_SEC = 0.3;
const ATTACK_LOG_COUNT = 5;
// The third person camera pivots at this node's height; only the playable skeletons carry it
const CAMERA_NODE = "Camera3rd [Cam3]";
// Head nodes of the creature skeletons, the most common first
const HEAD_NODES = [
  "NPC Head [Head]", "NPC Head", "Canine_Head", "Sabrecat_Head [Head]", "DragPriestNPC Head [Head]", "HEAD", "Head [Head]", "Mammoth Head",
  "Horker_Head", "Goat_Head", "Boar_Head", "ElkScull", "Scull", "HorseScull", "RabbitHead", "FireAtronach_Head [Head]", "ChaurusFlyerHead",
  "DwarvenSpiderHead_XYZ", "IW Head", "Wisp Head", "SlaughterfishHead", "NPC Head MagicNode [Hmag]",
];
const CAMERA_HEIGHT_SETTINGS = ["fOverShoulderPosZ:Camera", "fOverShoulderCombatPosZ:Camera"];
const CAMERA_DISTANCE_SETTINGS = ["fVanityModeMinDist:Camera", "fVanityModeMaxDist:Camera"];
const HUMAN_HEAD_HEIGHT = 120;
const MIN_HEAD_HEIGHT = 10;
const MAX_HEAD_HEIGHT = 1000;
const MAX_DISTANCE_SCALE = 4;
const CAMERA_TRIES = 5;

interface PolymorphOrder {
  on: boolean;
  raceId: number;
  gearOff: boolean;
  noDraw: boolean;
  attacks: string[];
  worn: Entry[];
}

const hex = (id: number): string => (id >>> 0).toString(16);

/**
 * Admin Polymorph (AdminSystem, Admin > Polymorph): the server swaps the appearance race, which rebuilds this character on every other client.
 * The local player also needs Actor.SetRace for the new skeleton, since the appearance apply only swaps the base's race and head.
 *   Server -> Client: { customPacketType: "polymorph", on, raceId, gearOff, noDraw, attacks, worn }  worn: the entries to put back on a revert
 * A creature form takes the gear off and forces third person first (creature skeletons have no first person body), takes off whatever is put on in it
 * and keeps worn gear out of the equipment reports meanwhile.
 * noDraw keeps the weapon sheathed: on a weapon draw the engine shows the player's shield through the race's shield biped object, and a race without one
 * (most creatures, Dremora) makes it read before the biped slots and crash. Such a form has the fighting controls off, and a creature among them attacks
 * with its race's attack events on the attack key instead (most creature graphs have no idle for the player's attack action anyway).
 * A creature skeleton has no Camera3rd node, which leaves the camera pivot at the feet, so the pivot is raised to the head through the camera settings,
 * and the switch to first person is off in a creature form.
 */
export class PolymorphService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    onCustomPacket(this.controller, "polymorph", (content) => this.onCustomPacketMessage(content));
    // A new spawn drops the orders still waiting for the old one
    this.controller.emitter.on("createActorMessage", (e) => {
      if (!e.message.isMe) return;
      this.gearOff = false;
      this.noDraw = false;
      this.attacks = [];
      this.seq++;
      this.controller.lookupListener(RemoteServer).releaseOwnAppearance();
      this.controller.once("update", () => {
        this.restoreCamera();
        this.releaseControls();
      });
    });
    this.controller.on("equip", (e) => this.onEquip(e));
    this.controller.on("buttonEvent", (e) => this.onButtonEvent(e));
    this.controller.on("update", () => this.holdControls());
  }

  // SendInputsService leaves worn gear out of the equipment it reports while this holds
  get creatureForm(): boolean {
    return this.gearOff;
  }

  private onCustomPacketMessage(content: CustomPacketContent): void {
    const worn = Array.isArray(content["worn"]) ? (content["worn"] as Entry[]) : [];
    const order: PolymorphOrder = {
      on: content["on"] === true,
      raceId: Number(content["raceId"]) >>> 0,
      gearOff: content["gearOff"] === true,
      noDraw: content["noDraw"] === true,
      attacks: Array.isArray(content["attacks"]) ? (content["attacks"] as unknown[]).filter((a): a is string => typeof a === "string" && a.length > 0) : [],
      worn: worn.filter((e) => e && typeof e.baseId === "number"),
    };
    this.gearOff = order.on && order.gearOff;
    this.noDraw = order.on && order.noDraw;
    this.attacks = order.on ? order.attacks : [];
    this.attackIndex = 0;
    this.attackLogs = 0;
    // The base keeps its race, and its shield slot, until apply has the weapon away
    if (this.noDraw) this.controller.lookupListener(RemoteServer).holdOwnAppearance();
    // Only the latest order runs; natives throw in the packet-handler context, so it waits for update
    const seq = ++this.seq;
    this.controller.once("update", () => this.apply(order, seq, 1));
  }

  private apply(order: PolymorphOrder, seq: number, attempt: number): void {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    if (!player || seq !== this.seq) return;
    const label = order.on ? "polymorph" : "polymorph revert";
    const remote = this.controller.lookupListener(RemoteServer);
    const race = sp.Race.from(sp.Game.getFormEx(order.raceId));
    if (!race) {
      logToPlatformLog(this, `${label}: race ${hex(order.raceId)} is not in this client's load order, nothing switched`);
      remote.releaseOwnAppearance();
      return;
    }
    // A load finishes first, and a race switch in the saddle would leave the rider on the horse's skeleton
    const loading = sp.Ui.isMenuOpen("Loading Menu") || sp.Ui.isMenuOpen("Main Menu") || !player.is3DLoaded();
    const mounted = !loading && player.isOnMount();
    // A drawn weapon is put away, and a draw under way ends, while the base still has the race with a shield slot
    const drawn = !loading && !mounted && this.noDraw && (player.isWeaponDrawn() || player.getAnimationVariableBool("IsEquipping"));
    if (loading || mounted || drawn) {
      if (attempt >= MAX_TRIES) {
        logToPlatformLog(this, `${label}: ${loading ? "still loading" : mounted ? "still mounted" : "weapon still drawn"} after ${MAX_TRIES} tries, race ${hex(order.raceId)} not switched`);
        remote.releaseOwnAppearance();
        return;
      }
      if (mounted) player.dismount();
      if (drawn) player.sheatheWeapon();
      if (drawn && attempt === 1) logToPlatformLog(this, `${label}: a weapon is drawn or being drawn, the race switch and the look wait until it is away`);
      sp.Utility.wait(RETRY_SEC).then(() => this.controller.once("update", () => this.apply(order, seq, attempt + 1)));
      return;
    }
    remote.releaseOwnAppearance(order.raceId);
    this.restoreCamera();
    const wornBefore = countWorn(getInventory(player));
    if (this.gearOff) {
      player.unequipAll();
      sp.Game.forceThirdPerson();
    }
    const before = player.getRace()?.getFormID() ?? 0;
    if (before !== order.raceId) player.setRace(race);
    sp.Utility.wait(SETTLE_SEC).then(() => this.controller.once("update", () => this.settle(order, seq, label, before, wornBefore)));
  }

  private settle(order: PolymorphOrder, seq: number, label: string, before: number, wornBefore: number): void {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    if (!player || seq !== this.seq) return;
    // The appearance update may land before or after the race switch, so the server's look goes on again once the 3D is back
    const remote = this.controller.lookupListener(RemoteServer);
    const look = remote.getWorldModel().forms[remote.getMyActorIndex()]?.appearance;
    const lookApplied = !!look && look.raceId >>> 0 === order.raceId;
    if (look && lookApplied) {
      applyAppearanceToPlayer(look);
      syncRaceAbilities(player, [], before !== order.raceId ? sp.Race.from(sp.Game.getFormEx(before)) : null);
    }
    let dressed = "";
    if (!order.on && order.worn.length) {
      const unworn = getUnwornSaved(player, { inv: { entries: order.worn }, numChanges: 0 });
      equipEntries(player, unworn);
      dressed = `, re-dressed ${unworn.length} of ${order.worn.length} worn item(s)`;
    }
    const now = player.getRace()?.getFormID() ?? 0;
    const base = sp.ActorBase.from(player.getBaseObject())?.getRace()?.getFormID() ?? 0;
    const gear = this.gearOff ? `off (${wornBefore} worn before), third person` : "kept";
    const fight = this.noDraw ? `, weapons stay sheathed, ${this.attacks.length} attack event(s) on the attack key` : "";
    logToPlatformLog(this, `${label}: race ${hex(order.raceId)}, actor race ${hex(before)} -> ${hex(now)}${now === order.raceId ? "" : " (switch failed)"}, base race ${hex(base)}, look ${lookApplied ? "applied" : "not received yet"}, gear ${gear}${dressed}${fight}`);
    this.releaseControls();
    if (order.on) this.fitCamera(seq, 1);
  }

  // Raises the camera pivot to the head of a skeleton without the camera node and widens the zoom range of a tall one
  private fitCamera(seq: number, attempt: number): void {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    if (!player || seq !== this.seq) return;
    const loaded = player.is3DLoaded();
    if (loaded && sp.NetImmerse.hasNode(player, CAMERA_NODE, false)) {
      logToPlatformLog(this, `polymorph camera: the skeleton has ${CAMERA_NODE}, nothing changed`);
      return;
    }
    const head = loaded ? HEAD_NODES.find((node) => sp.NetImmerse.hasNode(player, node, false)) : undefined;
    const height = head ? sp.NetImmerse.getNodeWorldPositionZ(player, head, false) - player.getPositionZ() : 0;
    if (!head || !(height > MIN_HEAD_HEIGHT && height < MAX_HEAD_HEIGHT)) {
      if (attempt < CAMERA_TRIES) {
        sp.Utility.wait(RETRY_SEC).then(() => this.controller.once("update", () => this.fitCamera(seq, attempt + 1)));
        return;
      }
      const why = !loaded ? "3D not loaded" : head ? `${head} reads a height of ${height.toFixed(0)}` : "no known head node";
      logToPlatformLog(this, `polymorph camera: ${why} after ${CAMERA_TRIES} tries, the pivot stays at the feet`);
      return;
    }
    this.restoreCamera();
    const saved: Record<string, number> = {};
    for (const name of [...CAMERA_HEIGHT_SETTINGS, ...CAMERA_DISTANCE_SETTINGS]) saved[name] = sp.Utility.getINIFloat(name);
    const scale = Math.min(MAX_DISTANCE_SCALE, Math.max(1, height / HUMAN_HEAD_HEIGHT));
    for (const name of CAMERA_HEIGHT_SETTINGS) sp.Utility.setINIFloat(name, saved[name] + height);
    for (const name of CAMERA_DISTANCE_SETTINGS) sp.Utility.setINIFloat(name, saved[name] * scale);
    sp.Game.updateThirdPerson();
    this.cameraSaved = saved;
    logToPlatformLog(this, `polymorph camera: no ${CAMERA_NODE} on the skeleton, pivot raised ${height.toFixed(0)} to ${head}, zoom range x${scale.toFixed(2)}`);
  }

  private restoreCamera(): void {
    const saved = this.cameraSaved;
    if (!saved) return;
    this.cameraSaved = null;
    for (const name of Object.keys(saved)) this.sp.Utility.setINIFloat(name, saved[name]);
    this.sp.Game.updateThirdPerson();
    logToPlatformLog(this, "polymorph camera: settings put back");
  }

  // Other services switch controls back on (a restraint ending, a body set down), so the locks are checked every update
  private holdControls(): void {
    if (!this.noDraw && !this.gearOff) return;
    const game = this.sp.Game;
    const fighting = this.noDraw && game.isFightingControlsEnabled();
    const camSwitch = this.gearOff && game.isCamSwitchControlsEnabled();
    if (!fighting && !camSwitch) return;
    game.disablePlayerControls(false, fighting, camSwitch, false, false, false, false, false, 0);
    if (fighting) this.fightingLocked = true;
    if (camSwitch) this.camSwitchLocked = true;
  }

  // Gives back the controls the current form no longer needs locked
  private releaseControls(): void {
    const fighting = this.fightingLocked && !this.noDraw;
    const camSwitch = this.camSwitchLocked && !this.gearOff;
    if (!fighting && !camSwitch) return;
    this.sp.Game.enablePlayerControls(false, fighting, camSwitch, false, false, false, false, false, 0);
    if (fighting) this.fightingLocked = false;
    if (camSwitch) this.camSwitchLocked = false;
    // A restraint writes its own locks only when its state changes
    this.controller.lookupListener(RestraintService).reapplyPoses();
  }

  private onButtonEvent(e: ButtonEvent): void {
    if (!this.attacks.length || !e.isDown) return;
    if (e.userEventName !== ATTACK_CONTROL && buttonEventKeyCode(e) !== this.attackKey()) return;
    const now = Date.now();
    if (now - this.lastAttackMs < ATTACK_GAP_MS || isGameInputBlocked(this.sp, this.controller) || this.clickMenuOpen()) return;
    // Bound, carried, carrying, downed, in an execution pose or an action lock
    if (this.controller.lookupListener(RestraintService).isPoseLocked) return;
    this.lastAttackMs = now;
    const event = this.attacks[this.attackIndex++ % this.attacks.length];
    this.controller.once("update", () => this.attack(event));
  }

  private attack(event: string): void {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    // A click that a pausing menu kept waiting is dropped
    if (!player || !this.attacks.length || player.isDead() || Date.now() - this.lastAttackMs > ATTACK_STALE_MS) return;
    sp.Debug.sendAnimationEvent(player, event);
    if (this.attackLogs >= ATTACK_LOG_COUNT) return;
    this.attackLogs++;
    sp.Utility.wait(ATTACK_CHECK_SEC).then(() => this.controller.once("update", () => {
      const attacking = sp.Game.getPlayer()?.getAnimationVariableBool("IsAttacking");
      logToPlatformLog(this, `polymorph attack: ${event} sent, ${ATTACK_CHECK_SEC} s later the graph reads IsAttacking ${attacking}`);
    }));
  }

  private clickMenuOpen(): boolean {
    try {
      return CLICK_MENUS.some((menu) => this.sp.Ui.isMenuOpen(menu));
    } catch {
      return false;
    }
  }

  // A button event may carry no control name while the fighting controls are off, so the key is matched as well
  private attackKey(): number {
    if (this.attackKeyCode === 0) {
      let code: number | undefined;
      try {
        code = [0, 1].map((device) => this.sp.Input.getMappedKey(ATTACK_CONTROL, device)).find((c) => c > 0);
      } catch { /* SKSE input not ready */ }
      this.attackKeyCode = code ?? DxScanCode.LeftMouseButton;
    }
    return this.attackKeyCode;
  }

  // Creature skeletons have no weapon or armour nodes, so anything put on comes off on the next update
  private onEquip(e: EquipEvent): void {
    if (!this.gearOff || !e.actor || e.actor.getFormID() !== PLAYER_FORM_ID || !e.baseObj) return;
    const sp = this.sp;
    const id = e.baseObj.getFormID();
    const form = e.baseObj;
    if (!sp.Weapon.from(form) && !sp.Armor.from(form) && !sp.Ammo.from(form) && !sp.Light.from(form)) return;
    this.controller.once("update", () => {
      const player = sp.Game.getPlayer();
      const item = sp.Game.getFormEx(id);
      if (!player || !item || !this.gearOff) return;
      player.unequipItem(item, false, true);
      logToPlatformLog(this, `polymorph: took off ${hex(id)}, a creature form wears no gear`);
    });
  }

  private gearOff = false;
  private noDraw = false;
  private attacks: string[] = [];
  private attackIndex = 0;
  private attackLogs = 0;
  private lastAttackMs = 0;
  private attackKeyCode = 0;
  private fightingLocked = false;
  private camSwitchLocked = false;
  private cameraSaved: Record<string, number> | null = null;
  private seq = 0;
}
