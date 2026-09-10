import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importStandaloneTypeScript } from "./import-standalone-typescript.mjs";

// Node 22+ can execute this erasable TypeScript module directly, while the
// Debian Web VM intentionally stays on Node 20. Compile the isolated module
// with the lock-pinned local TypeScript package so the same regression runs on
// every supported builder without a network loader or a second test fixture.
const browserProfileImport = await importStandaloneTypeScript(
  new URL("../src/platform/browser-profile-import.ts", import.meta.url),
);
const {
  createStoredQtoxZip,
  listQtoxFolderProfiles,
  MAX_QTOX_FOLDER_FILES,
} = browserProfileImport;

const spellcheckComposer = await readFile(new URL("../src/SpellcheckComposer.tsx", import.meta.url), "utf8");
const textEditContextMenu = await readFile(new URL("../src/TextEditContextMenu.tsx", import.meta.url), "utf8");
const chatEnhancements = await readFile(new URL("../src/ChatMessageEnhancements.tsx", import.meta.url), "utf8");
const chatRichText = await readFile(new URL("../src/chatRichText.ts", import.meta.url), "utf8");
const textEditCommands = await readFile(new URL("../src/textEditCommands.ts", import.meta.url), "utf8");
const editableTextTarget = await readFile(new URL("../src/editableTextTarget.ts", import.meta.url), "utf8");
const webSession = await readFile(new URL("../src/web/session.ts", import.meta.url), "utf8");
const backgroundTransfers = await readFile(new URL("../src/web/backgroundTransfers.ts", import.meta.url), "utf8");
const webRoot = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
const webRootCss = await readFile(new URL("../src/web/WebRoot.css", import.meta.url), "utf8");
const messenger = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const interfaceScale = await readFile(new URL("../src/interfaceScale.ts", import.meta.url), "utf8");
const rootApp = await readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8");
const avatar = await readFile(new URL("../src/avatar.ts", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const webPlatform = await readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8");
const webContracts = await readFile(new URL("../src/web/contracts.ts", import.meta.url), "utf8");
const webServer = await readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8");
const webCore = await readFile(new URL("../src-tauri/src/web_core.rs", import.meta.url), "utf8");
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

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
assert.match(editableTextTarget, /target\.closest\("input, textarea, \[contenteditable\]"\)/u);
assert.doesNotMatch(editableTextTarget, /from "react"|useEffect|useState|useMemo|useRef/u);
assert.match(textEditContextMenu, /from "\.\/editableTextTarget"/u);
assert.match(messenger, /from "\.\/editableTextTarget"/u);
assert.doesNotMatch(messenger, /from "\.\/TextEditContextMenu"/u);
assert.match(textEditContextMenu, /createPortal\(/u, "one global React portal owns the text edit menu");
assert.match(textEditContextMenu, /if \(event\.defaultPrevented\) return;/u,
  "spellcheck and product menus can consume contextmenu without a second menu underneath");
assert.match(textEditContextMenu, /data-kaigen-text-edit-menu="true"/u);
assert.match(textEditContextMenu, /event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*openMenu\(target, event\.clientX, event\.clientY, false\);/u,
  "secondary click and macOS control-click share the browser contextmenu path");
assert.match(textEditContextMenu, /isKeyboardContextMenuGesture\(event\)[^]*keyboardContextMenuPoint/u,
  "ContextMenu and Shift+F10 have a stable keyboard path");
assert.match(textEditContextMenu, /document\.addEventListener\("pointerdown", onPointerDown, true\)[^]*window\.addEventListener\("scroll", onScroll, true\)[^]*removeEventListener/u,
  "the portal cleans up click-away and scroll listeners");
assert.match(textEditContextMenu, /navigator\.clipboard[^]*KAIGEN_PASTE_FILES_EVENT/u,
  "custom Paste can preserve text selections and forward clipboard images to the composer");
assert.doesNotMatch(textEditContextMenu, /dangerouslySetInnerHTML|\.innerHTML\s*=/u);
assert.match(messenger, /if \(isEditableTextTarget\(event\.target\)\) \{\s*setGeneralContext\(null\);\s*return;\s*\}\s*event\.preventDefault\(\);/u);
assert.match(spellcheckComposer, /const token = misspelledTokenAtPoint\([^]*if \(!token\) \{\s*setMenu\(null\);\s*return;\s*\}\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u);
assert.match(spellcheckComposer, /onPaste=\{\(event\) => \{\s*if \(!fileActionsEnabled\) return;\s*const files = pastedFiles\(event\.clipboardData\);/u);
assert.match(spellcheckComposer, /\(onPasteFiles \?\? onStageFiles\)\(files\)/u,
  "clipboard files use their security-specific staging route when supplied");
assert.match(spellcheckComposer, /composingRef\.current \|\| event\.nativeEvent\.isComposing/u,
  "IME confirmation Enter never enters the send path");
assert.match(spellcheckComposer, /onDraftChange\(targetChat, ""\)[^]*await onSend\(submission\.text, submission\.formatting, targetReply\)/u,
  "one draft is cleared synchronously before the captured send operation settles");
assert.doesNotMatch(chatEnhancements, /dangerouslySetInnerHTML|\.innerHTML\s*=/u);
assert.match(chatEnhancements, /formattedTextSegments\(text, enabled \? formatting : \[\]\)/u,
  "remote formatting is rendered only through bounded declarative segments");
assert.match(chatRichText, /MAX_CHAT_FORMATTING_SPANS = 128/u);
assert.match(textEditCommands, /event\.key === "ContextMenu" \|\| \(event\.key === "F10" && event\.shiftKey\)/u);
assert.match(spellcheckComposer, /type="file" multiple[^>]*onChange=\{\(event\) => \{ if \(event\.target\.files\) onStageFiles\(event\.target\.files\)/u);
for (const policyName of ["csp", "devCsp"]) {
  const policy = tauriConfig.app.security[policyName];
  assert.equal(policy["script-src"], "'self'");
  assert.equal(policy["script-src-attr"], "'none'");
  assert.equal(policy["require-trusted-types-for"], "'script'");
  assert.equal(policy["trusted-types"], "kaigen-spellcheck-worker");
}
assert.equal(tauriConfig.app.windows[0].dragDropEnabled, true);

assert.match(webSession, /const DEVICE_RECORD_PREFIX = "workspace:";/u);
assert.match(webSession, /kaigen-workspace-identifier-v1/u);
assert.match(webSession, /\.put\(record, `\$\{DEVICE_RECORD_PREFIX\}\$\{record\.workspaceDigest\}`\)/u);
assert.match(webSession, /headers\.set\(WORKSPACE_HEADER, await this\.workspaceDigest\(\)\)/u);
assert.match(webSession, /`\$\{WORKSPACE_PROTOCOL_PREFIX\}\$\{workspaceDigest\}`/u);
assert.match(webSession, /private sessionRefresh: Promise<WorkspaceView \| null> \| null = null;/u);
assert.match(webSession, /const PERSISTENCE_COMMANDS = new Set\(\["save_layout_state", "save_local_state"\]\);/u);
assert.match(webSession, /private sessionLifecycle: "active" \| "tearing-down" \| "closed" = "active";/u);
assert.match(webSession, /private readonly pendingPersistenceCommands = new Set<Promise<unknown>>\(\);/u);
assert.match(webSession, /async recoverIncomingTransfer\([^]*this\.transferPumps\.has\(transferId\)[^]*this\.transferStatus\(transferId\)[^]*this\.startIncomingTransfer\(transfer, friendNumber, previewOwner, intent\)/u,
  "a restored Web session reconnects its browser copy to the retained backend transfer");
assert.match(webSession, /let partial = await handle\.getFile\(\);[^]*received = partial\.size;[^]*createWritable\(\{ keepExistingData: true \}\)/u,
  "incoming Web transfers resume from their OPFS partial instead of restarting at byte zero");
assert.doesNotMatch(webSession, /"acknowledge_web_incoming_chunk"/u,
  "the browser no longer releases native receive buffers");
assert.match(webSession, /verifyTransferPayload\(blob, transfer\.sizeBytes, transfer\.payloadSha256\)[^]*"complete_web_incoming_transfer"/u,
  "the local consumed receipt follows exact length and digest verification");
assert.match(webSession, /async command<T>\([^]*const persistenceCommand = PERSISTENCE_COMMANDS\.has\(command\);[^]*if \(persistenceCommand && this\.sessionLifecycle !== "active"\) return undefined as T;[^]*const request = this\.request<T>[^]*this\.pendingPersistenceCommands\.add\(request\);[^]*return await request;[^]*this\.pendingPersistenceCommands\.delete\(request\);/u);
assert.match(webSession, /private async acceptSession\([^]*this\.sessionLifecycle = "active";/u);
assert.match(webSession, /error\?\.code === "CSRF_INVALID"/u);
assert.match(webSession, /const restored = this\.sessionLifecycle === "active" \? await this\.restoreDeviceSession\(\)\.catch\(\(\) => null\) : null;/u);
assert.equal(
  [...webSession.matchAll(/\bfetch\(/gu)].length,
  1,
  "browser operations must use the shared terminal upgrade and CSRF recovery path",
);
assert.doesNotMatch(
  webSession,
  /\.put\(record, LEGACY_DEVICE_RECORD_KEY\)/u,
  "a second workspace must not overwrite the first workspace device key",
);

assert.match(messenger, /\.\.\.appShellScaleStyle\(appearance\.interfaceScale, platformCapabilities\.containerRelativeLayout\)/u);
assert.match(interfaceScale, /containerRelativeLayout\s*\? \{ \.\.\.shared, transform: `scale\(\$\{scale\}\)`, transformOrigin: "top left" \}\s*: \{ \.\.\.shared, zoom: scale \}/u);
assert.match(messenger, /<MessageComposer[\s\S]*?onSend=\{stableSendMessage\}[\s\S]*?onStageFiles=\{stageFiles\}/u);
assert.match(messenger, /onPickFile=\{platformCapabilities\.nativeFilesystem \? pickNativeFile : undefined\}/u);
assert.match(messenger, /stageFiles\(event\.dataTransfer\.files\)/u);
assert.doesNotMatch(messenger, /event\.dataTransfer\.files\[0\]/u);
assert.doesNotMatch(messenger, /onDragDropEvent|event\.payload\.paths/u,
  "renderer code must not receive native filesystem paths from drag events");
assert.match(messenger, /if \(!platformCapabilities\.nativeFilesystem\) return;[^]*native-file-drop-ready/u,
  "tokenized native drag results must stay behind the desktop filesystem capability gate");
assert.match(messenger, /platformCapabilities\.nativeFilesystem && <button className="rail-button downloads-button"/u);
assert.match(messenger, /platformCapabilities\.outgoingTransferRetry && message\.mine/u);
assert.doesNotMatch(messenger, /platformCapabilities\.product/u);
assert.match(messenger, /normalizeProfileAvatar\(avatar\)[^]*profileId: activeProfileId,[^]*setProfileAvatar\(normalized\?\.dataUrl \?\? null\)/u);
assert.doesNotMatch(messenger, /setProfileAvatar\(avatar\);/u);
assert.match(rootApp, /dataUrl: avatar\.dataUrl,[^]*bytes: avatar\.bytes,/u);
assert.match(avatar, /bytes\.byteLength <= TOX_AVATAR_MAX_BYTES[^]*dataUrl: await blobDataUrl\(blob\)/u);
assert.match(settings, /platformCapabilities\.systemTray && <Section title="Системный трей"/u);
assert.match(settings, /platformCapabilities\.nativeFilesystem && <Section title="Диагностика"/u);
assert.match(settings, /window\.dispatchEvent\(new Event\("kaigen:add-profile-request"\)\)/u);
assert.match(settings, /const revision = \+\+fileSettingsRevision\.current;[^]*if \(revision !== fileSettingsRevision\.current\) return;/u,
  "late Web responses cannot roll a newer file-toggle value back");
assert.match(settings, /Отключено: для каждого входящего PNG или JPG\/JPEG потребуется подтверждение\./u);
assert.doesNotMatch(settings, /openDialog|discover_qtox_profiles|import_qtox_profile/u);
assert.match(webRootCss, /\.web-app-window \{[^]*width: 100%;[^]*height: 100%;[^]*min-width: 0;[^]*min-height: 0;[^]*overflow: hidden;/u);
assert.match(webRootCss, /\.web-app-surface \{[^}]*overflow: hidden;/u);
assert.doesNotMatch(webRoot, /initialAppPosition|setPosition/u);
assert.match(webRoot, /await webSession\.lockWorkspace\(\);/u);
assert.match(webRoot, /await webSession\.lockWorkspace\(\);\s*flushSync\(/u,
  "successful lock unmounts consumers synchronously before queued session reads reject");
assert.match(webRoot, /await webSession\.closeWorkspace\(\);\s*flushSync\(/u);
assert.match(webRoot, /await webSession\.destroyWorkspace\(\);\s*history\.replaceState\([^\n]*\);\s*flushSync\(/u);
assert.equal([...webRoot.matchAll(/flushSync\(\(\) =>/gu)].length, 3,
  "each destructive session transition flushes only after its successful await; failures keep the mounted draft");
assert.match(webRoot, /<section className="web-app-window" inert=\{busy\}>/u);
assert.match(webRoot, /disabled=\{busy\} aria-label=\{t\.renewLease\}[^\n]*webSession\.renewLease\(\)\.catch/u);
assert.match(webRoot, /const closeApplication = useCallback\([^]*await webSession\.closeWorkspace\(\);/u);
assert.match(webRoot, /const requestClose = \(\) => \{[^]*void closeApplication\(\);[^]*addEventListener\("kaigen:web-close-request", requestClose\)/u);
assert.doesNotMatch(webRoot, /const requestClose = \(\) => \{[^}]*void lockSession\(\);/u);
assert.match(webRoot, /menu: "Управление сеансом"/u);
assert.match(webRoot, /menu: "Session management"/u);
assert.match(webRoot, /t\.lockSession[^]*t\.destroyWorkspace/u);
assert.match(webRoot, /t\.destroyWorkspace/u);
assert.match(webRoot, /await webSession\.destroyWorkspace\(\);[^]*setWorkspaceDestroyed\(true\);[^]*setStage\("initializer"\);/u);
assert.match(webRoot, /workspaceDestroyed && <p className="web-success" role="status">\{t\.destroyed\}<\/p>/u);
assert.match(webRoot, /menuRef\.current\?\.contains\(event\.target\)[^]*document\.addEventListener\("pointerdown", closeOutside\)[^]*document\.removeEventListener\("pointerdown", closeOutside\)/u);
assert.match(webRoot, /event\.key === "Escape"[^]*document\.addEventListener\("keydown", closeOnEscape\)[^]*document\.removeEventListener\("keydown", closeOnEscape\)/u);
assert.equal([...webRoot.matchAll(/role="menuitem"/gu)].length, 2, "the session dropdown keeps exactly Lock and Destroy");
assert.match(webRoot, /navigator\.clipboard\.writeText\(location\.href\)/u);
assert.match(webRoot, /className="web-lease-actions"[^]*t\.renewLease[^]*t\.copyLink/u);
assert.match(webRoot, /aria-live="polite"[^]*t\.linkCopied[^]*t\.copyFailed/u);
assert.match(webRootCss, /\.web-lease-time small,\s*\.web-lease-time strong \{[^}]*font-size: 12px;/u);
assert.doesNotMatch(webRoot, /profileExport|requestArchive|downloadProfileExport|confirmErasure|cancelArchive|archivePassword/u);
assert.match(webRoot, /createWorkspace\(\{ storageMode, accessPassword, language \}\)/u);
assert.match(webRoot, /useState<StorageMode>\("ram"\)/u,
  "new Web workspaces select volatile RAM storage by default");
assert.ok(
  webRoot.indexOf('storageMode === "ram"') < webRoot.indexOf('storageMode === "disk"'),
  "workspace creation shows RAM before disk",
);
assert.doesNotMatch(webRoot, /ProfileImportKind|profileImportOpen|profileName/u);
assert.doesNotMatch(webRoot, /restoreOpen|restoreWorkspace|restoreFile/u);
assert.match(webContracts, /storageMode: StorageMode;\s*accessPassword: string;\s*language:/u);
assert.doesNotMatch(webContracts, /profileName: string;|\n  password: string;/u);
assert.match(webSession, /archivePassword,\s*accessPassword,/u);
assert.doesNotMatch(webSession, /profilePassword/u);
assert.match(webSession, /"\/api\/v1\/workspaces\/close"/u);
for (const name of ["lockWorkspace", "closeWorkspace", "destroyWorkspace"]) {
  const start = webSession.indexOf(`  async ${name}()`);
  const end = webSession.indexOf("\n  async ", start + 1);
  assert.ok(start >= 0 && end > start);
  const transition = webSession.slice(start, end);
  assert.match(transition, /const transition = this\.beginSessionTeardown\(\);[^]*await this\.drainSessionRequests\(\);/u);
  assert.match(transition, /\}, true, true\);[^]*catch \(error\) \{\s*this\.rollbackSessionTeardown\(transition\);\s*throw error;/u);
  assert.match(transition, /this\.sessionLifecycle = "closed";[^]*await deleteDeviceRecord\([^]*this\.finishSessionTeardown\(transition\);\s*(?:return response;\s*)?\}/u);
}
assert.match(webSession, /private beginSessionTeardown\(\)[^]*this\.sessionLifecycle = "tearing-down";[^]*this\.stopRealtime\(\);/u);
assert.match(webSession, /private async drainSessionRequests\(\)[^]*this\.pendingSessionRequests[^]*this\.pendingPersistenceCommands[^]*this\.sessionRefresh[^]*Promise\.allSettled\(pending\)/u);
assert.match(webSession, /await deleteDeviceRecord\(workspaceDigest, legacyWorkspaceDigest\)\.catch/u);
assert.match(webSession, /"\/api\/v1\/workspaces\/destroy"[^]*explicitConfirmation: true[^]*if \(!response\.destroyed\)[^]*this\.identifier = "";/u);
assert.doesNotMatch(webSession, /async requestArchive|async downloadProfileExport|async cancelArchive|async confirmErasure/u);
assert.match(webPlatform, /window\.dispatchEvent\(new Event\("kaigen:web-close-request"\)\)/u);
const webInvoke = webPlatform.slice(
  webPlatform.indexOf("export async function invoke"),
  webPlatform.indexOf("export function sendFile"),
);
const webviewHeartbeatNoop = webInvoke.indexOf('if (command === "report_webview_heartbeat")');
const genericCommandForward = webInvoke.indexOf("webSession.command<T>(command, args)");
assert.match(
  webInvoke,
  /if \(command === "report_webview_heartbeat"\) \{\s*return null as T;\s*\}/u,
  "the desktop-only WebView watchdog heartbeat must be a typed no-op in the web adapter",
);
assert.ok(
  webviewHeartbeatNoop >= 0 && genericCommandForward > webviewHeartbeatNoop,
  "only the exact desktop heartbeat command is consumed before all other commands reach the web backend",
);
assert.match(webPlatform, /command === "export_tox_history"/u);
assert.match(webPlatform, /webSession\.command<ExportMessagePage>\("get_tox_messages_page"/u);
assert.match(webPlatform, /getFileHandle\(temporaryName, \{ create: true \}\)/u);
assert.match(webPlatform, /handle\.createWritable\(\)/u);
assert.match(webPlatform, /webSession\.recoverIncomingTransfer\(profileId, messageId, path\.slice\(prefix\.length\), friendNumber\)/u,
  "the Web platform supplies contact ownership when rehydrating a preview");
assert.match(webSession, /private readonly backgroundTransfers = new BackgroundTransferDiscovery\(\{[^]*load: \(\) => this\.command<BackgroundTransferSnapshot>\("get_background_transfer_work"\)[^]*recover: \(work\) => this\.recoverIncomingTransfer\(work\.profileId, work\.messageId, work\.transferId, work\.friendNumber, "automatic"\)/u,
  "the workspace singleton owns background transfer discovery independently of the open chat");
assert.match(webSession, /void this\.backgroundTransfers\.run\(\)\.catch[^]*setInterval\(\(\) => void this\.backgroundTransfers\.run\(\)\.catch/u,
  "realtime startup immediately discovers transfer work and keeps polling it");
// Field, state and direction behavior is covered by test-background-transfers.mjs
// using the same wire fixture asserted by the Rust producer test.
assert.doesNotMatch(backgroundTransfers, /this\.operations\.accept/u,
  "file receive permission is executed by the backend, never by discovery");
assert.match(messenger, /const nearby = \[\.\.\.nearViewport\][^]*setTransferPreviewPins\(activeProfileId, friendNumber, \[[^]*nearby\.flatMap[^]*fullImage\?\.path[^]*recoveringIncomingFilesRef\.current\.size >= 2[^]*recoverIncomingTransfer\(activeProfileId, messageId, path, friendNumber\)/u,
  "only visible and near-visible Web images are pinned and rehydrated with bounded concurrency");
assert.match(messenger, /new IntersectionObserver\([^]*rootMargin: "100% 0px"/u,
  "preview recovery observes one viewport beyond the rendered chat window");
assert.match(messenger, /observer\.disconnect\(\);[^]*generation !== viewOwnerRef\.current\.generation[^]*setTransferPreviewPins\(activeProfileId, friendNumber, \[\]\)/u,
  "leaving a rendered range removes its preview pins");
assert.match(messenger, /const previewInvalidated[^]*detail\?\.profileId === activeProfileId && detail\.friendNumber === active\.friendNumber[^]*addEventListener\("kaigen:transfer-preview-invalidated", previewInvalidated\)/u,
  "Blob URL eviction refreshes only the matching active chat snapshot");
assert.doesNotMatch(webPlatform, /"get_tox_messages", \{ friendNumber \}/u);
assert.doesNotMatch(webPlatform, /window\.addEventListener\("drop"/u);
assert.match(webPlatform, /input\.webkitdirectory = true;/u);
assert.match(webPlatform, /browser-directory:\/\//u);
assert.match(webPlatform, /browser-qtox:\/\//u);
assert.match(webPlatform, /createStoredQtoxZip\(files, source\.relativePath\)/u);
assert.match(webPlatform, /webSession\.importProfile\(archive, "qtoxZip"/u);
assert.match(rootApp, /extensions: \["kai", "zip"\]/u);
assert.match(rootApp, /const browseFile = async/u);
assert.match(rootApp, /const browseFolder = async/u);
assert.doesNotMatch(rootApp, /extensions: \["kai", "tox"\]|qtoxSearchComplete|discover\(folder\)/u);
assert.match(rootApp, /const password = passwords\[profile\.id\] \?\? "";[^]*\(profile\.encrypted && !password\)/u);
assert.match(rootApp, /!profile\.loaded && <>\{profile\.encrypted && <input[^]*t\("Подключить"\)/u);
assert.match(rootApp, /onConnected\(nextProfiles\)/u);
assert.match(rootApp, /profiles\.some\(\(profile\) => profile\.loaded && profile\.active\)[^]*updateMainWindowProfiles\(profiles\)/u);
assert.match(rootApp, /onConnected=\{updateMainWindowProfiles\}/u);
assert.match(webServer, /"set_profile_avatar" =>/u);
assert.match(webServer, /"send_tox_avatar" =>/u);
assert.match(webServer, /"fileName": format!\("\{\}\.kai", profile\.id\)/u);
assert.match(webCore, /fn normalize_web_file_settings\([^]*settings\.max_auto_bytes = settings\.max_auto_bytes\.min\(crate::MAX_CHAT_FILE_BYTES\);[^]*settings\.max_concurrent = settings\.max_concurrent\.clamp\(1, 2\);/u,
  "Web preserves user-selected receive policy while enforcing only product bounds");
assert.doesNotMatch(webCore, /settings\.auto_accept_images = false|settings\.show_images = false|settings\.auto_accept_any = false/u,
  "Web must never silently reset file toggles while opening a workspace or saving settings");

function qtoxFile(relativePath, contents) {
  const file = new File([contents], relativePath.split("/").at(-1));
  Object.defineProperty(file, "webkitRelativePath", { value: `selected-qtox/${relativePath}` });
  return file;
}

const qtoxFolder = [
  qtoxFile("alice.tox", "alice-profile"),
  qtoxFile("alice.db", "alice-history"),
  qtoxFile("alice.ini", "alice-settings"),
  qtoxFile("avatars/owner.png", "alice-avatar"),
  qtoxFile("bob.tox", "bob-profile"),
  qtoxFile("bob.db", "bob-history"),
  qtoxFile("unrelated.log", "unrelated"),
];
assert.deepEqual(listQtoxFolderProfiles(qtoxFolder), [
  { name: "alice", relativePath: "alice.tox" },
  { name: "bob", relativePath: "bob.tox" },
]);
const qtoxArchive = await createStoredQtoxZip(qtoxFolder, "alice.tox");
const qtoxArchiveBytes = new Uint8Array(await qtoxArchive.arrayBuffer());
const qtoxArchiveView = new DataView(qtoxArchiveBytes.buffer);
const qtoxArchiveText = new TextDecoder().decode(qtoxArchiveBytes);
assert.equal(qtoxArchive.type, "application/zip");
assert.equal(qtoxArchiveView.getUint32(0, true), 0x04034b50);
assert.equal(qtoxArchiveView.getUint16(8, true), 0, "browser qTox folders use ZIP store mode");
assert.match(qtoxArchiveText, /alice\.tox/u);
assert.match(qtoxArchiveText, /alice\.db/u);
assert.match(qtoxArchiveText, /alice\.ini/u);
assert.match(qtoxArchiveText, /avatars\/owner\.png/u);
assert.doesNotMatch(qtoxArchiveText, /bob\.tox|bob-history|unrelated/u);
assert.throws(
  () => listQtoxFolderProfiles([qtoxFile("../escape.tox", "escape")]),
  /QTOX_FOLDER_PATH_INVALID/u,
);
assert.throws(
  () => listQtoxFolderProfiles(Array.from({ length: MAX_QTOX_FOLDER_FILES + 1 }, (_, index) => qtoxFile(`${index}.txt`, ""))),
  /QTOX_FOLDER_FILE_COUNT_INVALID/u,
);
await assert.rejects(
  createStoredQtoxZip([qtoxFile("empty.tox", "")], "empty.tox"),
  /QTOX_PROFILE_SELECTION_INVALID/u,
);

console.log("Browser runtime compatibility contracts passed.");
