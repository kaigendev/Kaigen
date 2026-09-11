type Point = { x: number; y: number };
type MenuGeometry = { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number };
type Viewport = { width: number; height: number };

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
