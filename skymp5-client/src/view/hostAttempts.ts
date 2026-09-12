import { storage } from "skyrimPlatform";

storage["hostAttempts"] = [];

export const tryHost = (targetRemoteId: number): void => {
  (storage["hostAttempts"] as any).push(targetRemoteId);
};

export const nextHostAttempt = (): number | undefined => {
  const arr = storage["hostAttempts"] as Array<number>;
  if (arr.length === 0) {
    return undefined;
  }
  return arr.shift();
};

export const lastTryHost: Record<number, number> = {};

// Hosted espm refs are stored with the 64-bit remote id
export const isHostedByMe = (remoteId: number): boolean => {
  const hosted = storage["hosted"];
  return Array.isArray(hosted) && (hosted.includes(remoteId) || hosted.includes(remoteId + 0x100000000));
};
