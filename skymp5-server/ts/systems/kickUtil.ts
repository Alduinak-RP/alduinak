// The ScampServer / `mp` API is untyped here, same convention as spawn.ts.
type Mp = any;

// Server -> client { customPacketType: "kicked", reason } tells the client to stay disconnected (KickService).
// Sends share the reliable ordered channel with the disconnect notification, so the reason always arrives first.
export const kickWithReason = (mp: Mp, userId: number, reason: string): void => {
  try {
    mp.sendCustomPacket(userId, JSON.stringify({ customPacketType: "kicked", reason }));
  } catch { }
  mp.kick(userId);
};
