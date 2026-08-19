import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const layoutUrl = new URL("../src/appLayout.ts", import.meta.url);
const layout = await importTypeScriptModule(layoutUrl);

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

const [appSource, settingsSource, cssSource] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/App.css", import.meta.url), "utf8"),
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
assert.match(appSource, /setContactContext\(null\);\s*\}, \[activeChat, addContactOpen, incomingRequestsOpen, screen\]\);/);
assert.match(appSource, /className="rail"[^>]*onClick=\{\(event\) => \{ event\.stopPropagation\(\); setContactContext\(null\);/);
assert.doesNotMatch(appSource, /hideContacts|hideRail|contacts-hidden|rail-hidden/);
assert.doesNotMatch(cssSource, /contacts-hidden|rail-hidden|contacts-compact/);
assert.match(appSource, /className=\{`chat-list \$\{compactSidebar \? "compact" : ""\}`\}/);
assert.match(settingsSource, /settings-view \$\{compact \? "compact" : ""\}/);
assert.match(settingsSource, /className="settings-tab-label"/);
assert.match(settingsSource, /title=\{t\(label\)\} aria-label=\{t\(label\)\}/);
assert.match(settingsSource, /aria-label=\{t\("Разделы настроек"\)\}/);
assert.match(cssSource, /\.settings-view\.compact\s*\{\s*grid-template-columns:\s*86px minmax\(0, 1fr\)/);
assert.match(cssSource, /\.settings-tabs > button > \.settings-tab-label\s*\{[^}]*width:\s*auto;[^}]*color:\s*inherit/);
assert.match(cssSource, /\.app-shell\.sidebar-compact \.profile-switcher\s*\{[^}]*margin-inline:\s*4px/);
assert.match(cssSource, /\.app-shell\.sidebar-compact \.profile-sidebar-header:not\(\.has-profile-switcher\)\s*\{\s*display:\s*none/);

console.log("app layout and anchored context menu regressions passed");
