export type AppScreen = "chat" | "settings";
export type ProfileOrderEdge = "before" | "after";

export const APP_RAIL_WIDTH = 110;
export const COMPACT_SIDEBAR_WIDTH = 86;
export const EXPANDED_SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MIN_REQUESTED_WIDTH = 74;
export const SIDEBAR_MAX_REQUESTED_WIDTH = 620;

const PREFERRED_CONTENT_WIDTH: Record<AppScreen, number> = {
  chat: 760,
  // Settings follows the chat breakpoint so switching screens cannot make an
  // already compact sidebar expand and shift the content unexpectedly.
  settings: 760,
};

export type AppLayout = {
  layoutWidth: number;
  preferredContentWidth: number;
  compactSidebar: boolean;
  sidebarWidth: number;
  contentWidth: number;
  listEdge: number;
  gridTemplateColumns: string;
};

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeProfileOrder(order: readonly string[], availableIds: readonly string[]): string[] {
  const uniqueAvailable = Array.from(new Set(availableIds.filter((id) => id.trim().length > 0)));
  const available = new Set(uniqueAvailable);
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of order) {
    if (!available.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  for (const id of uniqueAvailable) {
    if (seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized;
}

export function moveProfileOrder(
  order: readonly string[],
  availableIds: readonly string[],
  sourceId: string,
  targetId: string,
  edge: ProfileOrderEdge,
): string[] {
  const normalized = normalizeProfileOrder(order, availableIds);
  if (sourceId === targetId || !normalized.includes(sourceId) || !normalized.includes(targetId)) return normalized;
  const withoutSource = normalized.filter((id) => id !== sourceId);
  const targetIndex = withoutSource.indexOf(targetId);
  const insertAt = targetIndex + (edge === "after" ? 1 : 0);
  return [...withoutSource.slice(0, insertAt), sourceId, ...withoutSource.slice(insertAt)];
}

export function resolveAppLayout({
  screen,
  viewportWidth,
  interfaceScale,
  requestedSidebarWidth,
}: {
  screen: AppScreen;
  viewportWidth: number;
  interfaceScale: number;
  requestedSidebarWidth: number;
}): AppLayout {
  const safeViewportWidth = Math.max(0, finiteOr(viewportWidth, 0));
  const normalizedScale = finiteOr(interfaceScale, 100);
  const safeScale = normalizedScale > 0 ? normalizedScale / 100 : 1;
  const layoutWidth = safeViewportWidth / safeScale;
  const preferredContentWidth = PREFERRED_CONTENT_WIDTH[screen];
  const requestedWidth = Math.max(
    SIDEBAR_MIN_REQUESTED_WIDTH,
    Math.min(SIDEBAR_MAX_REQUESTED_WIDTH, finiteOr(requestedSidebarWidth, 360)),
  );
  const expandedCapacity = layoutWidth - APP_RAIL_WIDTH - preferredContentWidth;
  const compactSidebar = requestedWidth < EXPANDED_SIDEBAR_MIN_WIDTH
    || expandedCapacity < EXPANDED_SIDEBAR_MIN_WIDTH;
  const sidebarWidth = compactSidebar
    ? COMPACT_SIDEBAR_WIDTH
    : Math.min(requestedWidth, expandedCapacity);
  const contentWidth = Math.max(0, layoutWidth - APP_RAIL_WIDTH - sidebarWidth);
  const listEdge = APP_RAIL_WIDTH + sidebarWidth;

  return {
    layoutWidth,
    preferredContentWidth,
    compactSidebar,
    sidebarWidth,
    contentWidth,
    listEdge,
    gridTemplateColumns: `${APP_RAIL_WIDTH}px ${sidebarWidth}px minmax(0, 1fr)`,
  };
}
