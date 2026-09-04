import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const desktop = await readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

assert.doesNotMatch(desktop, /\.arrayBuffer\s*\(/u, "desktop files must not be copied through JavaScript");
assert.doesNotMatch(desktop, /Array\.from\s*\(\s*new Uint8Array/u, "desktop files must not be serialized through JSON IPC");
assert.match(desktop, /NATIVE_FILE_GRANT_REQUIRED/u);
assert.doesNotMatch(app, /onDragDropEvent|event\.payload\.paths/u);
assert.match(app, /native-file-drop-ready/u);
assert.match(app, /pick_tox_files/u);
assert.match(backend, /async fn pick_tox_files[\s\S]*?multiple:\s*true/u);
assert.match(backend, /selected_count > MAX_CHAT_FILE_QUEUE/u);
assert.match(backend, /WindowEvent::DragDrop[^]*issue_native_file_batch/u);
assert.equal(tauriConfig.app.windows[0].dragDropEnabled, true);

console.log("desktop file routing contract: 10 assertions passed");
