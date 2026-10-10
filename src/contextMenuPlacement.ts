type Point = { x: number; y: number };
type MenuGeometry = { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number };
type Viewport = { width: number; height: number };

/** Place an adjacent pair without letting its submenu cover the triggering item. */
export function contactMenuPairAnchor(anchorX: number, parentWidth: number, submenuWidth: number, viewportWidth: number): { parentX: number; submenuX: number } | null {
  if (![anchorX, parentWidth, submenuWidth, viewportWidth].every(Number.isFinite) || parentWidth <= 0 || submenuWidth <= 0 || parentWidth + submenuWidth + 18 > viewportWidth) return null;
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
  const original = clamp(anchorX, 8, viewportWidth - parentWidth - 8);
  const right = clamp(original, 8, viewportWidth - parentWidth - submenuWidth - 10);
  const left = clamp(original, submenuWidth + 10, viewportWidth - parentWidth - 8);
  const retainsAnchor = (x: number) => anchorX >= x && anchorX <= x + parentWidth;
  const useRight = retainsAnchor(right) !== retainsAnchor(left)
    ? retainsAnchor(right)
    : Math.abs(right - original) <= Math.abs(left - original);
  return useRight
    ? { parentX: right, submenuX: right + parentWidth + 2 }
    : { parentX: left, submenuX: left - submenuWidth - 2 };
}

/** Fit each axis once; an oversized menu keeps its leading edge visible. */
export function fitContextMenuPoint(point: Point, bounds: MenuGeometry, viewport: Viewport): Point {
  const fit = (position: number, start: number, size: number, extent: number, scale: number) => {
    if (![position, start, size, extent, scale].every(Number.isFinite) || extent <= 0 || scale <= 0) return position;
    const margin = 8;
    const target = Math.max(margin, Math.min(start, extent - size - margin));
    const correction = target - start;
    // Layout rounds CSS pixels. Repeating an unrepresentable correction in a
    // layout effect can exhaust React's update depth even though the menu fits.
    return Math.abs(correction) <= .5 ? position : position + correction / scale;
  };
  return {
    x: fit(point.x, bounds.left, bounds.width, viewport.width, bounds.scaleX),
    y: fit(point.y, bounds.top, bounds.height, viewport.height, bounds.scaleY),
  };
}

/** Keep a new menu at its viewport anchor even inside a zoomed or transformed shell. */
export function fitAnchoredContextMenuPoint(point: Point, bounds: MenuGeometry, viewport: Viewport, anchor: Point): Point {
  const place = (position: number, start: number, size: number, extent: number, scale: number, target: number) => {
    if (![position, start, size, extent, scale, target].every(Number.isFinite) || extent <= 0 || scale <= 0) return position;
    const desired = Math.max(8, Math.min(target, extent - size - 8));
    const correction = desired - start;
    return Math.abs(correction) <= .5 ? position : position + correction / scale;
  };
  return {
    x: place(point.x, bounds.left, bounds.width, viewport.width, bounds.scaleX, anchor.x),
    y: place(point.y, bounds.top, bounds.height, viewport.height, bounds.scaleY, anchor.y),
  };
}
