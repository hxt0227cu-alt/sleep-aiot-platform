export class RecentEventIdCache {
  private readonly expiresAt = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number = Date.now,
  ) {
    if (ttlMs <= 0 || maxEntries <= 0) {
      throw new Error('Idempotency cache limits must be positive');
    }
  }

  has(eventId: string): boolean {
    const expiry = this.expiresAt.get(eventId);
    if (expiry === undefined) return false;
    if (expiry <= this.now()) {
      this.expiresAt.delete(eventId);
      return false;
    }
    return true;
  }

  add(eventId: string): void {
    this.expiresAt.delete(eventId);
    this.expiresAt.set(eventId, this.now() + this.ttlMs);
    this.prune();
  }

  private prune(): void {
    const now = this.now();
    for (const [eventId, expiry] of this.expiresAt) {
      if (expiry <= now) this.expiresAt.delete(eventId);
    }
    while (this.expiresAt.size > this.maxEntries) {
      const oldest = this.expiresAt.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.expiresAt.delete(oldest);
    }
  }
}
