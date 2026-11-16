import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const projectRoot = new URL("../", import.meta.url);
const { normalizeOwnStatusMessage } = await importTypeScriptModule(new URL("src/statusMessage.ts", projectRoot));
const [app, rust, webCore, native] = await Promise.all([
  readFile(new URL("src/App.tsx", projectRoot), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", projectRoot), "utf8"),
  readFile(new URL("src-tauri/src/web_core.rs", projectRoot), "utf8"),
  readFile(new URL("src-tauri/src/tox_native.rs", projectRoot), "utf8"),
]);

assert.equal(normalizeOwnStatusMessage(""), "");
assert.equal(normalizeOwnStatusMessage(" \t\r\n "), "");
assert.equal(normalizeOwnStatusMessage("  Available  "), "Available");

assert.match(app, /const \[ownStatusMessage, setOwnStatusMessage\] = useState\(""\)/u);
assert.match(app, /invoke<string>\("get_tox_status_message"\)[^]*?\.then\(setOwnStatusMessage\)/u);
const saveStart = app.indexOf("  function saveOwnStatusMessage() {");
const saveEnd = app.indexOf("\n  function changeUserStatus", saveStart);
assert.ok(saveStart >= 0 && saveEnd > saveStart, "status save handler must remain present");
const saveHandler = app.slice(saveStart, saveEnd);
assert.match(saveHandler, /const value = normalizeOwnStatusMessage\(ownStatusMessage\)/u);
assert.doesNotMatch(saveHandler, /Ready to chat|Готов к общению/u);
assert.match(app, /ownStatusMessage === "Готов к общению" \|\| ownStatusMessage === "Ready to chat"/u, "existing profiles with an explicit legacy default must keep localized display");

assert.doesNotMatch(rust, /fn default_status_message/u);
const getterStart = rust.indexOf("    async fn get_tox_status_message(");
const setterStart = rust.indexOf("    async fn set_tox_status_message(", getterStart);
assert.ok(getterStart >= 0 && setterStart > getterStart, "desktop status commands must remain present");
const desktopGetter = rust.slice(getterStart, setterStart);
assert.match(desktopGetter, /let tox_state = app_state\.active\(\)\?;[^]*run_desktop_blocking\(admission, move \|\| \{[^]*ensure_queued_profile_current\(&app_state, &tox_state\)\?;[^]*let state = tox_state[^]*\.handle[^]*\.lock\(\)[^]*\}\)\s*\.await/u,
  "status getter captures and validates its exact profile inside an awaited blocking worker");
assert.match(desktopGetter, /instance\s*\.native\(\)\s*\.self_status_message\(&mut error\)[^]*Ok\(normalize_status_message\(&String::from_utf8_lossy\(&bytes\)\)\)/u);
const nativeGetter = native.slice(native.indexOf("fn self_status_message("), native.indexOf("fn nickname("));
assert.match(nativeGetter, /let count = super::tox_self_get_status_message_size\([^]*let mut text = vec!\[0; count\];\s*if !text\.is_empty\(\)\s*&& !super::tox_self_get_status_message\([^]*Some\(text\)/u,
  "the native facade returns an empty byte vector without reading an empty buffer");
assert.doesNotMatch(desktopGetter + nativeGetter, /(?:tox_self_set_status_message|\.set_status_message)\s*\(/u, "reading an empty status must not mutate an existing profile");
assert.match(rust.slice(setterStart, rust.indexOf("    #[cfg_attr(mobile", setterStart)), /let value = normalize_status_message\(&message\)/u);
assert.match(webCore, /Ok\(crate::normalize_status_message\(&String::from_utf8_lossy\(\s*&bytes,\s*\)\)\)/u);
assert.match(webCore, /let message = crate::normalize_status_message\(string_value\(args, "message"\)\?\)/u);

console.log("empty own status message: 17 assertions passed");
