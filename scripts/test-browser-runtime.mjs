import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createStoredQtoxZip,
  listQtoxFolderProfiles,
  MAX_QTOX_FOLDER_FILES,
} from "../src/platform/browser-profile-import.ts";

const spellcheckComposer = await readFile(new URL("../src/SpellcheckComposer.tsx", import.meta.url), "utf8");
const textEditContextMenu = await readFile(new URL("../src/TextEditContextMenu.tsx", import.meta.url), "utf8");
const editableTextTarget = await readFile(new URL("../src/editableTextTarget.ts", import.meta.url), "utf8");
const webSession = await readFile(new URL("../src/web/session.ts", import.meta.url), "utf8");
const webRoot = await readFile(new URL("../src/web/WebRoot.tsx", import.meta.url), "utf8");
const webRootCss = await readFile(new URL("../src/web/WebRoot.css", import.meta.url), "utf8");
const messenger = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const rootApp = await readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8");
const avatar = await readFile(new URL("../src/avatar.ts", import.meta.url), "utf8");
const settings = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const webPlatform = await readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8");
const webContracts = await readFile(new URL("../src/web/contracts.ts", import.meta.url), "utf8");
const webServer = await readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8");
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
assert.match(textEditContextMenu, /if \(isEditableTextTarget\(event\.target\)\) return;\s*event\.preventDefault\(\);/u);
assert.match(editableTextTarget, /target\.closest\("input, textarea, \[contenteditable\]"\)/u);
assert.doesNotMatch(editableTextTarget, /from "react"|useEffect|useState|useMemo|useRef/u);
assert.match(textEditContextMenu, /from "\.\/editableTextTarget"/u);
assert.match(messenger, /from "\.\/editableTextTarget"/u);
assert.doesNotMatch(messenger, /from "\.\/TextEditContextMenu"/u);
assert.doesNotMatch(textEditContextMenu, /navigator\.clipboard|execCommand|createPortal/u);
assert.match(messenger, /if \(isEditableTextTarget\(event\.target\)\) \{\s*setGeneralContext\(null\);\s*return;\s*\}\s*event\.preventDefault\(\);/u);
assert.match(spellcheckComposer, /const token = misspelledTokenAtPoint\([^]*if \(!token\) \{\s*setMenu\(null\);\s*return;\s*\}\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);/u);
assert.doesNotMatch(spellcheckComposer, /readClipboardFile|navigator\.clipboard\.readText|document\.execCommand\("paste"\)|editAction\("paste"\)|>Вставить<\/button>/u);
assert.match(spellcheckComposer, /onPaste=\{\(event\) => \{\s*const file = pastedFile\(event\.clipboardData\);/u);
for (const policyName of ["csp", "devCsp"]) {
  const policy = tauriConfig.app.security[policyName];
  assert.equal(policy["script-src"], "'self'");
  assert.equal(policy["script-src-attr"], "'none'");
  assert.equal(policy["require-trusted-types-for"], "'script'");
  assert.equal(policy["trusted-types"], "kaigen-spellcheck-worker");
}
assert.equal(tauriConfig.app.windows[0].dragDropEnabled, false);

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
assert.match(messenger, /onPickFile=\{platformCapabilities\.nativeFilesystem \? pickNativeFile : undefined\}/u);
assert.match(messenger, /event\.dataTransfer\.files\[0\]/u);
assert.doesNotMatch(messenger, /onDragDropEvent\(/u);
assert.match(messenger, /platformCapabilities\.nativeFilesystem && <button className="rail-button downloads-button"/u);
assert.match(messenger, /platformCapabilities\.product === "desktop" && message\.mine/u);
assert.match(messenger, /normalizeProfileAvatar\(avatar\)[^]*setProfileAvatar\(dataUrl\)/u);
assert.doesNotMatch(messenger, /setProfileAvatar\(avatar\);/u);
assert.match(rootApp, /dataUrl: avatar\.dataUrl,[^]*bytes: avatar\.bytes,/u);
assert.match(avatar, /bytes\.byteLength <= TOX_AVATAR_MAX_BYTES[^]*dataUrl: await blobDataUrl\(blob\)/u);
assert.match(settings, /platformCapabilities\.systemTray && <Section title="Системный трей"/u);
assert.match(settings, /platformCapabilities\.nativeFilesystem && <Section title="Диагностика"/u);
assert.match(settings, /window\.dispatchEvent\(new Event\("kaigen:add-profile-request"\)\)/u);
assert.doesNotMatch(settings, /openDialog|discover_qtox_profiles|import_qtox_profile/u);
assert.match(webRootCss, /\.web-app-window \{[^]*width: max\(860px, 95vw\);[^]*height: max\(560px, calc\(95vh - 60\.8px\)\);/u);
assert.match(webRootCss, /\.web-app-surface \{\s*overflow: hidden;/u);
assert.match(webRoot, /const \[position, setPosition\] = useState\(initialAppPosition\);/u);
assert.match(webRoot, /await webSession\.lockWorkspace\(\);/u);
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
assert.doesNotMatch(webRoot, /ProfileImportKind|profileImportOpen|profileName/u);
assert.doesNotMatch(webRoot, /restoreOpen|restoreWorkspace|restoreFile/u);
assert.match(webContracts, /storageMode: StorageMode;\s*accessPassword: string;\s*language:/u);
assert.doesNotMatch(webContracts, /profileName: string;|\n  password: string;/u);
assert.match(webSession, /archivePassword,\s*accessPassword,/u);
assert.doesNotMatch(webSession, /profilePassword/u);
assert.match(webSession, /"\/api\/v1\/workspaces\/close"/u);
assert.match(webSession, /await deleteDeviceRecord\(workspaceDigest, legacyWorkspaceDigest\)\.catch/u);
assert.match(webSession, /"\/api\/v1\/workspaces\/destroy"[^]*explicitConfirmation: true[^]*if \(!response\.destroyed\)[^]*this\.identifier = "";/u);
assert.doesNotMatch(webSession, /async requestArchive|async downloadProfileExport|async cancelArchive|async confirmErasure/u);
assert.match(webPlatform, /window\.dispatchEvent\(new Event\("kaigen:web-close-request"\)\)/u);
assert.match(webPlatform, /command === "export_tox_history"/u);
assert.match(webPlatform, /webSession\.command<ExportMessagePage>\("get_tox_messages_page"/u);
assert.match(webPlatform, /getFileHandle\(temporaryName, \{ create: true \}\)/u);
assert.match(webPlatform, /handle\.createWritable\(\)/u);
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
