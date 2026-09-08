import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const view = await importTypeScriptModule(new URL("../src/chatViewState.ts", import.meta.url));
const windowing = await importTypeScriptModule(new URL("../src/chatWindow.ts", import.meta.url));
const dateFormat = await importTypeScriptModule(new URL("../src/chatDateFormat.ts", import.meta.url));
const nativeDateTimeFormat = Intl.DateTimeFormat;
let dateFormatterConstructions = 0;
try {
  Intl.DateTimeFormat = class extends nativeDateTimeFormat { constructor(...args) { super(...args); dateFormatterConstructions++; } };
  for (const language of ["ru", "en"]) {
    const locale = language === "ru" ? "ru-RU" : "en-US";
    for (let index = 0; index < 1000; index++) {
      const date = new Date(1700000000000 + index * 60000);
      assert.equal(dateFormat.formatChatDate(date, language, "time"), date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
      assert.equal(dateFormat.formatChatDate(date, language, "receipt"), date.toLocaleString(locale));
    }
  }
  assert.equal(dateFormatterConstructions, 4, "paging 1000 rows reuses formatting engines instead of constructing one per row");
} finally { Intl.DateTimeFormat = nativeDateTimeFormat; }
const rows = [{ key: "above", top: -200, bottom: -10 }, { key: "visible", top: -5, bottom: 30 }, { key: "below", top: 200, bottom: 220 }];
assert.deepEqual(view.captureChatAnchor(rows, 0, 100, 400), { messageKey: "visible", offset: -5, atBottom: false });
assert.equal(view.captureChatAnchor(rows, 0, 0, 10), null);
assert.equal(view.anchorScrollDelta({ messageKey: "visible", offset: -5, atBottom: false }, 45, 0), 50);
assert.equal(view.isMessageLocallySeen(rows[0], 0, 100), false);
assert.equal(view.isMessageLocallySeen(rows[1], 0, 100), true);
assert.equal(view.isMessageLocallySeen(rows[2], 0, 100), false);
assert.equal(view.isMessageLocallySeen({ key: "tall", top: -300, bottom: 150 }, 0, 100), false);
const allowed = { visible: true, focused: true, chatOpen: true, overlayOpen: false, geometryReady: true };
assert.equal(view.mayAcknowledgeLocalView(allowed), true);
for (const key of ["visible", "focused", "chatOpen", "geometryReady"]) assert.equal(view.mayAcknowledgeLocalView({ ...allowed, [key]: false }), false);
assert.equal(view.mayAcknowledgeLocalView({ ...allowed, overlayOpen: true }), false);
const selected = { messageKey: "b", field: "text", start: 0, end: 1 };
assert.equal(view.retainSearchTarget([{ ...selected, messageKey: "a" }, selected], selected), 1);
assert.equal(view.retainSearchTarget([], selected), -1);
assert.equal(view.retainSearchTarget([selected], { ...selected, messageKey: "deleted" }, 10), 0);
assert.equal(view.userScrollCancelsHistoryRestore("bob", "bob", "bob", 500), true, "manual scrolling of warm rows wins over delayed restoration");
assert.equal(view.userScrollCancelsHistoryRestore("bob", "", "bob", 0), false, "cold opening keeps its pending initial position");
assert.equal(view.userScrollCancelsHistoryRestore("bob", "carol", "bob", 34), false, "stale previous chat rows cannot cancel the new chat's restoration");
assert.equal(view.userScrollCancelsHistoryRestore(null, "bob", "bob", 500), false);
const searchQueue = new view.LatestChatSearch();
let finishSearch;
let queryGeneration = 1;
const startedQueries = [];
const firstSearch = searchQueue.run(() => { startedQueries.push(1); return new Promise((resolve) => { finishSearch = resolve; }); }, () => queryGeneration === 1);
queryGeneration = 2;
const obsoleteSearch = searchQueue.run(async () => { startedQueries.push(2); return "obsolete"; }, () => queryGeneration === 2);
queryGeneration = 3;
const latestSearch = searchQueue.run(async () => { startedQueries.push(3); return "latest full-history page"; }, () => queryGeneration === 3);
assert.deepEqual(startedQueries, [1], "typing cannot launch parallel disk scans");
finishSearch("old result");
assert.equal(await firstSearch, undefined);
assert.equal(await obsoleteSearch, undefined);
assert.equal(await latestSearch, "latest full-history page");
assert.deepEqual(startedQueries, [1, 3], "only the newest query starts after the previous page completes");
await assert.rejects(searchQueue.run(async () => { throw new Error("disk error"); }, () => true), /disk error/);
assert.equal(await searchQueue.run(async () => "recovered", () => true), "recovered", "failed disk IO cannot poison later searches");
assert.equal(await searchQueue.run(async () => { throw new Error("must not start"); }, () => false), undefined, "closing a view cancels queued search before disk IO");
const cache = new view.ChatHistoryCache();
cache.retain("profile1:chat", [1]);
cache.retain("profile2:chat", [2]);
cache.leave("profile1:chat", 0);
assert.deepEqual(cache.expire(view.CHAT_HISTORY_IDLE_MS - 1), []);
assert.deepEqual(cache.expire(view.CHAT_HISTORY_IDLE_MS), ["profile1:chat"]);
assert.deepEqual(cache.open("profile2:chat", 10 * view.CHAT_HISTORY_IDLE_MS), [2]);
assert.equal(cache.open("profile1:chat", view.CHAT_HISTORY_IDLE_MS), undefined);
cache.leave("profile2:chat", 10);
cache.open("profile2:chat", 11);
assert.deepEqual(cache.expire(10 * view.CHAT_HISTORY_IDLE_MS), []);
cache.clear();
assert.equal(cache.open("profile2:chat", 0), undefined);
const boundedCache = new view.ChatHistoryCache({ maxEntries: 2, maxCost: 8, cost: (value) => value.length });
boundedCache.retain("a", ["aa"]);
boundedCache.retain("b", ["bbb"]);
boundedCache.open("a", 0);
boundedCache.retain("c", ["cccc"]);
assert.equal(boundedCache.open("b", 0), undefined, "least recently used text is evicted before the TTL when the budget is full");
assert.deepEqual(boundedCache.open("a", 0), ["aa"]);
boundedCache.delete("a");
assert.equal(boundedCache.open("a", 0), undefined, "cleared or deleted chat cannot restore cached text");
boundedCache.retain("huge", ["123456789"]);
assert.equal(boundedCache.open("huge", 0), undefined, "a single oversized window is never retained in the warm cache");
for (const length of [0, 20, 500, 501, 1000, 100000]) {
  for (const anchor of [null, 0, 499, 900, length + 100]) {
    const range = windowing.historyWindowRange(length, anchor);
    assert.ok(range.start >= 0 && range.end <= length && range.end - range.start <= windowing.CHAT_DOM_WINDOW);
    if (anchor === null) assert.equal(range.end, length);
    if (anchor !== null && anchor >= 0 && anchor < length) assert.ok(range.start <= anchor && anchor < range.end);
  }
}
const offsets = windowing.buildHistoryOffsets(["a", "b", "c"], new Map([["a", 20], ["b", 100]]));
assert.deepEqual(windowing.historyWindowRange(Number.NaN, 5), { start: 0, end: 0 });
assert.deepEqual(windowing.historyWindowRange(1000, Number.NaN), { start: 880, end: 1000 });
assert.deepEqual(windowing.buildHistoryOffsets(["a"], new Map(), Number.NaN), [0, 64]);
assert.deepEqual(offsets, [0, 20, 120, 184]);
assert.equal(windowing.historyIndexAtOffset(offsets, 19), 0);
assert.equal(windowing.historyIndexAtOffset(offsets, 20), 1);
assert.equal(windowing.historyIndexAtOffset(offsets, 140), 2);
console.log("chat view anchors, local visibility, cache expiry, retained search, and bounded DOM window: PASS");
