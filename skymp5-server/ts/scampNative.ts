const scampNativeNode = require(process.cwd() + "/scam_native.node");

export declare interface Bot {
  destroy(): void;
  send(msg: Record<string, unknown>): void;
}

export type SendChatMessageFn = (
  formId: number,
  message: Record<string, unknown>
) => void;

export interface ScampServer {
  on(event: "connect", handler: (userId: number) => void): void;
  on(event: "disconnect", handler: (userId: number) => void): void;
  on(
    event: "customPacket",
    handler: (userId: number, content: string) => void
  ): void;
  attachSaveStorage(): void;
  tick(): void;

  createActor(
    formId: number,
    pos: number[],
    angleZ: number,
    cellOrWorld: number,
    userProfileId?: number
  ): number;

  destroyActor(formId: number): void;
  setUserActor(userId: number, actorFormId: number): void;
  getUserActor(userId: number): number;
  getUserGuid(userId: number): string;
  isConnected(userId: number): boolean;
  getActorName(actorId: number): string;
  getActorPos(actorId: number): number[];
  getActorCellOrWorld(actorId: number): number;
  setRaceMenuOpen(formId: number, open: boolean): void;
  sendCustomPacket(userId: number, jsonContent: string): void;
  setEnabled(actorId: number, enabled: boolean): void;
  respawnActor(actorId: number): void;
  // Inventory matching tells copies of these bases apart by name, like property keys
  setNamedItemBases(baseIds: number[]): void;
  // Moves the actor's AI to that player's client; 0 leaves it unhosted
  setHoster(actorId: number, hosterId: number): void;
  getHoster(actorId: number): number;
  // Milliseconds since the actor's last movement message; -1 when none arrived
  getMovementAgeMs(actorId: number): number;
  getActorsByProfileId(profileId: number): number[];
  createBot(): Bot;
  getUserByActor(formId: number): number;
  getUserIp(userId: number): string;
  kick(userId: number): void;

  executeJavaScriptOnChakra(src: string): void;
  clear(): void;
  writeLogs(logLevel: string, message: string): void;
  getPrometheusMetrics(): string;
}

export const createScampServer = (serverSettings: Record<string, unknown>) => {
  const res = new scampNativeNode.ScampServer(JSON.stringify(serverSettings));
  res._setSelf(res);
  return res;
}

export const getScampNative = () => {
  return scampNativeNode;
}
