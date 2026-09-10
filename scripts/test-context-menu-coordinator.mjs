import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { dismissContextMenus, registerContextMenuDismissal } = await importTypeScriptModule(new URL("../src/contextMenuCoordinator.ts", import.meta.url));
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

console.log(`Context menu coordination: ${assertions} assertions passed.`);
