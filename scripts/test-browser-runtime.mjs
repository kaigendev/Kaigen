import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const spellcheckComposer = await readFile(new URL("../src/SpellcheckComposer.tsx", import.meta.url), "utf8");
const webSession = await readFile(new URL("../src/web/session.ts", import.meta.url), "utf8");
const webRoot = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
const webRootCss = await readFile(new URL("../src/web/WebRoot.css", import.meta.url), "utf8");
const messenger = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const webPlatform = await readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8");
const webServer = await readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8");

assert.match(spellcheckComposer, /spellcheck\.worker\.ts\?worker&url/u);
assert.match(spellcheckComposer, /createPolicy\("kaigen-spellcheck-worker"/u);
assert.match(spellcheckComposer, /createScriptURL\(exactWorkerUrl\)/u);
assert.match(spellcheckComposer, /new Worker\(spellcheckWorkerScriptUrl\(\), \{ type: "module" \}\)/u);
assert.match(
  spellcheckComposer,
  /catch \{[^]*sharedWorker = null;[^]*return null;/u,
  "an unavailable spellcheck worker must degrade locally instead of unmounting Kaigen",
);
assert.doesNotMatch(spellcheckComposer, /new Worker\(new URL\(/u);

assert.match(webSession, /const DEVICE_RECORD_PREFIX = "workspace:";/u);
assert.match(webSession, /kaigen-workspace-identifier-v1/u);
assert.match(webSession, /\.put\(record, `\$\{DEVICE_RECORD_PREFIX\}\$\{record\.workspaceDigest\}`\)/u);
assert.match(webSession, /headers\.set\(WORKSPACE_HEADER, await this\.workspaceDigest\(\)\)/u);
assert.match(webSession, /`\$\{WORKSPACE_PROTOCOL_PREFIX\}\$\{workspaceDigest\}`/u);
assert.match(webSession, /private sessionRefresh: Promise<WorkspaceView \| null> \| null = null;/u);
assert.match(webSession, /error\?\.code === "CSRF_INVALID"/u);
assert.match(webSession, /const restored = await this\.restoreDeviceSession\(\)\.catch\(\(\) => null\);/u);
assert.equal(
  [...webSession.matchAll(/\bfetch\(/gu)].length,
  2,
  "authenticated browser operations must use the shared CSRF recovery path",
);
assert.doesNotMatch(
  webSession,
  /\.put\(record, LEGACY_DEVICE_RECORD_KEY\)/u,
  "a second workspace must not overwrite the first workspace device key",
);

assert.match(messenger, /platformCapabilities\.product === "web" \? "%" : "vw"/u);
assert.match(messenger, /platformCapabilities\.product === "web" \? "%" : "vh"/u);
assert.match(messenger, /<MessageComposer[\s\S]*?onSend=\{stableSendMessage\}[\s\S]*?onStageFile=\{stageFile\}/u);
assert.match(messenger, /platformCapabilities\.nativeFilesystem && <button className="rail-button downloads-button"/u);
assert.match(messenger, /platformCapabilities\.product === "desktop" && message\.mine/u);
assert.match(settings, /platformCapabilities\.systemTray && <Section title="Системный трей"/u);
assert.match(settings, /platformCapabilities\.nativeFilesystem && <Section title="Диагностика"/u);
assert.match(webRootCss, /\.web-app-window \{[^]*width: max\(860px, 95vw\);[^]*height: max\(560px, calc\(95vh - 60\.8px\)\);/u);
assert.match(webRootCss, /\.web-app-surface \{\s*overflow: hidden;/u);
assert.match(webRoot, /const \[position, setPosition\] = useState\(initialAppPosition\);/u);
assert.match(webRoot, /await webSession\.closeWorkspace\(\);/u);
assert.match(webRoot, /t\.closeNote/u);
assert.match(webRoot, /t\.destroyWorkspace/u);
assert.match(webSession, /"\/api\/v1\/workspaces\/close"/u);
assert.match(webSession, /await deleteDeviceRecord\(workspaceDigest, legacyWorkspaceDigest\)\.catch/u);
assert.match(webPlatform, /window\.dispatchEvent\(new Event\("kaigen:web-close-request"\)\)/u);
assert.match(webPlatform, /command === "export_tox_history"/u);
assert.match(webPlatform, /webSession\.command<ExportableMessage\[\]>\("get_tox_messages"/u);
assert.doesNotMatch(webPlatform, /window\.addEventListener\("drop"/u);
assert.match(webServer, /"set_profile_avatar" =>/u);
assert.match(webServer, /"send_tox_avatar" =>/u);
assert.match(webServer, /"fileName": format!\("\{\}\.kai", profile\.id\)/u);

console.log("Browser runtime compatibility contracts passed.");
