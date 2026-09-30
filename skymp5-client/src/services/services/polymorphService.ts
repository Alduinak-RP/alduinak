import { ClientListener, CombinedController, Sp } from "./clientListener";
import { parseCustomPacket } from "./customPacketUtil";
import { RemoteServer } from "./remoteServer";
import { ConnectionMessage } from "../events/connectionMessage";
import { CustomPacketMessage } from "../messages/customPacketMessage";
import { applyAppearanceToPlayer } from "../../sync/appearance";
import { syncRaceAbilities } from "../../sync/spell";
import { Entry, getInventory } from "../../sync/inventory";
import { countWorn, equipEntries, getUnwornSaved } from "../../sync/equipment";
import { logToPlatformLog } from "../../logging";
import { EquipEvent } from "skyrimPlatform";

const PLAYER_FORM_ID = 0x14;
// The race switch reloads the 3D; the look and the gear go on after it
const SETTLE_SEC = 1.5;
const RETRY_SEC = 1;
const MAX_TRIES = 30;

interface PolymorphOrder {
  on: boolean;
  raceId: number;
  gearOff: boolean;
  worn: Entry[];
}

const hex = (id: number): string => (id >>> 0).toString(16);

/**
 * Admin Polymorph (AdminSystem, Admin > Polymorph): the server swaps the appearance race, which rebuilds this character on every other client.
 * The local player also needs Actor.SetRace for the new skeleton, since the appearance apply only swaps the base's race and head.
 *   Server -> Client: { customPacketType: "polymorph", on, raceId, gearOff, worn }  worn: the entries to put back on a revert
 * A creature form takes the gear off and forces third person first (creature skeletons have no first person body), takes off whatever is put on in it
 * and keeps worn gear out of the equipment reports meanwhile.
 */
export class PolymorphService extends ClientListener {
  constructor(private sp: Sp, private controller: CombinedController) {
    super();
    this.controller.emitter.on("customPacketMessage", (e) => this.onCustomPacketMessage(e));
    // A new spawn drops the orders still waiting for the old one
    this.controller.emitter.on("createActorMessage", (e) => {
      if (!e.message.isMe) return;
      this.gearOff = false;
      this.seq++;
    });
    this.controller.on("equip", (e) => this.onEquip(e));
  }

  // SendInputsService leaves worn gear out of the equipment it reports while this holds
  get creatureForm(): boolean {
    return this.gearOff;
  }

  private onCustomPacketMessage(event: ConnectionMessage<CustomPacketMessage>): void {
    const content = parseCustomPacket(event);
    if (!content || content["customPacketType"] !== "polymorph") return;
    const worn = Array.isArray(content["worn"]) ? (content["worn"] as Entry[]) : [];
    const order: PolymorphOrder = {
      on: content["on"] === true,
      raceId: Number(content["raceId"]) >>> 0,
      gearOff: content["gearOff"] === true,
      worn: worn.filter((e) => e && typeof e.baseId === "number"),
    };
    this.gearOff = order.on && order.gearOff;
    // Only the latest order runs; natives throw in the packet-handler context, so it waits for update
    const seq = ++this.seq;
    this.controller.once("update", () => this.apply(order, seq, 1));
  }

  private apply(order: PolymorphOrder, seq: number, attempt: number): void {
    const sp = this.sp;
    const player = sp.Game.getPlayer();
    if (!player || seq !== this.seq) return;
    const label = order.on ? "polymorph" : "polymorph revert";
    const race = sp.Race.from(sp.Game.getFormEx(order.raceId));
    if (!race) {
      logToPlatformLog(this, `${label}: race ${hex(order.raceId)} is not in this client's load order, nothing switched`);
      return;
    }
    // A load finishes first, and a race switch in the saddle would leave the rider on the horse's skeleton
    const loading = sp.Ui.isMenuOpen("Loading Menu") || sp.Ui.isMenuOpen("Main Menu") || !player.is3DLoaded();
    if (loading || player.isOnMount()) {
      if (attempt >= MAX_TRIES) {
        logToPlatformLog(this, `${label}: ${loading ? "still loading" : "still mounted"} after ${MAX_TRIES} tries, race ${hex(order.raceId)} not switched`);
        return;
      }
      if (!loading) player.dismount();
      sp.Utility.wait(RETRY_SEC).then(() => this.controller.once("update", () => this.apply(order, seq, attempt + 1)));
      return;
    }
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
    logToPlatformLog(this, `${label}: race ${hex(order.raceId)}, actor race ${hex(before)} -> ${hex(now)}${now === order.raceId ? "" : " (switch failed)"}, base race ${hex(base)}, look ${lookApplied ? "applied" : "not received yet"}, gear ${gear}${dressed}`);
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
  private seq = 0;
}
