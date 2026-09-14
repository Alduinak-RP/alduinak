import { System, Log, SystemContext, Content } from "./system";
import { hex } from "./actorUtil";

// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// One seated player per furniture marker. The native side only caps a bench at its marker count;
// remote seated players are just a sit idle on other clients, so their engine can pick a taken marker.
//
//   Client -> Server: { customPacketType: "seatClaim", furniture: <refr id>, marker: <index, -1 unknown> }  once fully seated
//                     { customPacketType: "seatRelease" }
//   Server -> Client: { customPacketType: "seatTaken", furniture }  the claimant stands back up

// Seated actors do not move, so a holder this far from its claim has left the seat
const LEFT_SEAT_DISTANCE = 48;
// Without marker indices, two seated actors this close share one marker
const SAME_SEAT_DISTANCE = 24;

interface SeatClaim {
  actorId: number;
  furniture: number;
  marker: number;
  cell: number;
  pos: number[];
}

const distance = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const isSameSeat = (a: SeatClaim, b: SeatClaim): boolean =>
  a.marker >= 0 && b.marker >= 0 ? a.marker === b.marker : distance(a.pos, b.pos) < SAME_SEAT_DISTANCE;

export class FurnitureSeatSystem implements System {
  systemName = "FurnitureSeatSystem";
  constructor(private log: Log) { }

  private claims = new Map<number, SeatClaim>();

  disconnect(userId: number): void {
    this.claims.delete(userId);
  }

  customPacket(userId: number, type: string, content: Content, ctx: SystemContext): void {
    if (type === "seatRelease") {
      this.claims.delete(userId);
      return;
    }
    if (type !== "seatClaim") return;

    const mp = ctx.svr as Mp;
    const claim = this.readClaim(mp, userId, content);
    this.claims.delete(userId);
    if (!claim) return;

    for (const [holderUserId, held] of this.claims) {
      if (held.furniture !== claim.furniture) continue;
      if (!this.isStillSeated(mp, holderUserId, held)) {
        this.claims.delete(holderUserId);
        continue;
      }
      if (!isSameSeat(held, claim)) continue;
      this.log(`FurnitureSeatSystem: ${hex(claim.furniture)} marker ${claim.marker} is held by ${hex(held.actorId)}, standing ${hex(claim.actorId)} up`);
      try {
        mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "seatTaken", furniture: claim.furniture }));
      } catch { }
      return;
    }
    this.claims.set(userId, claim);
  }

  // Position and cell come from the server's own copy of the actor, never from the packet
  private readClaim(mp: Mp, userId: number, content: Content): SeatClaim | null {
    const furniture = Number(content.furniture) >>> 0;
    const marker = Number.isInteger(content.marker) ? Number(content.marker) : -1;
    try {
      const actorId = mp.getUserActor(userId) >>> 0;
      if (!actorId || !furniture) return null;
      return { actorId, furniture, marker, cell: mp.getActorCellOrWorld(actorId), pos: mp.getActorPos(actorId) };
    } catch {
      return null;
    }
  }

  private isStillSeated(mp: Mp, userId: number, held: SeatClaim): boolean {
    try {
      if (!mp.isConnected(userId) || (mp.getUserActor(userId) >>> 0) !== held.actorId) return false;
      if (mp.getActorCellOrWorld(held.actorId) !== held.cell) return false;
      return distance(mp.getActorPos(held.actorId), held.pos) <= LEFT_SEAT_DISTANCE;
    } catch {
      return false;
    }
  }
}
