import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const repository = fileURLToPath(new URL("..", import.meta.url));

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if ([".ts", ".tsx"].includes(extname(entry.name))) files.push(path);
  }
  return files;
}

const failures = [];
const executableElements = new Set(["script", "iframe", "object", "embed"]);

const forbiddenSourcePatterns = [
  ["dangerouslySetInnerHTML", /\bdangerouslySetInnerHTML\s*=/gu],
  ["DOM markup property assignment", /(?:\.|\[\s*["'])(?:innerHTML|outerHTML|srcdoc|srcDoc)(?:["']\s*\])?\s*=/gu],
  ["DOM markup method", /\b(?:insertAdjacentHTML|createContextualFragment)\s*\(/gu],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\s*\(/gu],
  ["string-to-code call", /(?:^|[^\w$.])(?:eval|Function)\s*\(/gmu],
  ["string-to-code constructor", /\bnew\s+(?:Function|DOMParser)\s*\(/gu],
  ["string timer", /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/gu],
  ["executable JSX element", /<\s*(?:script|iframe|object|embed)\b/giu],
  ["javascript URL", /["'`]\s*javascript\s*:/giu],
];

function sourceLocation(path, text, offset) {
  const prefix = text.slice(0, offset);
  const line = prefix.split(/\r?\n/u).length;
  const column = offset - Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  return `${path}:${line}:${column}`;
}

for (const path of await sourceFiles(join(repository, "src"))) {
  const text = await readFile(path, "utf8");
  for (const [label, pattern] of forbiddenSourcePatterns) {
    for (const match of text.matchAll(pattern)) {
      failures.push(`${sourceLocation(path, text, match.index)} forbidden ${label}`);
    }
  }
  for (const match of text.matchAll(/\bdocument\s*\.\s*createElement\s*\(\s*([^,\r\n)]+)/gu)) {
    const argument = match[1].trim();
    const literal = argument.match(/^["']([^"']+)["']$/u)?.[1]?.toLowerCase();
    if (!literal || executableElements.has(literal)) {
      failures.push(`${sourceLocation(path, text, match.index)} dynamic or executable document.createElement target`);
    }
  }
}
assert.deepEqual(failures, [], `untrusted content execution sinks found:\n${failures.join("\n")}`);

const [
  packageJson,
  tauriConfig,
  capability,
  app,
  settings,
  desktopPlatform,
  rust,
  nativeGrants,
  webServer,
  webInstaller,
] = await Promise.all([
  readFile(join(repository, "package.json"), "utf8").then(JSON.parse),
  readFile(join(repository, "src-tauri", "tauri.conf.json"), "utf8").then(JSON.parse),
  readFile(join(repository, "src-tauri", "capabilities", "default.json"), "utf8").then(JSON.parse),
  readFile(join(repository, "src", "App.tsx"), "utf8"),
  readFile(join(repository, "src", "Settings.tsx"), "utf8"),
  readFile(join(repository, "src", "platform", "desktop.ts"), "utf8"),
  readFile(join(repository, "src-tauri", "src", "lib.rs"), "utf8"),
  readFile(join(repository, "src-tauri", "src", "native_file_grants.rs"), "utf8"),
  readFile(join(repository, "web", "kaigen-webd", "src", "server.rs"), "utf8"),
  readFile(join(repository, "web", "installer", "install-kaigen-web.sh"), "utf8"),
]);

const dependencyNames = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies });
assert.deepEqual(
  dependencyNames.filter((name) => name === "@tauri-apps/plugin-dialog" || name === "@tauri-apps/plugin-opener"),
  [],
  "JavaScript dialog/opener plugins must not remain in the frontend dependency graph",
);
assert.deepEqual(
  dependencyNames.filter((name) => /(?:markdown|marked|remark|rehype|html-react-parser|sanitize-html)/iu.test(name)),
  [],
  "raw HTML/Markdown renderers require a separate security design and may not be introduced implicitly",
);

for (const policyName of ["csp", "devCsp"]) {
  const policy = tauriConfig.app?.security?.[policyName];
  assert.ok(policy && typeof policy === "object", `${policyName} must be an explicit directive map`);
  assert.equal(policy["script-src"], "'self'");
  assert.equal(policy["script-src-attr"], "'none'");
  assert.equal(policy["object-src"], "'none'");
  assert.equal(policy["base-uri"], "'none'");
  assert.equal(policy["frame-ancestors"], "'none'");
  assert.equal(policy["frame-src"], "'none'");
  assert.equal(policy["form-action"], "'none'");
  assert.equal(policy["worker-src"], "'self'");
  assert.equal(policy["require-trusted-types-for"], "'script'");
  assert.equal(policy["trusted-types"], "kaigen-spellcheck-worker");
  assert.doesNotMatch(policy["script-src"], /(?:unsafe-inline|unsafe-eval|\*|data:|blob:|https?:)/u);
}
assert.deepEqual(tauriConfig.app.security.assetProtocol.scope, []);
assert.equal(tauriConfig.app.windows[0].dragDropEnabled, false);

assert.ok(!capability.permissions.includes("dialog:allow-open"));
assert.ok(!capability.permissions.includes("opener:default"));
assert.ok(!capability.permissions.some((permission) => permission.startsWith("shell:")));
assert.doesNotMatch(desktopPlatform, /@tauri-apps\/plugin-(?:dialog|opener)/u);
assert.match(desktopPlatform, /invoke<string \| string\[\] \| null>\("open_native_dialog"/u);
assert.match(desktopPlatform, /send_tox_file_from_grant/u);
assert.match(desktopPlatform, /url !== "https:\/\/github\.com\/kaigendev\/Kaigen"/u);

for (const removed of ["get_native_file_metadata", "send_tox_file_from_path", "read_avatar_file_data_url", "open_macos_dialog"]) {
  assert.doesNotMatch(rust, new RegExp(`\\b${removed}\\b`, "u"), `${removed} must not remain callable`);
}
assert.match(rust, /pick_tox_file,[\s\S]*send_tox_file_from_grant,/u);
assert.match(rust, /pick_profile_avatar_data_url,[\s\S]*open_native_dialog,/u);
assert.match(rust, /stable_friend_public_key\(friend_number\)/u);
assert.match(rust, /discard_native_file_grant,/u);
assert.doesNotMatch(rust, /\.eval\s*\(|initialization_script/u);
assert.match(nativeGrants, /NATIVE_FILE_GRANT_RECIPIENT_MISMATCH/u);
assert.match(nativeGrants, /fn clear_for_profile\(/u);
assert.match(nativeGrants, /fn clear_all\(/u);
assert.match(nativeGrants, /grant\.bytes\.fill\(0\)/u);
assert.doesNotMatch(app, /onDragDropEvent\(/u);
assert.doesNotMatch(app, /if\s*\(\s*platformCapabilities\.nativeFilesystem\s*\)\s*return/u);
assert.match(app, /window\.addEventListener\("dragover", onDragOver\)/u);
assert.match(app, /window\.addEventListener\("drop", onDrop\)/u);
assert.match(app, /event\.dataTransfer\?\.files\[0\]/u);
assert.match(app, /pick_tox_file/);
assert.match(settings, /pick_profile_avatar_data_url/u);

const grantSender = rust.slice(
  rust.indexOf("fn send_tox_file_from_grant("),
  rust.indexOf("fn discard_native_file_grant("),
);
assert.match(grantSender, /let \(profile_id, tox_state\) = app_state\.active_snapshot\(\)\?/u);
assert.match(grantSender, /queue_tox_file_for_state\([\s\S]*tox_state[\s\S]*Some\(recipient_public_key\)/u);
assert.doesNotMatch(grantSender, /\bsend_tox_file\s*\(/u);
assert.match(rust, /Some\(expected\) if expected == current_friend_public_key/u);
assert.match(rust, /confirmed_active != active[\s\S]*Arc::ptr_eq\(&state, &confirmed_state\)/u);

const picker = rust.slice(
  rust.indexOf("async fn pick_tox_file("),
  rust.indexOf("async fn pick_profile_avatar_data_url("),
);
assert.equal((picker.match(/active_snapshot\(\)\?/gu) ?? []).length, 2);
assert.match(picker, /current_profile_id != profile_id \|\| !Arc::ptr_eq\(&current_state, &tox_state\)/u);
assert.match(picker, /current_state\.stable_friend_public_key\(friend_number\) != recipient_public_key/u);

const createProfile = rust.slice(
  rust.indexOf("fn create_profile("),
  rust.indexOf("fn collect_qtox_candidates("),
);
const importProfile = rust.slice(
  rust.indexOf("fn import_qtox_profile_blocking("),
  rust.indexOf("async fn import_qtox_profile("),
);
for (const lifecycle of [createProfile, importProfile]) {
  assert.match(lifecycle, /native_file_grants[\s\S]*grants\.clear_all\(\)/u);
}
assert.match(app, /onDrop=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\);[\s\S]*stageFile\(event\.dataTransfer\.files\[0\]\)/u);

const descriptor = nativeGrants.slice(
  nativeGrants.indexOf("pub(crate) struct NativeFileSelection"),
  nativeGrants.indexOf("pub(crate) struct ConsumedNativeFile"),
);
assert.match(descriptor, /grant_token: String/u);
assert.doesNotMatch(descriptor, /\b(?:path|bytes)\b/u);
assert.match(nativeGrants, /recipient_public_key: String/u);
assert.match(nativeGrants, /DEFAULT_GRANT_TTL/u);
assert.match(nativeGrants, /DEFAULT_MAX_GRANTS/u);
assert.match(nativeGrants, /DEFAULT_MAX_AGGREGATE_BYTES/u);

for (const source of [webServer, webInstaller]) {
  assert.match(source, /Content-Security-Policy/u);
  assert.match(source, /script-src 'self'/u);
  assert.match(source, /script-src-attr 'none'/u);
  assert.match(source, /require-trusted-types-for 'script'/u);
  assert.match(source, /trusted-types kaigen-spellcheck-worker/u);
  assert.match(source, /frame-ancestors 'none'/u);
}

const payloads = [
  "<script>globalThis.__kaigenExecuted = true</script>",
  "<img src=x onerror=alert(1)>",
  "<svg><script>alert(1)</script></svg>",
  "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
  "&lt;script&gt;alert(1)&lt;/script&gt;",
  "</span><object data='x'>",
];
for (const payload of payloads) {
  const html = renderToStaticMarkup(React.createElement("span", null, payload));
  assert.ok(html.startsWith("<span>") && html.endsWith("</span>"));
  assert.doesNotMatch(html, /<(?:script|img|svg|iframe|object)\b/iu);
}

console.log(`Web content security contracts passed (${(await sourceFiles(join(repository, "src"))).length} source files, ${payloads.length} hostile payloads).`);
