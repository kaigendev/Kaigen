import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, settings, desktopPlatform, webPlatform, rust, webCore, kai] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/web_core.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/kai.rs", import.meta.url), "utf8"),
]);

assert.doesNotMatch(app, /historyMessageLimit === "all"/u);
assert.doesNotMatch(settings, /value="all"/u);
assert.doesNotMatch(settings, /max="8589934591"/u);
assert.match(settings, /max="25"/u);
assert.match(app, /boundedHistoryRequestLimit\(historyMessageLimit, activeUnreadCount\)/u);
assert.match(app, /limit: NOTIFICATION_TAIL_MESSAGES/u);
assert.match(app, /new Map<string, Set<string>>\(\)/u);
assert.match(app, /const changed = !sameMessages\(previousMessages, nextMessages\)/u);
assert.match(app, /if \(refreshPending\) return;[\s\S]*get_tox_messages_snapshot/u);
assert.match(app, /setInterval\(refresh, 5000\)/u);
assert.match(app, /setInterval\(refresh, 3000\)/u);
assert.match(desktopPlatform, /if \(nativePath\) \{[\s\S]*send_tox_file_from_path/u);
assert.match(rust, /const MAX_MESSAGE_SNAPSHOT: usize = 500;/u);
assert.match(rust, /const MAX_CHAT_FILE_BYTES: u64 = 25 \* 1024 \* 1024;/u);
assert.match(rust, /const MAX_CONCURRENT_OUTGOING_FILES: usize = 1;/u);
assert.match(rust, /\.iter\(\)\s*\.rev\(\)[\s\S]*\.take\(limit\)/u);
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
assert.match(webCore, /"get_tox_messages_page" => self\.messages_page/u);
assert.match(webPlatform, /handle\.createWritable\(\)/u);
assert.match(webPlatform, /limit: 256/u);
assert.match(webPlatform, /page\.nextOffset <= offset/u);
assert.match(kai, /atomic_write_disk_parts\([\s\S]*CONTAINER_MAGIC/u);
assert.doesNotMatch(kai, /let mut container =\s*Vec::with_capacity/u);

console.log("Resource bounds and streaming contracts passed.");
