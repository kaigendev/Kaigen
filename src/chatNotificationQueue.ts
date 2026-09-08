export type ChatNotificationCandidate = {
  profileId: string;
  key: string;
  previousUnread: number;
  unread: number;
  increase: number;
};

export type ChatNotificationHandler = (
  candidate: ChatNotificationCandidate,
) => boolean | Promise<boolean>;

function normalizeUnread(value: number): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export class ChatNotificationQueue {
  private profileId = "";
  private generation = 0;
  private readonly handled = new Map<string, number>();
  private readonly pending = new Map<string, number>();
  private activeDrain: Promise<number> | null = null;

  resetOwner(profileId: string, baseline: Readonly<Record<string, number>> = {}): void {
    this.profileId = profileId.trim();
    this.generation += 1;
    this.handled.clear();
    this.pending.clear();
    for (const [key, value] of Object.entries(baseline)) {
      const unread = normalizeUnread(value);
      if (key && unread !== null) this.handled.set(key, unread);
    }
  }

  enqueue(key: string, value: number): boolean {
    key = key.trim();
    const unread = normalizeUnread(value);
    if (!this.profileId || !key || unread === null) return false;
    const previous = this.handled.get(key);
    if (previous === undefined) {
      this.handled.set(key, unread);
      return false;
    }
    if (unread <= previous) {
      this.handled.set(key, unread);
      this.pending.delete(key);
      return false;
    }
    const pending = this.pending.get(key) ?? previous;
    this.pending.set(key, Math.max(pending, unread));
    return true;
  }

  retainKeys(keys: Iterable<string>): number {
    const retained = new Set(Array.from(keys, (key) => key.trim()).filter(Boolean));
    let removed = 0;
    for (const key of this.handled.keys()) {
      if (retained.has(key)) continue;
      this.handled.delete(key);
      this.pending.delete(key);
      removed += 1;
    }
    for (const key of this.pending.keys()) {
      if (retained.has(key)) continue;
      this.pending.delete(key);
      removed += 1;
    }
    return removed;
  }

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  watermark(key: string): number | undefined {
    return this.handled.get(key);
  }

  async drain(handle: ChatNotificationHandler): Promise<number> {
    if (this.activeDrain) return this.activeDrain;
    const activeDrain = this.runDrain(handle);
    this.activeDrain = activeDrain;
    try {
      return await activeDrain;
    } finally {
      if (this.activeDrain === activeDrain) this.activeDrain = null;
    }
  }

  private async runDrain(handle: ChatNotificationHandler): Promise<number> {
    const owner = this.profileId;
    const generation = this.generation;
    const attempted = new Map<string, number>();
    let handledCount = 0;

    while (true) {
      if (this.profileId !== owner || this.generation !== generation) break;
      const next = Array.from(this.pending.entries()).find(
        ([key, unread]) => attempted.get(key) !== unread,
      );
      if (!next) break;
      const [key, unread] = next;
      attempted.set(key, unread);
      const previousUnread = this.handled.get(key);
      const latestPending = this.pending.get(key);
      if (previousUnread === undefined || latestPending === undefined) continue;
      if (latestPending <= previousUnread) {
        this.pending.delete(key);
        continue;
      }
      const candidateUnread = Math.min(unread, latestPending);
      const candidate: ChatNotificationCandidate = {
        profileId: owner,
        key,
        previousUnread,
        unread: candidateUnread,
        increase: candidateUnread - previousUnread,
      };
      let accepted = false;
      try {
        accepted = await handle(candidate);
      } catch {
        accepted = false;
      }
      if (this.profileId !== owner || this.generation !== generation) break;
      if (!accepted) continue;
      const currentWatermark = this.handled.get(key);
      const currentPending = this.pending.get(key);
      if (
        currentWatermark !== previousUnread
        || currentPending === undefined
        || currentPending < candidateUnread
      ) {
        continue;
      }
      this.handled.set(key, candidateUnread);
      handledCount += 1;
      if (currentPending <= candidateUnread) {
        this.pending.delete(key);
      }
    }
    return handledCount;
  }
}
