export type ChatViewAnchor = {
  messageKey: string;
  offset: number;
  atBottom: boolean;
};

export type MessageGeometry = { key: string; top: number; bottom: number };

export function captureChatAnchor(
  rows: readonly MessageGeometry[],
  viewportTop: number,
  viewportHeight: number,
  distanceFromBottom: number,
): ChatViewAnchor | null {
  if (viewportHeight <= 0) return null;
  const row = rows.find((item) => item.bottom > viewportTop && item.top < viewportTop + viewportHeight);
  return row ? { messageKey: row.key, offset: row.top - viewportTop, atBottom: distanceFromBottom <= 10 } : null;
}

export function anchorScrollDelta(anchor: ChatViewAnchor, rowTop: number, viewportTop: number): number {
  const delta = rowTop - viewportTop - anchor.offset;
  return Number.isFinite(delta) ? delta : 0;
}

export function isMessageInViewport(row: MessageGeometry, viewportTop: number, viewportHeight: number): boolean {
  return viewportHeight > 0 && row.bottom > viewportTop && row.top < viewportTop + viewportHeight;
}

export function isMessageLocallySeen(row: MessageGeometry, viewportTop: number, viewportHeight: number): boolean {
  if (!isMessageInViewport(row, viewportTop, viewportHeight)) return false;
  // A tall message is dismissed only at its end, while that end is actually
  // inside the viewport. Rows wholly above the viewport are never inferred seen.
  return row.bottom <= viewportTop + viewportHeight + 2;
}

export function mayAcknowledgeLocalView(state: {
  visible: boolean; focused: boolean; chatOpen: boolean; overlayOpen: boolean; geometryReady: boolean;
}): boolean {
  return state.visible && state.focused && state.chatOpen && !state.overlayOpen && state.geometryReady;
}

export type SearchTarget = { messageKey: string; field: string; start: number; end: number };

export function retainSearchTarget(matches: readonly SearchTarget[], previous: SearchTarget | undefined, fallback = 0): number {
  if (!matches.length) return -1;
  if (previous) {
    const index = matches.findIndex((match) => match.messageKey === previous.messageKey
      && match.field === previous.field && match.start === previous.start && match.end === previous.end);
    if (index >= 0) return index;
  }
  return Math.min(matches.length - 1, Math.max(0, fallback));
}

export const CHAT_HISTORY_IDLE_MS = 2 * 60 * 60 * 1000;

export function userScrollCancelsHistoryRestore(pendingChat: string | null, displayedChat: string, activeChat: string, displayedRows: number) {
  return pendingChat === activeChat && displayedChat === activeChat && displayedRows > 0;
}

/** A newer query waits for at most one disk page; obsolete queries never start. */
export class LatestChatSearch {
  private inFlight: Promise<unknown> | null = null;

  async run<T>(request: () => Promise<T>, isCurrent: () => boolean): Promise<T | undefined> {
    while (this.inFlight) {
      await this.inFlight.catch(() => {});
      if (!isCurrent()) return undefined;
    }
    if (!isCurrent()) return undefined;
    const pending = request();
    this.inFlight = pending;
    try {
      const result = await pending;
      return isCurrent() ? result : undefined;
    } finally {
      if (this.inFlight === pending) this.inFlight = null;
    }
  }
}

/** No global browser persistence: cached message text belongs to the unlocked profile. */
export class ChatHistoryCache<T> {
  private entries = new Map<string, { messages: readonly T[]; leftAt: number | null; cost: number }>();
  constructor(private readonly limits: { maxEntries: number; maxCost: number; cost: (item: T) => number } = { maxEntries: 4, maxCost: 4000, cost: () => 1 }) {}

  retain(key: string, messages: readonly T[]) {
    this.entries.delete(key);
    const cost = messages.reduce((sum, message) => sum + Math.max(0, this.limits.cost(message)), 0);
    if (cost > this.limits.maxCost) return;
    this.entries.set(key, { messages, leftAt: null, cost });
    let totalCost = [...this.entries.values()].reduce((sum, entry) => sum + entry.cost, 0);
    while (this.entries.size > this.limits.maxEntries || totalCost > this.limits.maxCost) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      totalCost -= oldest[1].cost;
      this.entries.delete(oldest[0]);
    }
  }

  leave(key: string, now: number) {
    const entry = this.entries.get(key);
    if (entry && entry.leftAt === null) entry.leftAt = now;
  }

  open(key: string, now: number): readonly T[] | undefined {
    this.expire(now);
    const entry = this.entries.get(key);
    if (entry) {
      entry.leftAt = null;
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry?.messages;
  }

  expire(now: number): string[] {
    const expired: string[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.leftAt !== null && now - entry.leftAt >= CHAT_HISTORY_IDLE_MS) {
        this.entries.delete(key);
        expired.push(key);
      }
    }
    return expired;
  }

  clear() { this.entries.clear(); }
  delete(key: string) { this.entries.delete(key); }
  has(key: string) { return this.entries.has(key); }
}
