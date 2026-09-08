import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const fileDrop = await importTypeScriptModule(new URL("../src/chatFileDrop.ts", import.meta.url));
const torRuntime = await importTypeScriptModule(new URL("../src/torRuntimeState.ts", import.meta.url));
const chatTypography = await importTypeScriptModule(new URL("../src/chatTypography.ts", import.meta.url));
const settingsUiCatalog = JSON.parse(await readFile(new URL("../src/Settings.ui-ids.json", import.meta.url), "utf8"));

const activeChat = {
  screen: "chat",
  friendNumber: 0,
  addContactOpen: false,
  incomingRequestsOpen: false,
};

assert.equal(fileDrop.hasFileDragType(["text/plain", "Files"]), true);
assert.equal(fileDrop.hasFileDragType(["text/plain"]), false, "profile reorder drags are not file drags");
assert.equal(fileDrop.hasFileDragType(null), false);
assert.equal(fileDrop.canStageChatFile(activeChat), true, "friend number zero is a valid active chat");
assert.equal(fileDrop.canStageChatFile({ ...activeChat, friendNumber: undefined }), false, "files need an active chat");
assert.equal(fileDrop.canStageChatFile({ ...activeChat, friendNumber: -1 }), false);
assert.equal(fileDrop.canStageChatFile({ ...activeChat, friendNumber: Number.NaN }), false);
assert.equal(fileDrop.canStageChatFile({ ...activeChat, screen: "settings" }), false);
assert.equal(fileDrop.canStageChatFile({ ...activeChat, addContactOpen: true }), false);
assert.equal(fileDrop.canStageChatFile({ ...activeChat, incomingRequestsOpen: true }), false);

const coldStart = torRuntime.initialTorStatus();
assert.equal(coldStart.state, "starting", "the first mount may show the real cold-start state");

const connected = {
  state: "connected",
  progress: 100,
  message: null,
  socksPort: 9050,
  controlPort: 9051,
  transport: "snowflake",
};
const retained = torRuntime.retainTorStatus(connected);
connected.state = "error";
retained.message = "mutated caller copy";
assert.deepEqual(torRuntime.initialTorStatus(), {
  state: "connected",
  progress: 100,
  message: null,
  socksPort: 9050,
  controlPort: 9051,
  transport: "snowflake",
}, "profile remounts reuse a defensive copy of the last observed global Tor state");

torRuntime.retainTorStatus({
  state: "connecting",
  progress: 42,
  message: "Подключение",
  socksPort: null,
  controlPort: null,
  transport: "obfs4",
});
assert.equal(torRuntime.initialTorStatus().state, "connecting", "real runtime transitions remain visible");

const proxy = {
  mode: "socks5",
  host: "127.0.0.1",
  port: 9150,
  username: "local",
  password: "secret",
};
const retainedProxy = torRuntime.retainProxySettings(proxy);
proxy.mode = "none";
retainedProxy.host = "mutated";
assert.deepEqual(torRuntime.initialProxySettings(), {
  mode: "socks5",
  host: "127.0.0.1",
  port: 9050,
  username: "",
  password: "",
}, "profile remounts retain only the non-secret global proxy mode");
assert.deepEqual(retainedProxy, {
  mode: "socks5",
  host: "mutated",
  port: 9050,
  username: "",
  password: "",
}, "the retained proxy snapshot never contains workspace credentials");

const [appSource, composerSource, avatarSource, cssSource, settingsSource, desktopSource, webPlatformSource, webSessionSource, rustSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/SpellcheckComposer.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/ProfileAvatar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/desktop.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/platform/web.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/web/session.ts", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
]);
const [mainSource, indexSource, fontCssSource, packageSource, lockSource, readmeSource] = await Promise.all([
  readFile(new URL("../src/main.tsx", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/assets/fonts/kaigen-fonts.css", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
  readFile(new URL("../README.md", import.meta.url), "utf8"),
]);

assert.match(avatarSource, /<img\s+src=\{src\}\s+alt=\{alt\}\s+draggable=\{false\}\s*\/>/);
assert.match(cssSource, /\.tor-shield-ellipsis\s*\{[^}]*fill:\s*currentColor;/);
assert.match(cssSource, /\.tor-indicator\s*\{[^}]*appearance:\s*none;[^}]*cursor:\s*pointer;/);
assert.match(settingsSource, /SettingsOpenRequest\s*=\s*\{\s*tab:\s*"profile"\s*\|\s*"profiles"\s*\|\s*"tor";/);
assert.match(settingsSource, /export type \{ TorStatus \} from "\.\/torRuntimeState";/);
const expectedSupportWallets = [
  ["bitcoin", "Bitcoin", "bc1qm2cwypklr8f2gwmjt824umj6v407hwfte777d7"],
  ["usdt", "USDT-TRC20", "TTRSU3xfWbAmZPFT9pVJNYebs9vch3kahT"],
  ["litecoin", "Litecoin", "ltc1qd3v3x3y4jn9quj9p9t6g8lfwgw2nwek3wlk7rm"],
  ["monero", "Monero", "8AuR9TR186nT3LkcrC7jRBVwb4qjL2mVJWvHcPUxeZ27DNtpx4ZXEEpbk1v2sgDAkWNahngm3RdDWXXv2wQd2QkgRMAzXLB"],
];
const supportWalletCatalog = settingsSource.match(/const SUPPORT_WALLETS = \[([^]*?)\] as const;/u)?.[1] ?? "";
const settingsSupportWallets = [...supportWalletCatalog.matchAll(/\{ kind: "([a-z]+)", label: "([^"]+)", value: "([^"]+)" \}/gu)]
  .map((match) => match.slice(1));
assert.deepEqual(settingsSupportWallets, expectedSupportWallets,
  "support wallets preserve exact label, address, and Bitcoin -> USDT-TRC20 -> Litecoin -> Monero order");
assert.match(settingsSource, /SUPPORT_WALLETS\.map\(\(\{ kind, label, value \}\) => <div key=\{kind\}><span>\{label\}<\/span><code>\{value\}<\/code><button[^]*?onClick=\{\(\) => copyWallet\(kind, value\)\}[^]*?copiedWallet === kind/u,
  "each rendered wallet and its copy action must consume the same canonical value");
const readmeSupportWallets = [...readmeSource.matchAll(/^- (Bitcoin|USDT-TRC20|Litecoin|Monero): `([^`\r\n]+)`$/gmu)]
  .map((match) => match.slice(1));
assert.deepEqual(readmeSupportWallets, expectedSupportWallets.map(([, label, value]) => [label, value]),
  "README support wallets must exactly match the application catalog and order");
const walletSurfaces = `${settingsSource}\n${readmeSource}`;
const bitcoinCandidates = walletSurfaces.match(/\bbc1[ac-hj-np-z02-9]{11,71}\b/gu) ?? [];
const tronCandidates = walletSurfaces.match(/\bT[1-9A-HJ-NP-Za-km-z]{33}\b/gu) ?? [];
assert.deepEqual(bitcoinCandidates, [expectedSupportWallets[0][2], expectedSupportWallets[0][2]],
  "Settings and README must contain only the exact current Bitcoin address");
assert.deepEqual(tronCandidates, [expectedSupportWallets[1][2], expectedSupportWallets[1][2]],
  "Settings and README must contain only the exact current TRON address");
const expectedTypography = [
  ["ibm-plex-sans-condensed", "IBM Plex Sans Condensed"],
  ["fira-sans-condensed", "Fira Sans Condensed"],
  ["noto-sans-semi-condensed", "Noto Sans SemiCondensed"],
  ["source-sans-3", "Source Sans 3"],
  ["golos-text", "Golos Text"],
  ["martian-mono", "Martian Mono"],
  ["inter", "Inter"],
  ["onest", "Onest"],
];
assert.deepEqual(chatTypography.TYPOGRAPHY_FONTS.map(({ id, label }) => [id, label]), expectedTypography,
  "all requested families share one typed catalog used by each independent setting");
assert.deepEqual(chatTypography.DEFAULT_APPEARANCE, {
  interfaceFont: "inter",
  interfaceFontSize: 16,
  chatFont: "golos-text",
  chatFontSize: 15,
  profilePlaceholderFont: "onest",
  profilePlaceholderFontSize: 45,
  interfaceScale: 100,
}, "the applied mock typography is the additive migration default");
assert.deepEqual(chatTypography.normalizeAppearance({
  chatFont: 'Inter, "Segoe UI", Arial, sans-serif',
  chatFontSize: 20,
  interfaceScale: 110,
}), {
  interfaceFont: "inter",
  interfaceFontSize: 16,
  chatFont: "inter",
  chatFontSize: 20,
  profilePlaceholderFont: "onest",
  profilePlaceholderFontSize: 45,
  interfaceScale: 110,
}, "old saved layouts keep valid choices and receive the two new typography pairs");
assert.deepEqual(chatTypography.normalizeAppearance({
  interfaceFont: "system-only",
  interfaceFontSize: 19,
  chatFont: "arial",
  chatFontSize: 17,
  profilePlaceholderFont: "missing",
  profilePlaceholderFontSize: 44,
  interfaceScale: 111,
}), chatTypography.DEFAULT_APPEARANCE, "invalid persisted values fail closed to complete defaults");
assert.equal(chatTypography.getTypographyFont("noto-sans-semi-condensed", "inter").stretch, "87.5%");
assert.equal((settingsSource.match(/TYPOGRAPHY_FONTS\.map/gu) ?? []).length, 3,
  "interface, chat, and placeholder selectors independently expose the full catalog");
for (const elementId of ["interface-font", "interface-font-size", "chat-font", "chat-font-size", "placeholder-font", "placeholder-font-size"]) {
  const key = `settings_chat_element_${elementId.replaceAll("-", "_")}`;
  assert.equal(settingsUiCatalog.ids[key], `kaigen.settings.chat.element.${elementId}`, `missing typography source declaration: ${elementId}`);
  assert.ok(settingsSource.includes(`SETTINGS_UI_IDS.${key}`), `missing typography declaration consumer: ${elementId}`);
}
const declaredTypographyIds = Object.entries(settingsUiCatalog.ids)
  .filter(([key]) => /^settings_chat_element_(?:interface_font|interface_font_size|chat_font|chat_font_size|placeholder_font|placeholder_font_size)$/u.test(key))
  .map(([, id]) => id);
assert.equal(declaredTypographyIds.length, 6, "each typography control has one source-owned permanent UI ID");
assert.equal(new Set(declaredTypographyIds).size, 6, "typography UI IDs are unique before capture");
for (const property of ["--interface-font", "--interface-font-size", "--interface-font-stretch", "--chat-font", "--chat-font-size", "--chat-font-stretch", "--profile-placeholder-font", "--profile-placeholder-font-scale", "--profile-placeholder-font-stretch"]) {
  assert.ok(appSource.includes(`"${property}"`), `App must publish ${property}`);
}
assert.match(cssSource, /\.app-shell \{[^}]*font-family: var\(--interface-font[^}]*font-size: var\(--interface-font-size[^}]*font-stretch: var\(--interface-font-stretch/su);
assert.match(cssSource, /\.message p,\s*\.compose-row textarea \{[^}]*font-family: var\(--chat-font\);[^}]*font-size: var\(--chat-font-size\);[^}]*font-stretch: var\(--chat-font-stretch/su);
assert.match(cssSource, /\.spellcheck-overlay \{[^}]*font-family: var\(--chat-font\);[^}]*font-size: var\(--chat-font-size\);[^}]*font-stretch: var\(--chat-font-stretch/su);
assert.match(cssSource, /\.avatar-initial,\s*\.profile-avatar-initial \{[^}]*font-family: var\(--profile-placeholder-font[^}]*font-stretch: var\(--profile-placeholder-font-stretch/su);
assert.match(cssSource, /\.avatar-initial \{ font-size: calc\(var\(--avatar-placeholder-base\) \* var\(--profile-placeholder-font-scale/su);
assert.match(cssSource, /\.profile-avatar-initial \{ font-size: calc\(var\(--profile-avatar-size\) \* var\(--profile-placeholder-font-scale/su);
assert.match(mainSource, /import "\.\/assets\/fonts\/kaigen-fonts\.css";/);
assert.match(indexSource, /body \{[^}]*font-family: "Inter", sans-serif;/u,
  "the pre-React startup surface uses the bundled interface default");
assert.doesNotMatch(fontCssSource, /https?:|local\(/u, "runtime font loading must be strictly local and deterministic");
assert.ok(fontCssSource.lastIndexOf("@import") < fontCssSource.indexOf("@font-face"),
  "CSS imports must precede every local face declaration");
assert.match(fontCssSource, /IBMPlexSansCondensed-Regular-Cyrillic\.woff2[^}]*U\+0400-045F/su,
  "IBM Plex must include basic Russian Cyrillic instead of only cyrillic-ext");

const expectedPackages = {
  "@ibm/plex-sans-condensed": "2.0.0",
  "@fontsource/fira-sans-condensed": "5.3.0",
  "@fontsource-variable/noto-sans": "5.3.0",
  "@fontsource/source-sans-3": "5.3.0",
  "@fontsource/golos-text": "5.3.0",
  "@fontsource/martian-mono": "5.3.0",
  "@fontsource/inter": "5.3.0",
  "@fontsource/onest": "5.3.0",
};
const packageJson = JSON.parse(packageSource);
const packageLock = JSON.parse(lockSource);
for (const [name, version] of Object.entries(expectedPackages)) {
  assert.equal(packageJson.dependencies[name], version, `${name} must be an exact direct pin`);
  assert.equal(packageLock.packages[`node_modules/${name}`]?.version, version, `${name} lock pin must match`);
}
assert.equal(packageJson.dependencies["@fontsource/ibm-plex-sans-condensed"], undefined,
  "the incomplete Fontsource IBM package must not remain as a misleading fallback");

const fontAssets = [
  ["node_modules/@ibm/plex-sans-condensed/fonts/split/woff2/IBMPlexSansCondensed-Regular-Cyrillic.woff2", 19680, "207aae6e471c7e9c8bcc2a402c4cfa574afb733f4392ecb54bb7b997638ae613"],
  ["node_modules/@ibm/plex-sans-condensed/fonts/split/woff2/IBMPlexSansCondensed-Regular-Latin1.woff2", 21816, "9890d76dfb458471559cb28034e34a06abb70c23d92656b9f2a7ce23cd4a9932"],
  ["node_modules/@ibm/plex-sans-condensed/fonts/split/woff2/IBMPlexSansCondensed-Medium-Cyrillic.woff2", 20536, "6a0739f814f8a3ab6b5cfc9113febb19145334acc4be86c495ef634e6dac9e7f"],
  ["node_modules/@ibm/plex-sans-condensed/fonts/split/woff2/IBMPlexSansCondensed-Medium-Latin1.woff2", 22088, "77566d36b1dea360fcdadfa87766cea062d917d73bf7e6e3f52ca4b35edf405d"],
  ["node_modules/@fontsource-variable/noto-sans/files/noto-sans-cyrillic-wdth-normal.woff2", 33972, "e59de910e925713ad2e6c09043147a867725b4676f7759b28b8b314742f05ed3"],
  ["node_modules/@fontsource-variable/noto-sans/files/noto-sans-latin-wdth-normal.woff2", 59928, "df8c8215937ab2a4270c0cd997101b3fb8cdd444c9903d342200d6179ebcc097"],
  ["node_modules/@fontsource/fira-sans-condensed/files/fira-sans-condensed-cyrillic-400-normal.woff2", 10840, "82ac95675444358a5165f10e4ed652ec0ab6eeef83e6747656e9b6efcf5f5cca"],
  ["node_modules/@fontsource/fira-sans-condensed/files/fira-sans-condensed-latin-400-normal.woff2", 24028, "73d6a1d1a9b43f27a99c2e699f39a585bbdb32710bfd5ef862ac0f34d4aa6b73"],
  ["node_modules/@fontsource/fira-sans-condensed/files/fira-sans-condensed-cyrillic-500-normal.woff2", 10776, "8cbeef86156dede9108c355e4f7cffa6e725171ddb6d8c0f23b959485ec233bf"],
  ["node_modules/@fontsource/fira-sans-condensed/files/fira-sans-condensed-latin-500-normal.woff2", 24100, "d3c00b8e38ef705dad5f0417a004e2e927765ef8d504d1e3e35deec6e4ca19df"],
  ["node_modules/@fontsource/source-sans-3/files/source-sans-3-cyrillic-400-normal.woff2", 9604, "b0324c3af47c138a2b5457466037637b8279576197024ed6968041836ffc0546"],
  ["node_modules/@fontsource/source-sans-3/files/source-sans-3-latin-400-normal.woff2", 15696, "0f73f35e08cde0a2f10c109c6e01d71459d97e4099ecd9a50f1b6c0209e4de2b"],
  ["node_modules/@fontsource/source-sans-3/files/source-sans-3-cyrillic-500-normal.woff2", 9560, "a8b6600fa85eaf7d5677c92ec0f2d1775c1bc43c5dbe9c1bf523c75dd8d20786"],
  ["node_modules/@fontsource/source-sans-3/files/source-sans-3-latin-500-normal.woff2", 15652, "3b3a8b8e4a422ff71c9ffb0836a4d48ff337a4419b878214f65d6ebe0f59fa51"],
  ["node_modules/@fontsource/golos-text/files/golos-text-cyrillic-400-normal.woff2", 6960, "15a5cbadfc1aa7a541651600b757bf7b67bce4e145b3239de072db5427889605"],
  ["node_modules/@fontsource/golos-text/files/golos-text-latin-400-normal.woff2", 11992, "c8246f55dbddb17ceab94b8de2dbcf326dc189f3bc5a8c13d7b14ad05d7d1d81"],
  ["node_modules/@fontsource/golos-text/files/golos-text-cyrillic-500-normal.woff2", 7044, "22337b726df83521c7f6b2709e4717116eb53106c6140b45d751f36910191ecc"],
  ["node_modules/@fontsource/golos-text/files/golos-text-latin-500-normal.woff2", 12032, "779e46588bc6f5f18918dcdf87d609a8053e1c925abd9e94d2b46b0254f36b24"],
  ["node_modules/@fontsource/martian-mono/files/martian-mono-cyrillic-400-normal.woff2", 4660, "b4099b8a80cc737295da12e6ad7615882ddd9d9af2c7d5158cf23e3f4d992d0f"],
  ["node_modules/@fontsource/martian-mono/files/martian-mono-latin-400-normal.woff2", 10352, "bb677c9c5cf5b384b5e4a1fd86755a47e0cbafe6bc70a9ba458b5e13e1d7a5c0"],
  ["node_modules/@fontsource/martian-mono/files/martian-mono-cyrillic-500-normal.woff2", 4764, "fe9594bf62b4dff6d15312a140194f392568d3a120cb24c36313849b5e9aec59"],
  ["node_modules/@fontsource/martian-mono/files/martian-mono-latin-500-normal.woff2", 10644, "98f9af6b1f769d57e58f6fd4e53d813be82106c7d24d84213a74836548e44071"],
  ["node_modules/@fontsource/inter/files/inter-cyrillic-400-normal.woff2", 7712, "f0bb586459ce8f09b238285040f17e3e9e9538b2c5a7aae0775194e33c36c3c3"],
  ["node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2", 23664, "8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc"],
  ["node_modules/@fontsource/inter/files/inter-cyrillic-500-normal.woff2", 7900, "b77a86ec16aadc157f4a99e8898d71cd75ea264753d9bdf13f962f8c3988cbb0"],
  ["node_modules/@fontsource/inter/files/inter-latin-500-normal.woff2", 24272, "f3779f1efccc4bdcdf9c0a02ab95bf6bd092ed09c48c08cedc725889edd1d19f"],
  ["node_modules/@fontsource/onest/files/onest-cyrillic-400-normal.woff2", 6140, "b5f227c546c9e0b46bb9a7a87b1d9237bea7dc3fb2843314d13a141b8f10cb29"],
  ["node_modules/@fontsource/onest/files/onest-latin-400-normal.woff2", 14008, "a1a04e2fc98112dca466ca2012f70df3ffc6728481a2edead5b7030e227af9bc"],
  ["node_modules/@fontsource/onest/files/onest-cyrillic-500-normal.woff2", 6248, "d9729817d816e6b38bc576e1ae4d76d50393fc1987479aa624bd331ca00481a8"],
  ["node_modules/@fontsource/onest/files/onest-latin-500-normal.woff2", 14660, "7c1e312df6aa912caf5feeb738623cf42b48f330f6d22608a5d6185648d5eba0"],
];
const importedCss = (await Promise.all(
  [...fontCssSource.matchAll(/@import "([^"]+)";/gu)]
    .map((match) => readFile(new URL(`../node_modules/${match[1]}`, import.meta.url), "utf8")),
)).join("\n");
const referencedFontCss = `${fontCssSource}\n${importedCss}`;
for (const [path, size, sha256] of fontAssets) {
  const contents = await readFile(new URL(`../${path}`, import.meta.url));
  assert.equal(contents.byteLength, size, `${path} size drift`);
  assert.equal(createHash("sha256").update(contents).digest("hex"), sha256, `${path} hash drift`);
  assert.ok(referencedFontCss.includes(path.split("/").at(-1)), `${path} must be reachable from the font entrypoint`);
}
for (const family of ["IBM Plex Sans Condensed", "Fira Sans Condensed", "Noto Sans Variable", "Source Sans 3", "Golos Text", "Martian Mono", "Inter", "Onest"]) {
  assert.ok(referencedFontCss.includes(`font-family: '${family}'`) || referencedFontCss.includes(`font-family: "${family}"`), `${family} must have a bundled face`);
}
assert.match(cssSource, /\.own-tox-id code\s*\{[^}]*font-family:\s*"Martian Mono", monospace;/u);
assert.doesNotMatch(cssSource, /font(?:-family|):[^;\n}]*(?:Segoe UI|Arial|Verdana|Georgia|Times New Roman|Courier New|Cascadia Code|Consolas)/u,
  "rendered app CSS must not select an unbundled named system font");
assert.match(appSource, /canStageFileForActiveChat && isDraggingFile/,
  "the drop overlay is impossible without an active recipient");
assert.match(appSource, /pendingFileMatchesActiveTarget && pendingFiles\.length > 0/,
  "the batch confirmation overlay requires the exact profile, chat, and recipient that staged every file");
assert.match(appSource, /fileActionsEnabled=\{canStageFileForActiveChat\}/,
  "the existing composer disables every file entry point without an active recipient");
assert.match(composerSource, /className="attach" disabled=\{!fileActionsEnabled\}/);
assert.match(composerSource, /type="file" multiple disabled=\{!fileActionsEnabled\}/);
assert.match(appSource, /const admission = admitChatFileBatch\(files\);/,
  "every picker and drag/drop batch must pass through the shared five-file and size admission policy");
assert.match(appSource, /failureNotices\.push\(`\$\{selection\.file\.name\}:/,
  "a per-file backend refusal must retain the rejected filename in the confirmation UI");
assert.match(appSource, /isTerminalTransferState\(message\.attachment\.transferState\)[^]*image-transfer-terminal/u,
  "a cancelled or failed outgoing image needs an explicit terminal badge instead of looking delivered");
assert.match(cssSource, /\.image-transfer-terminal\s*\{[^}]*pointer-events:\s*none;/su,
  "the terminal image badge must be visible without intercepting chat interaction");
assert.match(composerSource, /onPaste=\{\(event\) => \{\s*if \(!fileActionsEnabled\) return;/);
assert.match(appSource, /!pendingFiles\.every\(\(file\) => sameChatFileTarget\(activeFileTarget, file\)\)/,
  "send confirmation rechecks the exact recipient target for the full batch");
assert.match(appSource, /for \(const selection of pendingFiles\)[^]*sendFile\(selection\.profileId, selection\.friendNumber, selection\.file, selection\.grantToken\)/,
  "every confirmed file is added to the bound recipient queue");
assert.match(appSource, /attachment\.transferState === "queued"\) return mine \? "Ожидает отправки" : "Ожидает получения"/,
  "queued cards preserve their actual incoming or outgoing direction");
assert.match(appSource, /mine \? "ожидание получателя…" : "ожидание данных…"/,
  "an outgoing transfer waiting for peer demand is not described like an incoming download");
const backgroundTransferSource = await readFile(new URL("../src/web/backgroundTransfers.ts", import.meta.url), "utf8");
assert.match(backgroundTransferSource, /catch \(error\)[^]*attempts\.set\(entry\.transferId[^]*Math\.min\(30_000/,
  "a transient Web auto-accept failure is retried instead of blocking the queue forever");
assert.match(appSource, /fileSendBusyRef\.current[^]*disabled=\{fileSendBusy\}/,
  "rapid confirmation clicks cannot enqueue duplicate file batches");
assert.match(appSource, /window\.setTimeout\(resetFileDrag, 180\)[^]*window\.addEventListener\("blur", onDragEnd\)/,
  "lost browser dragleave events have both a watchdog and window-blur cleanup");
assert.match(appSource, /const incomingNavigationTarget = newlyArrivedIncoming\[0\];[^]*scheduleIncomingScroll\(target\.coreId \?\? String\(target\.id\), previousDistance\)/,
  "every newly arrived incoming message becomes the current auto-scroll target");
assert.match(appSource, /shouldShowTransferActivity\(message\.attachment\.completed, message\.attachment\.transferState\)/,
  "cancelled transfer cards use the terminal-state activity guard");
assert.match(appSource, /shouldShowPendingDelivery\(message\.delivery, message\.attachment\.transferState\)/,
  "cancelled transfer cards use the terminal-state delivery guard");
assert.match(appSource, /revision !== nativeFilePickRevisionRef\.current[^]*discardNativeSelections\(batch\.accepted\)/,
  "a native picker result is discarded if a profile or chat changed while the dialog was open");
assert.match(appSource, /const discardNativeSelections[^]*discard_native_file_grant/,
  "discarding a stale native batch invalidates every file grant");
assert.match(appSource, /sendFile\(selection\.profileId, selection\.friendNumber, selection\.file, selection\.grantToken\)/,
  "confirmed file sends use the staged recipient instead of mutable current UI state");
assert.match(desktopSource, /sendFile\(\s*profileId: string,[^]*invoke\("send_tox_file_from_grant", \{\s*profileId,[^]*NATIVE_FILE_GRANT_REQUIRED/,
  "desktop sends require a native grant bound to the exact staged profile");
assert.match(webPlatformSource, /sendBrowserFile\(profileId, friendNumber, file\)/,
  "the Web adapter forwards the exact staged profile");
assert.match(webSessionSource, /sendBrowserFile\(profileId: string, friendNumber: number, file: File\)[^]*body: JSON\.stringify\(\{\s*profileId,[^]*writeTransferCache\(transfer\.id, file, transfer\.mime\)[^]*startOutgoingTransfer\(transfer, source\)[^]*"X-Kaigen-Profile-Id": profileId,/,
  "the Web transfer request binds its staged OPFS source and upload to the exact profile");
assert.match(appSource, /const transferProfileId = activeProfileId;[^]*invoke\("control_tox_file_transfer", \{\s*profileId: transferProfileId,/,
  "desktop transfer controls capture the exact active profile before the async command");
assert.match(rustSource, /fn control_tox_file_transfer\(\s*app_state: tauri::State<'_, AppState>,\s*profile_id: String,[^]*?let tox_state = app_state\.loaded_profile\(&profile_id\)\?;/,
  "the native transfer control resolves the exact requested loaded profile");
assert.match(appSource, /function retryAttachmentTransfer[^]*?const transferProfileId = activeProfileId;[^]*?invoke\("retry_tox_file_transfer", \{\s*profileId: transferProfileId,/,
  "desktop transfer retries capture the exact active profile before the async command");
assert.match(rustSource, /fn retry_tox_file_transfer\(\s*app_state: tauri::State<'_, AppState>,\s*profile_id: String,[^]*?let tox_state = app_state\.loaded_profile\(&profile_id\)\?;/,
  "the native transfer retry resolves the exact requested loaded profile");
const incomingPumpStart = webSessionSource.slice(
  webSessionSource.indexOf("async startIncomingTransfer"),
  webSessionSource.indexOf("async recoverIncomingTransfer"),
);
assert.doesNotMatch(incomingPumpStart, /control_tox_file_transfer|action:\s*"pause"/u,
  "a transient Web browser-pump failure must not pause or cancel the peer transfer");
const localSnapshot = appSource.match(/localStateSnapshotRef\.current = \{([^]*?)\n  \};/u)?.[1] ?? "";
assert.doesNotMatch(localSnapshot, /userStatus|profileAvatar|profileName/,
  "ordinary autosave cannot overwrite identity fields owned by dedicated profile commands");
assert.match(appSource, /useState<TorStatus>\(\(\) => initialTorStatus\(\)\)/,
  "profile remount initializes Tor from the retained global runtime snapshot");
assert.match(appSource, /retainTorStatus\(status\)/,
  "real Tor polling refreshes the retained global snapshot");
assert.match(appSource, /useState<ProxySettings>\(\(\) => initialProxySettings\(\)\)[^]*retainProxySettings\(settings\)/,
  "only the non-secret global proxy mode stays stable across profile remounts");
assert.match(settingsSource, /useState<ProxySettings>\(\(\) => initialProxySettings\(\)\)[^]*useState<TorStatus>\(\(\) => initialTorStatus\(\)\)[^]*retainTorStatus\(status\)/,
  "the Tor settings screen shares the retained global transport snapshot");
assert.match(appSource, /<button type="button" className=\{`tor-indicator[\s\S]*?onClick=\{\(\) => openSettings\("tor"\)\}/,
  "the applied Tor control opens its real settings screen");

console.log("UI file admission, Tor retention, and indicator interaction regressions passed");
