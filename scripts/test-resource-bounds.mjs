import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, settings, desktopPlatform, webPlatform, rust, nativeFileGrants, webCore, kai, historyStore, nativeNotifications] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/native_file_grants.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/web_core.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/kai.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/chat_history_store.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/desktop_notifications.rs", import.meta.url), "utf8"),
]);

assert.match(app, /rangeOffset|targetMessageId/u);
assert.match(settings, /value="all"/u);
assert.doesNotMatch(settings, /max="8589934591"/u);
assert.match(settings, /max="25"/u);
assert.match(app, /boundedHistoryRequestLimit\(loadedHistoryLimit, activeUnreadCount\)/u);
assert.match(nativeNotifications, /const QUEUE_LIMIT: usize = 64;/u);
assert.match(nativeNotifications, /sync_channel::<Pending>\(QUEUE_LIMIT\)/u);
assert.match(nativeNotifications, /find_message_registered\([^]*message_id/u);
assert.match(app, /maxEntries: 3, maxCost: 2_000_000/u);
assert.match(app, /search_tox_messages"[^]*limit: 100/u);
assert.match(app, /renderedMessages\.map/u);
assert.match(app, /const changed = !sameMessages\(previousMessages, nextMessages\)/u);
assert.match(app, /if \(refreshPending\) return;[\s\S]*get_tox_messages_snapshot/u);
assert.match(app, /setInterval\(refresh, 5000\)/u);
assert.match(app, /setInterval\(refresh, 3000\)/u);
assert.match(desktopPlatform, /if \(nativeGrantToken\) \{[\s\S]*send_tox_file_from_grant/u);
assert.doesNotMatch(desktopPlatform, /send_tox_file_from_path/u);
assert.match(historyStore, /const DEFAULT_WINDOW_ROWS: usize = 500;/u);
assert.match(historyStore, /const MAX_WINDOW_ROWS: usize = 1_000;/u);
assert.match(historyStore, /const MAX_WINDOW_COST: usize = 2 \* 1024 \* 1024;/u);
assert.match(historyStore, /const MAX_PAGE_ROWS: usize = 256;/u);
assert.match(historyStore, /const MAX_SEARCH_ROWS: usize = 100;/u);
assert.match(historyStore, /value\.clamp\(1, MAX_WINDOW_ROWS\)/u);
assert.match(historyStore, /limit\.clamp\(1, MAX_SEARCH_ROWS\)/u);
assert.match(rust, /const MAX_INACTIVE_CHAT_HISTORY_WINDOWS: usize = 3;/u);
assert.match(rust, /const MAX_INACTIVE_CHAT_HISTORY_COST: usize = 2 \* 1024 \* 1024;/u);
assert.match(rust, /const MAX_CHAT_FILE_BYTES: u64 = 25 \* 1024 \* 1024;/u);
assert.match(rust, /const MAX_CONCURRENT_OUTGOING_FILES: usize = 1;/u);
assert.match(rust, /chat_history_store::window_registered\(/u);
assert.match(rust, /last_checkpoint_probe\.elapsed\(\) >= Duration::from_secs\(1\)/u);
assert.match(rust, /last_queue_flush\.elapsed\(\) >= Duration::from_millis\(100\)/u);
assert.match(rust, /if outgoing_changed \|\| incoming_changed \{\s*persist_tox_history/u);
assert.match(rust, /source_bytes: Option<Arc<Vec<u8>>>/u);
assert.match(rust, /if let Some\(source\) = transfer\.source_bytes\.as_ref\(\)/u);
assert.match(rust, /buffered_target: Option<Arc<Mutex<Vec<u8>>>>/u);
assert.match(rust, /profiles::write_file\(&transfer\.path, &contents\)/u);
assert.match(rust, /let mut friend_cache_changed = false;/u);
assert.match(rust, /if friend_cache_changed \{[\s\S]*atomic_write_sender/u);
assert.match(rust, /RECV_REJECTED_TOO_LARGE/u);
assert.match(rust, /MAX_CONCURRENT_OUTGOING_FILES\.saturating_sub/u);
assert.match(rust, /settings\.max_concurrent = settings\.max_concurrent\.clamp\(1, 2\)/u);
assert.match(nativeFileGrants, /DEFAULT_GRANT_TTL: Duration = Duration::from_secs\(5 \* 60\)/u);
assert.match(nativeFileGrants, /DEFAULT_MAX_GRANTS: usize = 8/u);
assert.match(nativeFileGrants, /DEFAULT_MAX_AGGREGATE_BYTES: u64 = 5 \* 25 \* 1024 \* 1024/u);
assert.match(nativeFileGrants, /file\.take\(grant\.size\.saturating_add\(1\)\)/u);
assert.match(nativeFileGrants, /while self\.grants\.len\(\) >= self\.max_grants/u);
assert.match(nativeFileGrants, /self\.aggregate_bytes\.saturating_add\(size\) > self\.max_aggregate_bytes/u);
assert.match(webCore, /"get_tox_messages_page" => self\.messages_page/u);
assert.match(webPlatform, /handle\.createWritable\(\)/u);
assert.match(webPlatform, /limit: 256/u);
assert.match(webPlatform, /page\.nextOffset <= offset/u);
assert.match(kai, /atomic_write_disk_parts\([\s\S]*CONTAINER_MAGIC/u);
assert.doesNotMatch(kai, /let mut container =\s*Vec::with_capacity/u);

console.log("Resource bounds and streaming contracts passed.");
