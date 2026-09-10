export type BackgroundTransferWork = {
  profileId: string;
  friendNumber: number;
  messageId: string;
  transferId: string;
  direction: "incoming" | "outgoing";
  name: string;
  size: number;
  image: boolean;
  state: string;
  completed: boolean;
  autoAccept: boolean;
  operationId: string | null;
  uploadedBytes: number;
  persistedBytes: number;
  payloadCommitted: boolean;
  payloadSha256: string | null;
  downloadAvailable: boolean;
};
export type BackgroundTransferSnapshot = { entries: BackgroundTransferWork[]; maxConcurrent: number };

/** Browser copies only. Policy, native queues and durable commit belong to the server. */
export class BackgroundTransferDiscovery {
  private generation = 0;
  private pending = false;
  private readonly attempts = new Map<string, { at: number; failures: number }>();

  constructor(private readonly operations: {
    load: () => Promise<BackgroundTransferSnapshot>;
    running: () => ReadonlySet<string>;
    needed?: (work: BackgroundTransferWork) => Promise<boolean>;
    recover: (work: BackgroundTransferWork) => Promise<unknown>;
    report: (work: BackgroundTransferWork, error: unknown) => void;
    now: () => number;
  }) {}

  reset() { this.generation += 1; this.pending = false; this.attempts.clear(); }

  async run() {
    if (this.pending) return;
    this.pending = true;
    const generation = this.generation;
    try {
      const snapshot = await this.operations.load();
      if (generation !== this.generation) return;
      const running = this.operations.running();
      const limit = Number.isFinite(snapshot.maxConcurrent) ? Math.max(1, Math.min(32, Math.floor(snapshot.maxConcurrent))) : 1;
      const now = this.operations.now();
      const seen = new Set<string>();
      const eligible = snapshot.entries.filter((entry) => {
        if (!entry.profileId || !entry.transferId || !entry.messageId || !Number.isInteger(entry.friendNumber) || entry.friendNumber < 0) return false;
        if (seen.has(entry.transferId)) return false;
        seen.add(entry.transferId);
        if (running.has(entry.transferId) || (this.attempts.get(entry.transferId)?.at ?? 0) > now) return false;
        if (entry.direction === "incoming") {
          return entry.state === "complete" && entry.completed && entry.payloadCommitted && entry.downloadAvailable;
        }
        return entry.direction === "outgoing" && entry.state === "uploading" && !entry.completed && !entry.payloadCommitted && !!entry.operationId;
      });
      const liveIds = new Set(snapshot.entries.map((entry) => entry.transferId));
      for (const id of this.attempts.keys()) if (!liveIds.has(id)) this.attempts.delete(id);
      const candidates: BackgroundTransferWork[] = [];
      for (const entry of eligible) {
        if (candidates.length >= Math.max(0, limit - running.size)) break;
        if (generation !== this.generation) return;
        // Already consumed retained files must not occupy the first slots and
        // starve newer files. Check before applying the concurrency limit.
        try {
          if (!this.operations.needed || await this.operations.needed(entry)) candidates.push(entry);
        } catch (error) {
          if (generation !== this.generation) return;
          this.failed(entry, error);
        }
      }
      await Promise.all(candidates.map(async (entry) => {
        try {
          if (generation !== this.generation) return;
          await this.operations.recover(entry);
          if (generation === this.generation) this.attempts.delete(entry.transferId);
        } catch (error) {
          if (generation !== this.generation) return;
          this.failed(entry, error);
        }
      }));
    } finally { if (generation === this.generation) this.pending = false; }
  }

  private failed(entry: BackgroundTransferWork, error: unknown) {
    const failures = (this.attempts.get(entry.transferId)?.failures ?? 0) + 1;
    this.attempts.set(entry.transferId, { at: this.operations.now() + Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), failures });
    if (failures === 1) this.operations.report(entry, error);
  }
}
