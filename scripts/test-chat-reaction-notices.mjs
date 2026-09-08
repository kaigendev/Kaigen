import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";

const temporary = mkdtempSync(join(tmpdir(), "kaigen-reaction-notices-"));
try {
  await build({ configFile: false, logLevel: "silent", build: { outDir: temporary, emptyOutDir: false, lib: { entry: "src/chatReactionNotices.ts", formats: ["es"], fileName: () => "notices.mjs" }, minify: false } });
  const { applyPeerReactionEvents, restoreReactionNotices, dismissReactionNotice, MAX_REACTION_NOTICES_PER_CHAT } = await import(pathToFileURL(join(temporary, "notices.mjs")).href);
  const key = `tox-${"A".repeat(64)}`;
  const id = (n) => n.toString(16).padStart(32, "0");
  const event = (n, target = n, added = ["heart"], removed = []) => ({ eventRevision: n, messageId: id(target), peerRevision: n, added, removed, createdAt: n });
  let state = applyPeerReactionEvents(undefined, [event(1)], new Set());
  assert.equal(state.notices[0].reaction, "heart", "opening a previously closed chat retains its offscreen event");
  assert.equal(state.through, 1);
  const restored = restoreReactionNotices(JSON.parse(JSON.stringify({ [key]: state })))[key];
  assert.deepEqual(restored, state, "persisted queue and cursor survive renderer restart before/after backend ACK");
  assert.equal(applyPeerReactionEvents(restored, [event(1)], new Set()), restored, "lost ACK replay creates no duplicate");
  state = applyPeerReactionEvents(state, [event(3, 1, [], ["rocket"]), event(2, 1, ["rocket"], ["heart"])], new Set());
  assert.equal(state.through, 3);
  assert.equal(state.notices.length, 1);
  assert.equal(state.notices[0].removed, true, "add/change/remove between polls still produces an explicit notice");
  state = applyPeerReactionEvents(state, [event(4, 1)], new Set([id(1)]));
  assert.equal(state.notices.length, 0, "an actually visible target needs no navigation notice");
  state = applyPeerReactionEvents(state, Array.from({ length: 100 }, (_, i) => event(i + 5)), new Set());
  assert.equal(state.notices.length, MAX_REACTION_NOTICES_PER_CHAT);
  assert.equal(state.through, 104);
  const dismissed = dismissReactionNotice(state, id(104));
  assert.equal(dismissed.notices.length, 49);
  assert.equal(dismissed.through, state.through, "dismissing does not rewind delivery cursor");
  assert.deepEqual(restoreReactionNotices({ invalid: state, [key]: { through: NaN, notices: [] } }), {});
  const invalid = applyPeerReactionEvents(state, [{ ...event(105), messageId: "selector injection" }, { ...event(106), added: ["unknown"] }], new Set());
  assert.equal(invalid, state, "malformed events cannot advance the durable acknowledgment cursor");
  assert.equal(applyPeerReactionEvents(state, [event(102)], new Set()), state, "out-of-order replay cannot rewind current state");
  console.log("PASS chat reaction notices: closed view, durable restart/replay, rapid replacement/removal, visibility, bounds, dismiss, malformed input");
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
