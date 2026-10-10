import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { fitAnchoredContextMenuPoint: fit, contactMenuPairAnchor: pair } = await importTypeScriptModule(new URL("../src/contextMenuPlacement.ts", import.meta.url));
let assertions = 0;
const equal = (actual, expected, message) => { assertions++; assert.deepEqual(actual, expected, message); };
const close = (actual, expected, message) => { assertions++; assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`); };
const viewport = { width: 1000, height: 700 };
const geometry = (left, top, width = 180, height = 220, scaleX = 1, scaleY = 1) => ({ left, top, width, height, scaleX, scaleY });

// Client coordinates are viewport coordinates, including a call at its origin.
equal(fit({ x: 0, y: 0 }, geometry(0, 0), viewport, { x: 0, y: 0 }), { x: 8, y: 8 }, "viewport origin keeps the leading margin visible");
equal(fit({ x: 300, y: 200 }, geometry(300, 200), viewport, { x: 300, y: 200 }), { x: 300, y: 200 }, "an interior menu stays at the exact invocation point");

// Translate a viewport correction into the shell's independent CSS scales.
const point = { x: 120, y: 80 };
const transformed = geometry(380, 170, 180, 220, 1.5, 0.8);
const anchor = { x: 600, y: 300 };
const placed = fit(point, transformed, viewport, anchor);
close(transformed.left + (placed.x - point.x) * transformed.scaleX, anchor.x, "transformed x lands beside its viewport anchor");
close(transformed.top + (placed.y - point.y) * transformed.scaleY, anchor.y, "zoomed y lands beside its viewport anchor");
equal(point, { x: 120, y: 80 }, "placement does not mutate input coordinates");
equal(transformed, geometry(380, 170, 180, 220, 1.5, 0.8), "placement does not mutate measured geometry");

// Only the overflowing axis moves; correction is exactly the required distance.
equal(fit({ x: 813, y: 200 }, geometry(813, 200), viewport, { x: 813, y: 200 }), { x: 812, y: 200 }, "one pixel at right edge needs only one pixel correction");
equal(fit({ x: 300, y: 473 }, geometry(300, 473), viewport, { x: 300, y: 473 }), { x: 300, y: 472 }, "one pixel at bottom edge needs only one pixel correction");
equal(fit({ x: 940, y: 650 }, geometry(940, 650), viewport, { x: 940, y: 650 }), { x: 812, y: 472 }, "bottom-right call uses the nearest fitting position");
equal(fit({ x: 300, y: 200 }, geometry(300, 200), viewport, { x: 812, y: 472 }), { x: 812, y: 472 }, "a menu flush with safe right and bottom edges stays anchored");
equal(fit({ x: 7.75, y: 8.25 }, geometry(7.75, 8.25), viewport, { x: 8, y: 8 }), { x: 7.75, y: 8.25 }, "subpixel layout rounding does not trigger repeated movement");

// Menus taller or wider than the viewport retain a reachable leading edge.
equal(fit({ x: 400, y: 300 }, geometry(400, 300, 1200, 900), viewport, { x: 900, y: 600 }), { x: 8, y: 8 }, "oversized menu clamps safely to the leading viewport margins");
equal(fit({ x: 0, y: 0 }, geometry(50, 30, 1200, 900, 2, 1.25), viewport, { x: 900, y: 600 }), { x: -21, y: -17.6 }, "oversized transformed menu corrects measured pixels rather than CSS coordinates");

// An invalid axis must neither divide by zero nor poison the other axis.
for (const scale of [0, -1, NaN, Infinity, -Infinity]) {
  const actual = fit({ x: 50, y: 60 }, geometry(100, 100, 180, 220, scale, 1), viewport, { x: 200, y: 300 });
  equal(actual, { x: 50, y: 260 }, `invalid x scale ${scale} leaves x stable while y fits`);
  equal(fit({ x: 50, y: 60 }, geometry(100, 100, 180, 220, 1, scale), viewport, { x: 200, y: 300 }), { x: 150, y: 60 }, `invalid y scale ${scale} leaves y stable while x fits`);
}
equal(fit({ x: 50, y: 60 }, geometry(100, 100), { width: 0, height: 700 }, { x: 200, y: 300 }), { x: 50, y: 260 }, "invalid viewport extent is isolated per axis");
equal(fit({ x: 50, y: 60 }, geometry(100, 100), viewport, { x: NaN, y: 300 }), { x: 50, y: 260 }, "invalid anchor is isolated per axis");

const corrected = fit(point, transformed, viewport, anchor);
const remeasured = { ...transformed, left: anchor.x, top: anchor.y };
equal(fit(corrected, remeasured, viewport, anchor), corrected, "remeasured placement is stable on the next layout pass");

// Reproduce the actual 640px overlap: a parent at 191 and separately clamped
// submenu at 8 would overlap by 67px. Place the two menus as one adjacent pair.
const narrow = pair(191, 250, 250, 640);
equal(narrow, { parentX: 130, submenuX: 382 }, "narrow viewport moves parent minimally and places child beside it");
equal(narrow.submenuX - (narrow.parentX + 250), 2, "reproduced submenu has a 2px gap instead of covering its parent");
equal(191 >= narrow.parentX && 191 <= narrow.parentX + 250, true, "reproduced invocation remains inside the parent");
equal(narrow.submenuX + 250, 632, "reproduced submenu retains the 8px right gutter");
equal(pair(191, 250, 250, 638), { parentX: 128, submenuX: 380 }, "measured viewport width determines correction without assuming host window width");

// Widths measured at 120% are 300 viewport pixels. A shorter left-side
// correction would move the parent past anchor 233 and lose the call point.
const zoomedPair = pair(233, 300, 300, 640);
equal(zoomedPair, { parentX: 30, submenuX: 332 }, "zoomed pair favors keeping invocation inside parent over shorter movement");
equal(233 >= zoomedPair.parentX && 233 <= zoomedPair.parentX + 300, true, "zoomed invocation remains inside the parent");
equal(pair(900, 250, 250, 1000), { parentX: 742, submenuX: 490 }, "far-right invocation puts submenu immediately on the left");
equal(pair(300, 250, 250, 1000), { parentX: 300, submenuX: 552 }, "sufficient viewport preserves the exact parent anchor");
equal(pair(0, 250, 250, 1000), { parentX: 8, submenuX: 260 }, "pair at viewport origin respects the leading gutter");
equal(pair(233, 300, 300, 618), { parentX: 8, submenuX: 310 }, "exact pair capacity includes both gutters and adjacency gap");
equal(pair(233, 300, 300, 617), null, "insufficient pair capacity delegates width capping to the UI");
equal(pair(400, 600, 600, 1000), null, "oversized pair does not return overlapping positions");
for (const width of [0, -1, NaN, Infinity, -Infinity]) {
  equal(pair(300, width, 250, 1000), null, `invalid parent width ${width} is rejected`);
  equal(pair(300, 250, width, 1000), null, `invalid submenu width ${width} is rejected`);
}
equal(pair(NaN, 250, 250, 1000), null, "invalid invocation coordinate is rejected");
equal(pair(300, 250, 250, Infinity), null, "invalid viewport width is rejected");
console.log(`contact group menu viewport anchors, zoom, adjacent pairs, edge corrections, and invalid scales: ${assertions} assertions passed`);
