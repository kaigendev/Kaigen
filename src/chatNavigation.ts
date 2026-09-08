export const JUMP_TO_LATEST_SCREEN_THRESHOLD = 1.5;
export const MAX_RENDERED_CHAT_MESSAGES = 500;
export const NOTIFICATION_TAIL_MESSAGES = 32;

export type HistoryMessageLimit = 20 | 50 | 100 | 500 | 1000 | "all";

export function normalizeHistoryMessageLimit(value: unknown): HistoryMessageLimit {
  if (value === 20 || value === 50 || value === 100 || value === 500 || value === 1000 || value === "all") return value;
  return 500;
}

export function boundedHistoryRequestLimit(
  configured: HistoryMessageLimit,
  _unreadCount: number,
): number {
  // The selected setting controls opening. Unseen messages never silently
  // replace the user's choice. Zero is the explicit all-history request.
  return configured === "all" ? 0 : configured;
}

export function nextHistoryMessageLimit(current: HistoryMessageLimit): HistoryMessageLimit {
  if (current === "all" || current === 1000) return "all";
  if (current === 500) return 1000;
  return 500;
}

export type ChatNavigationMode = "none" | "unseen" | "jump";

export const DEFAULT_NOTIFICATION_SETTINGS = {
  messages: false,
  requests: false,
} as const;

export function shouldShowJumpToLatest(distanceFromLatest: number, viewportHeight: number): boolean {
  if (!Number.isFinite(distanceFromLatest) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  return distanceFromLatest > viewportHeight * JUMP_TO_LATEST_SCREEN_THRESHOLD;
}

export function chatNavigationMode(
  unseenIncomingCount: number,
  distanceFromLatest: number,
  viewportHeight: number,
): ChatNavigationMode {
  if (unseenIncomingCount > 0) return "unseen";
  return shouldShowJumpToLatest(distanceFromLatest, viewportHeight) ? "jump" : "none";
}

export function shouldPublishNavigationForScroll(
  now: number,
  automaticScrollUntil: number,
  userScrollActive: boolean,
  userScrollUiUntil: number,
): boolean {
  return automaticScrollUntil <= now && (userScrollActive || userScrollUiUntil > now);
}

export function scrollMessageWithinContainer(
  container: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior = "auto",
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const metrics = [
    container.scrollTop,
    container.scrollHeight,
    container.clientHeight,
    container.offsetHeight,
    containerRect.top,
    containerRect.height,
    targetRect.top,
    targetRect.height,
  ];
  if (!metrics.every(Number.isFinite)) return;

  const measuredScale = container.offsetHeight > 0
    ? containerRect.height / container.offsetHeight
    : 1;
  const scale = Number.isFinite(measuredScale) && measuredScale > 0 ? measuredScale : 1;
  const viewportCenter = containerRect.top + containerRect.height / 2;
  const targetCenter = targetRect.top + targetRect.height / 2;
  const requestedTop = container.scrollTop + (targetCenter - viewportCenter) / scale;
  if (!Number.isFinite(requestedTop)) return;

  const maximumTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(maximumTop, Math.max(0, requestedTop));
  container.scrollTo({ top, behavior });
}

export type IncomingPrepaintAction = "hold" | "bottom" | "context";

export function incomingPrepaintAction(
  userScrolled: boolean,
  userScrollBlocked: boolean,
  targetRendered: boolean,
  longIncomingBlock: boolean,
): IncomingPrepaintAction {
  if (userScrolled || userScrollBlocked || !targetRendered) return "hold";
  return longIncomingBlock ? "context" : "bottom";
}

export function shouldPrepaintOutgoing(
  distanceFromLatest: number,
  viewportHeight: number,
): boolean {
  if (!Number.isFinite(distanceFromLatest) || !Number.isFinite(viewportHeight) || viewportHeight <= 0) return false;
  return distanceFromLatest <= viewportHeight * 2;
}

export function shouldShowTransferActivity(
  completed: boolean | undefined,
  transferState: string | undefined,
): boolean {
  return completed !== true && transferState !== "cancelled" && transferState !== "failed";
}

export function shouldShowPendingDelivery(
  delivery: string | undefined,
  transferState: string | undefined,
): boolean {
  return delivery === "pending" && transferState !== "cancelled" && transferState !== "failed";
}

export function mediaLoadBelongsToIntent(
  intent: "incoming" | "outgoing",
  anchorIndex: number,
  boundaryIndex: number,
  loadedIndex: number,
): boolean {
  if (anchorIndex < 0 || loadedIndex < 0) return false;
  if (intent === "outgoing") return loadedIndex === anchorIndex;
  return loadedIndex >= anchorIndex && loadedIndex <= Math.max(anchorIndex, boundaryIndex);
}

export type IncomingNavigationItem = {
  key: string;
  incoming: boolean;
  unseen: boolean;
  attachment: boolean;
  fragmentGroup?: string;
};

export function incomingNavigationBatch(
  items: IncomingNavigationItem[],
  targetKey: string,
  existingAnchorKey?: string,
) {
  const targetIndex = items.findIndex((item) => item.key === targetKey);
  if (targetIndex < 0) return { anchorKey: targetKey, boundaryKey: targetKey, settleMs: 0 };
  const target = items[targetIndex];
  const existingIndex = existingAnchorKey
    ? items.findIndex((item) => item.key === existingAnchorKey)
    : -1;
  const canReuseTextAnchor = !target.attachment
    && existingIndex >= 0
    && existingIndex <= targetIndex
    && items.slice(existingIndex, targetIndex + 1).every((item) => item.incoming && !item.attachment && item.fragmentGroup === target.fragmentGroup);
  const anchorIndex = canReuseTextAnchor ? existingIndex : targetIndex;
  const anchorKey = items[anchorIndex]?.key ?? targetKey;
  if (target.attachment) return { anchorKey: targetKey, boundaryKey: targetKey, settleMs: 0 };

  let boundaryKey = targetKey;
  for (const item of items.slice(anchorIndex)) {
    if (!item.incoming || item.attachment || item.fragmentGroup !== target.fragmentGroup) break;
    if (item.unseen) boundaryKey = item.key;
  }
  // For ordinary Tox this is only a bounded visual batch: the messages remain
  // independent records. Proven protocol groups can use the shorter settle.
  return { anchorKey, boundaryKey, settleMs: target.fragmentGroup ? 120 : 900 };
}

type IncomingContextMetricsOptions = {
  viewportHeight: number;
  targetKey: string;
  targetTop: number;
  targetHeight: number;
  previousOwn?: { bottom: number; height: number; lineHeight: number };
  incoming: Array<{ key: string; bottom: number }>;
};

export function incomingContextMetrics({
  viewportHeight,
  targetKey,
  targetTop,
  targetHeight,
  previousOwn,
  incoming,
}: IncomingContextMetricsOptions) {
  let contextTop = Math.max(0, targetTop - 8);
  if (previousOwn && targetTop - previousOwn.bottom <= Math.min(80, viewportHeight / 4)) {
    const twoLineContext = Math.min(previousOwn.height, previousOwn.lineHeight * 2 + 12);
    contextTop = Math.max(0, previousOwn.bottom - twoLineContext - 8);
  }
  let boundaryMessageKey = targetKey;
  let contentBottom = targetTop + targetHeight;
  for (const item of incoming) {
    contentBottom = Math.max(contentBottom, item.bottom);
    boundaryMessageKey = item.key;
  }
  return {
    top: contextTop,
    long: contentBottom - contextTop > viewportHeight - 8,
    boundaryMessageKey,
  };
}
