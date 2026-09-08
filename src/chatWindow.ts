export const CHAT_DOM_WINDOW = 120;
export const CHAT_WINDOW_OVERSCAN = 30;

export function historyWindowRange(length: number, anchorIndex: number | null): { start: number; end: number } {
  const count = Number.isFinite(length) ? Math.max(0, Math.floor(length)) : 0;
  const anchor = anchorIndex !== null && Number.isFinite(anchorIndex) ? Math.max(0, Math.min(count - 1, Math.floor(anchorIndex))) : null;
  const start = anchor === null
    ? Math.max(0, count - CHAT_DOM_WINDOW)
    : Math.max(0, Math.min(count - CHAT_DOM_WINDOW, anchor - CHAT_WINDOW_OVERSCAN));
  return { start, end: Math.min(count, start + CHAT_DOM_WINDOW) };
}

export function buildHistoryOffsets(keys: readonly string[], heights: ReadonlyMap<string, number>, estimate = 64): number[] {
  const fallback = Number.isFinite(estimate) && estimate > 0 ? estimate : 64;
  const offsets = [0];
  for (const key of keys) {
    const height = heights.get(key);
    offsets.push(offsets[offsets.length - 1] + (height !== undefined && Number.isFinite(height) && height > 0 ? height : fallback));
  }
  return offsets;
}

export function historyIndexAtOffset(offsets: readonly number[], offset: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}
