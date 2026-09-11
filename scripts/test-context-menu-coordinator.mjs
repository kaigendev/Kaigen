import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { dismissContextMenus, registerContextMenuDismissal } = await importTypeScriptModule(new URL("../src/contextMenuCoordinator.ts", import.meta.url));
const { fitContextMenuPoint } = await importTypeScriptModule(new URL("../src/contextMenuPlacement.ts", import.meta.url));
let assertions = 0;
const equal = (actual, expected, label) => { assertions += 1; assert.deepEqual(actual, expected, label); };

// Portal placement and event bubbling are irrelevant to ownership: every
// mounted menu owner participates, including the independent Web service menu.
const owners = ["profile", "status", "contact", "message", "text", "spelling", "web"];
const open = new Map(owners.map((owner) => [owner, false]));
const cleanup = owners.map((owner) => registerContextMenuDismissal(() => open.set(owner, false)));
for (const previous of owners) for (const next of owners) {
  open.set(previous, true);
  dismissContextMenus();
  equal([...open.values()].some(Boolean), false, "old menu closes synchronously before its replacement is opened");
  open.set(next, true);
  equal([...open.entries()].filter(([, visible]) => visible).map(([owner]) => owner), [next], "every pair of owners shares one visible menu");
}
const toggled = "status";
dismissContextMenus();
for (const expected of [true, false, true, false]) {
  const next = !open.get(toggled);
  dismissContextMenus();
  open.set(toggled, next);
  equal(open.get(toggled), expected, "repeated activation of one toggle preserves its close/open behavior");
}
for (const release of cleanup) release();

let calls = 0;
const sharedCallback = () => { calls += 1; };
const releaseFirst = registerContextMenuDismissal(sharedCallback);
const releaseSecond = registerContextMenuDismissal(sharedCallback);
releaseFirst();
dismissContextMenus();
equal(calls, 1, "cleanup of an old registration cannot unregister a replacement with the same callback");
releaseFirst();
dismissContextMenus();
equal(calls, 2, "cleanup remains idempotent across StrictMode lifetime boundaries");
releaseSecond();
dismissContextMenus();
equal(calls, 2, "unmounted owners receive no further dismissal callbacks");

const viewport = { width: 1280, height: 720 };
for (const scale of [1, 1.25, 1.5]) {
  const geometry = (point, width = 250, height = 210) => ({
    left: point.x * scale, top: point.y * scale,
    width: width * scale, height: height * scale, scaleX: scale, scaleY: scale,
  });
  for (const point of [{ x: 2, y: 2 }, { x: 1278, y: 718 }]) {
    const fitted = fitContextMenuPoint(point, geometry(point), viewport);
    const bounds = geometry(fitted);
    equal(bounds.left >= 7.5 && bounds.top >= 7.5 && bounds.left + bounds.width <= 1272.5 && bounds.top + bounds.height <= 712.5, true, `scale ${scale}: corners fit within half a CSS pixel`);
    equal(fitContextMenuPoint(fitted, bounds, viewport), fitted, `scale ${scale}: fitting the measured result is stable`);
  }
  const oversized = { x: 1278, y: 718 };
  const pinned = fitContextMenuPoint(oversized, geometry(oversized, 1400, 900), viewport);
  equal(Math.abs(pinned.x * scale - 8) < .001 && Math.abs(pinned.y * scale - 8) < .001, true, `scale ${scale}: an oversized menu pins its leading edges`);
  equal(fitContextMenuPoint(pinned, geometry(pinned, 1400, 900), viewport), pinned, `scale ${scale}: oversized geometry cannot alternate between opposing edges`);
}
const rounded = { x: 100, y: 8 };
equal(fitContextMenuPoint(rounded, { left: 100, top: 7.999939, width: 1172.000061, height: 200, scaleX: 1.25, scaleY: 1.25 }, viewport), rounded, "subpixel layout rounding must not schedule another render");
equal(fitContextMenuPoint(rounded, { left: 100, top: 8, width: 250, height: 200, scaleX: 1, scaleY: 1 }, { width: 0, height: 0 }), rounded, "a temporarily unavailable viewport leaves the last position intact");

console.log(`Context menu coordination and placement: ${assertions} assertions passed.`);
