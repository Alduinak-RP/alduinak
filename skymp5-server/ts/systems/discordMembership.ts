// Discord's guild member lookup shares one bucket of 5 requests a second; a reconnect burst after a restart used to get
// 429 answers, which the login read as "not in the Discord server". Lookups are paced, 429 and 5xx are retried with the
// Retry-After the API names, and only Discord's own "unknown member" code refuses a player.

export const UNKNOWN_MEMBER_CODE = 10007;
export const UNKNOWN_USER_CODE = 10013;
export const DISCORD_RATE_WINDOW_MS = 1100;
export const DISCORD_RATE_LIMIT = 4;
export const DISCORD_RETRIES = 6;
// One deadline covers every attempt of a lookup; the client gives a login 15 s in all
export const DISCORD_DEADLINE_MS = 12000;
const MAX_BACKOFF_MS = 5000;
const MAX_RETRY_AFTER_MS = 10000;

export type DiscordAnswer =
  | { kind: "member"; roles: string[] }
  | { kind: "notMember" }
  | { kind: "unavailable"; status: number; detail: string };

export const classifyDiscordAnswer = (status: number, body: unknown): DiscordAnswer => {
  const record = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (status >= 200 && status < 300 && record) {
    const roles = Array.isArray(record.roles) ? (record.roles as unknown[]).filter((r): r is string => typeof r === "string") : [];
    return { kind: "member", roles };
  }
  // A deleted Discord account (unknown user) is as much a non-member as one that never joined
  if (status === 404 && (record?.code === UNKNOWN_MEMBER_CODE || record?.code === UNKNOWN_USER_CODE)) return { kind: "notMember" };
  // Discord's code and message tell an unknown guild or a missing intent apart where the status cannot
  const detail = record
    ? [record.code !== undefined ? `code ${record.code}` : "", typeof record.message === "string" ? record.message : ""].filter(Boolean).join(": ")
    : status < 300 ? "no JSON body" : "";
  return { kind: "unavailable", status, detail };
};

type RetryResponse = { status: number; headers: { get(name: string): string | null } } | null;

// fetch-retry options: network errors, 5xx and 429 are retried inside one deadline, a 429 waits what Retry-After says up to a cap
export const discordRetryOptions = (callerFunctionName: string, log: (text: string) => void = console.log) => ({
  signal: AbortSignal.timeout(DISCORD_DEADLINE_MS),
  retryOn: (attempt: number, error: Error | null, response: RetryResponse) => {
    const status = response ? response.status : null;
    // fetch rejects every attempt at once after the deadline, so an abort is final
    const aborted = error !== null && (error.name === "TimeoutError" || error.name === "AbortError");
    const retry = !aborted && attempt < DISCORD_RETRIES && (error !== null || status === 429 || (status !== null && status >= 500));
    if (retry) log(`${callerFunctionName}: retrying request ${JSON.stringify({ attempt, error: error && error.message, status })}`);
    return retry;
  },
  retryDelay: (attempt: number, _error: Error | null, response: RetryResponse) => {
    const after = Number(response?.headers.get("retry-after"));
    return Number.isFinite(after) && after > 0 ? Math.min(Math.ceil(after * 1000) + 100, MAX_RETRY_AFTER_MS) : Math.min(1000 * (attempt + 1), MAX_BACKOFF_MS);
  },
});

// Hands out request slots in call order, at most DISCORD_RATE_LIMIT per DISCORD_RATE_WINDOW_MS
export class RequestPacer {
  private stamps: number[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private limit = DISCORD_RATE_LIMIT, private windowMs = DISCORD_RATE_WINDOW_MS, private now: () => number = Date.now,
    private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) { }

  acquire(): Promise<void> {
    const turn = this.queue.then(() => this.take());
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async take(): Promise<void> {
    for (;;) {
      const now = this.now();
      this.stamps = this.stamps.filter((t) => now - t < this.windowMs);
      if (this.stamps.length < this.limit) {
        this.stamps.push(now);
        return;
      }
      await this.sleep(this.windowMs - (now - this.stamps[0]) + 5);
    }
  }
}
