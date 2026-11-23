import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const desktop = await readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

const nativeSender = desktop.match(/export async function sendFile\([^]*?\n\}/u)?.[0];
assert.ok(nativeSender, "the native send boundary must remain present");
assert.doesNotMatch(nativeSender, /\.arrayBuffer\s*\(/u, "native outgoing files must not be copied through JavaScript");
const boundedDownloadRead = /blob\.slice\(position, position \+ 256 \* 1024\)\.arrayBuffer\(\)/u;
assert.match(desktop, /for \(let position = 0; position < blob\.size; position \+= 256 \* 1024\) \{\s*const bytes = new Uint8Array\(await blob\.slice\(position, position \+ 256 \* 1024\)\.arrayBuffer\(\)\);\s*try \{ await writer\.write\(bytes\); \} finally \{ bytes\.fill\(0\); \}/u,
  "remote downloads copy bounded 256 KiB chunks and erase each chunk after writing");
assert.doesNotMatch(desktop.replace(boundedDownloadRead, "boundedDownloadChunk"), /\.arrayBuffer\s*\(/u,
  "no unbounded or additional renderer file read is admitted");
assert.doesNotMatch(desktop, /Array\.from\s*\(\s*new Uint8Array/u, "desktop files must not be serialized through JSON IPC");
assert.match(desktop, /NATIVE_FILE_GRANT_REQUIRED/u);
assert.doesNotMatch(app, /onDragDropEvent|event\.payload\.paths/u);
assert.match(app, /native-file-drop-ready/u);
assert.match(app, /pick_tox_files/u);
assert.match(backend, /async fn pick_tox_files[\s\S]*?multiple:\s*true/u);
assert.match(backend, /selected_count > MAX_CHAT_FILE_QUEUE/u);
assert.match(backend, /WindowEvent::DragDrop[^]*issue_native_file_batch/u);
assert.equal(tauriConfig.app.windows[0].dragDropEnabled, true);

console.log("desktop file routing contract: 13 assertions passed");
