type Snapshot = { people: unknown[]; server_members: unknown[] };

function validate<T extends Snapshot>(snapshot: T): T {
  if (!snapshot || !Array.isArray(snapshot.people) || !Array.isArray(snapshot.server_members)) {
    throw new Error("Некорректный ответ списка пользователей");
  }
  return snapshot;
}

/** An optional lightweight endpoint must never prevent the established API from working. */
export class SocialSnapshotClient {
  private retryPrimaryAt = 0;
  private readonly now: () => number;
  constructor(now = () => Date.now()) { this.now = now; }

  async load<T extends Snapshot>(primary: () => Promise<T>, fallback: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.now() >= this.retryPrimaryAt) {
      try {
        const snapshot = validate(await primary());
        signal.throwIfAborted();
        this.retryPrimaryAt = 0;
        return snapshot;
      } catch (error) {
        // Navigation and logout cancel the whole operation; never start another request.
        if (signal.aborted) throw error;
        // Missing endpoints often fail as CORS/network errors, not readable HTTP 404s.
        this.retryPrimaryAt = this.now() + 60_000;
      }
    }
    const snapshot = validate(await fallback());
    signal.throwIfAborted();
    return snapshot;
  }
}
