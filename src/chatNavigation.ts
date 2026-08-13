export const JUMP_TO_LATEST_SCREEN_THRESHOLD = 1.5;

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
    && items.slice(existingIndex, targetIndex + 1).every((item) => item.incoming && !item.attachment);
  const anchorIndex = canReuseTextAnchor ? existingIndex : targetIndex;
  const anchorKey = items[anchorIndex]?.key ?? targetKey;
  if (target.attachment) return { anchorKey: targetKey, boundaryKey: targetKey, settleMs: 0 };

  let boundaryKey = targetKey;
  for (const item of items.slice(anchorIndex)) {
    if (!item.incoming || item.attachment) break;
    if (item.unseen) boundaryKey = item.key;
  }
  return { anchorKey, boundaryKey, settleMs: 900 };
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
  if (previousOwn) {
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
