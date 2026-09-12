import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const layoutUrl = new URL("../src/appLayout.ts", import.meta.url);
const layout = await importTypeScriptModule(layoutUrl);
const interfaceScale = await importTypeScriptModule(new URL("../src/interfaceScale.ts", import.meta.url));

const resolve = (screen, viewportWidth, requestedSidebarWidth = 360, interfaceScale = 100) => layout.resolveAppLayout({
  screen,
  viewportWidth,
  requestedSidebarWidth,
  interfaceScale,
});

const chatWide = resolve("chat", 1180);
assert.equal(chatWide.compactSidebar, false);
assert.equal(chatWide.sidebarWidth, 310);
assert.equal(chatWide.contentWidth, 760);

const chatBoundary = resolve("chat", 1050);
assert.equal(chatBoundary.compactSidebar, false);
assert.equal(chatBoundary.sidebarWidth, 180);
assert.equal(chatBoundary.contentWidth, 760);

const chatCompact = resolve("chat", 1049);
assert.equal(chatCompact.compactSidebar, true);
assert.equal(chatCompact.sidebarWidth, 86);
assert.equal(chatCompact.contentWidth, 853);
assert.equal(chatCompact.listEdge, 196);
assert.equal(chatCompact.gridTemplateColumns, "110px 86px minmax(0, 1fr)");

for (const width of [870, 869, 860]) {
  const current = resolve("chat", width);
  assert.equal(current.compactSidebar, true, `chat sidebar stays compact at ${width}px`);
  assert.equal(current.sidebarWidth, 86, `chat sidebar stays visible at ${width}px`);
  assert.equal(current.contentWidth, width - 196, `only chat content shrinks at ${width}px`);
}

const scaledMinimum = resolve("chat", 860, 360, 150);
assert.equal(scaledMinimum.compactSidebar, true);
assert.equal(scaledMinimum.sidebarWidth, 86);
assert.ok(Math.abs(scaledMinimum.contentWidth - (860 / 1.5 - 196)) < 1e-9);

for (const scale of [80, 90]) {
  const style = interfaceScale.appShellScaleStyle(scale, true);
  assert.equal(style.transform, `scale(${scale / 100})`, `Web ${scale}% uses layout-safe transform scaling`);
  assert.equal(style.transformOrigin, "top left");
  assert.equal(style.zoom, undefined, `Web ${scale}% never combines CSS zoom with percentage height`);
  assert.equal(style.width, `${100 / (scale / 100)}%`);
  assert.equal(style.height, `${100 / (scale / 100)}%`);
}
assert.deepEqual(interfaceScale.appShellScaleStyle(90, false), {
  width: `${100 / 0.9}vw`,
  height: `${100 / 0.9}vh`,
  zoom: 0.9,
}, "desktop keeps native WebView zoom behavior");

const settingsWide = resolve("settings", 1180);
assert.equal(settingsWide.compactSidebar, false);
assert.equal(settingsWide.sidebarWidth, 310);
assert.equal(settingsWide.contentWidth, 760);

const settingsBoundary = resolve("settings", 1050);
assert.equal(settingsBoundary.compactSidebar, false);
assert.equal(settingsBoundary.sidebarWidth, 180);
assert.equal(settingsBoundary.contentWidth, 760);

const settingsCompact = resolve("settings", 1049);
assert.equal(settingsCompact.compactSidebar, true);
assert.equal(settingsCompact.sidebarWidth, 86);
assert.equal(settingsCompact.contentWidth, 853);
assert.deepEqual(settingsCompact, chatCompact, "screen changes preserve one compact sidebar geometry");

const settingsManualCompact = resolve("settings", 1180, 74);
assert.equal(settingsManualCompact.compactSidebar, true);
assert.equal(settingsManualCompact.sidebarWidth, 86);
assert.equal(settingsManualCompact.contentWidth, 984);

const [appSource, settingsSource, composerSource, cssSource, richEditorCss, i18nSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/SpellcheckComposer.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
  readFile(new URL("../src/ChatEnhancements.css", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n.tsx", import.meta.url), "utf8"),
]);

for (const registration of [
  'document.addEventListener("pointerdown", closeOutside, true)',
  'document.addEventListener("focusin", closeOutside, true)',
  'document.addEventListener("scroll", closeOutside, true)',
  'document.addEventListener("keydown", closeOnEscape, true)',
  'window.addEventListener("blur", close)',
  'window.addEventListener("resize", close)',
]) {
  assert.ok(appSource.includes(registration), `contact context menu registers ${registration}`);
  assert.ok(appSource.includes(registration.replace("addEventListener", "removeEventListener")), `contact context menu cleans up ${registration}`);
}
assert.match(appSource, /contactContextMenuRef\.current\?\.contains\(target\)/);
assert.match(appSource, /setContactContext\(null\);\s*setGeneralContext\(null\);\s*\}, \[activeChat, addContactOpen, incomingRequestsOpen, screen\]\);/, "navigation closes both mutually exclusive custom context menus");
assert.match(appSource, /className="rail"[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); setContactContext\(null\);/);
assert.doesNotMatch(appSource, /hideContacts|hideRail|contacts-hidden|rail-hidden/);
assert.doesNotMatch(cssSource, /contacts-hidden|rail-hidden|contacts-compact/);
assert.match(appSource, /className=\{`chat-list \$\{compactSidebar \? "compact" : ""\}`\}/);
assert.match(appSource, /function exitApplication\(\) \{\s*setProfileMenuOpen\(false\);\s*void persistLocalState\(true\)\s*\.then\(\(\) => invoke\("exit_application"\)\)\s*\.catch/);
const profileMenu = appSource.match(/profileMenuOpen && <div className="rail-profile-menu"[^]*?<\/div>/u)?.[0] ?? "";
assert.match(profileMenu, /t\("Добавить профиль"\)[^]*t\("Настройки"\)[^]*t\("Выход"\)/u);
assert.doesNotMatch(profileMenu, /Отключить профиль|Уничтожить профиль|Закрыть приложение/u);
assert.match(appSource, /className="rail-button group-chat-button"[^>]*\bdisabled/u);
assert.equal((appSource.match(/onClick=\{openAddContact\}/gu) ?? []).length, 2,
  "the rail and contact-heading plus buttons must share the exact add-contact action");
assert.match(appSource, /className="contact-list-add"[^>]*title=\{t\("Добавить в контакты"\)\} aria-label=\{t\("Добавить в контакты"\)\}/u,
  "the contact-heading plus has a localized accessible name");
assert.match(i18nSource, /"Добавить в контакты":\s*"Add contact"/u,
  "the contact-heading plus accessible name is available in RU and EN");
assert.match(cssSource, /\.contact-list-title\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*gap:\s*3px;/u,
  "the contact-heading plus stays aligned and adjacent to its label");
assert.match(cssSource, /\.contact-list-add svg\s*\{[^}]*width:\s*\.88em;[^}]*height:\s*\.88em;/u,
  "the visible contact-heading plus stays comparable to lowercase text");
assert.match(settingsSource, /settings-view \$\{compact \? "compact" : ""\}/);
assert.match(settingsSource, /className="settings-tab-label"/);
assert.match(settingsSource, /title=\{t\(label\)\} aria-label=\{t\(label\)\}/);
assert.match(settingsSource, /aria-label=\{t\("Разделы настроек"\)\}/);
assert.match(cssSource, /\.settings-view\.compact\s*\{\s*grid-template-columns:\s*86px minmax\(0, 1fr\)/);
assert.match(cssSource, /\.settings-tabs > button > \.settings-tab-label\s*\{[^}]*width:\s*auto;[^}]*color:\s*inherit/);
assert.match(cssSource, /\.app-shell\.sidebar-compact \.profile-switcher\s*\{[^}]*margin-inline:\s*4px/);
assert.match(cssSource, /\.app-shell\.sidebar-compact \.profile-sidebar-header:not\(\.has-profile-switcher\)\s*\{\s*display:\s*none/);

const presenceDotDefinition = appSource.match(/function PresenceDot\([\s\S]*?\n\}/)?.[0] ?? "";
assert.match(presenceDotDefinition, /status:\s*UserStatus/, "presence dots accept the complete user-status boundary");
assert.match(presenceDotDefinition, /if \(status === "offline"\) return null;/, "offline never renders a presence dot");
assert.match(presenceDotDefinition, /return <span className=\{`status-dot \$\{status\}/, "online, away, and busy share one positive dot renderer");
assert.match(appSource, /data-kaigen-ui-entity-key=\{opaqueUiEntityKey\("contact", chat\.publicKey \?\? chat\.id\)\}/, "each repeated contact publishes only an opaque stable model key");
assert.match(appSource, /<PresenceDot status=\{chat\.status\} className="contact-status-dot" \/>/);
assert.doesNotMatch(presenceDotDefinition, /elementId|data-kaigen-element-id/, "a repeated presence dot is identified only through its declared contact family");
assert.doesNotMatch(appSource, /chat\.status !== "offline"/, "contact rendering cannot bypass the shared offline rule");
assert.equal((appSource.match(/<span className=\{?`?status-dot/g) ?? []).length, 1, "only PresenceDot may render the raw status-dot span");

assert.match(appSource, /<div className="rail-footer">[\s\S]*?<button type="button" className=\{`tor-indicator[\s\S]*?onClick=\{\(\) => openSettings\("tor"\)\}[\s\S]*?<div className="theme-switch"/);
assert.match(cssSource, /\.rail-footer\s*\{[^}]*flex:\s*0 0 auto;[^}]*flex-direction:\s*column;[^}]*align-items:\s*center;/);
assert.doesNotMatch(appSource, /platformCapabilities[^\n]*(?:theme-switch|rail-footer)|(?:theme-switch|rail-footer)[^\n]*platformCapabilities/, "theme switch visibility is not platform-gated");
assert.doesNotMatch(cssSource, /(?:theme-switch|rail-footer)[^{]*\{[^}]*display:\s*none/, "theme switch and its footer are never hidden by CSS");
assert.match(appSource, /platformCapabilities\.outgoingTransferRetry && message\.mine && message\.attachment\.transferState === "failed"/, "failed outgoing transfer retry uses its exact capability");
assert.doesNotMatch(appSource, /outgoingMessageEditing/, "transfer retry is not mislabeled as generic message editing");

assert.match(appSource, /placeholder=\{t\("Поиск"\)\} aria-label=\{t\("Фильтр контакт-листа"\)\}/, "visible search prompt and accessible filter name stay distinct and localized");
assert.doesNotMatch(appSource, /placeholder=\{?"Фильтр контакт-листа"/, "the internal filter label must not leak into the visible placeholder");

assert.match(cssSource, /\.conversation\s*\{[^}]*grid-template-rows:\s*68px minmax\(0, 1fr\) auto;/su,
  "the chat header stays in a fixed grid row while the composer grows");
assert.match(cssSource, /\.composer\s*\{\s*height:\s*auto;\s*min-height:\s*68\.1px;/u,
  "the composer contributes its actual multiline height to the bottom grid row");
assert.doesNotMatch(cssSource, /\.composer\s*\{[^}]*(?<!-)height:\s*68\.1px;/su,
  "the composer must not hold a fixed height that lets its textarea overflow below the viewport");
assert.match(cssSource, /\.compose-row\s*\{[^}]*align-items:\s*end;/su,
  "composer controls remain bottom-anchored so multiline growth moves its top edge upward");
assert.match(richEditorCss, /\.rich-composer-editor\s*\{[^}]*padding:\s*15px 22px 13px;/su,
  "the single-line message placeholder is optically centered without changing the field height");
assert.match(richEditorCss, /\.rich-composer-editor\s*\{[^}]*max-height:\s*154px;[^}]*overflow-y:\s*auto;/su,
  "the native rich editor grows with its text up to the bounded multiline cap");
assert.doesNotMatch(composerSource, /target\.scrollHeight|spellcheck-overlay/u,
  "input and selection do not force a height measurement or mirror editable text");

console.log("app layout and anchored context menu regressions passed");
