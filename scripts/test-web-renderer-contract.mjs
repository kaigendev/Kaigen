import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { requireWebBuildId } from "./web-build-id.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [vite, main, webRoot, webCss, session, identity, types, desktop, web, settings, installer] = await Promise.all([
  read("vite.config.ts"), read("src/main.tsx"), read("src/web/WebRoot.tsx"), read("src/web/WebRoot.css"),
  read("src/web/session.ts"), read("src/web/buildIdentity.ts"), read("src/platform/types.ts"),
  read("src/platform/desktop.ts"), read("src/platform/web.ts"), read("src/Settings.tsx"),
  read("web/installer/install-kaigen-web.sh"),
]);

assert.equal(requireWebBuildId("kaigen-web-20260902-contract"), "kaigen-web-20260902-contract");
for (const invalid of [undefined, "short", " leading-build-id", "trailing-build-id ", "bad/build-identity", "bad'build-identity"]) {
  assert.throws(() => requireWebBuildId(invalid), /KAIGEN_WEB_BUILD_ID/u);
}

assert.match(main, /import ProductRoot from "@kaigen\/root"/u);
assert.match(vite, /"@kaigen\/root"[^]*WebRoot\.tsx[^]*RootApp\.tsx/u);
assert.match(webRoot, /import RootApp from "\.\.\/RootApp"/u);
assert.doesNotMatch(webRoot, /(?:\.\.\/|\.\/)App(?:\.tsx)?["']/u);
assert.equal([...webRoot.matchAll(/<RootApp\s*\/>/gu)].length, 1);
assert.match(webRoot, /await webSession\.verifyBuildIdentity\(\)[^]*setStage\("ready"\)/u);
assert.match(webRoot, /stage === "upgrade"[^]*location\.reload\(\)[^]*if \(smallViewport\)/u);

const forbiddenCss = (source) => [
  ...[".app-shell", ".messenger-root", ".profile-event-notices", "!important"]
    .filter((marker) => source.includes(marker)),
  ...(/^\s*(?:button|input)\b/mu.test(source) ? ["global-control-selector"] : []),
];
assert.deepEqual(forbiddenCss(webCss), []);
assert.deepEqual(forbiddenCss(".web-app-surface .app-shell { width: 100% !important; }"), [".app-shell", "!important"]);
assert.deepEqual(forbiddenCss("button, input { font: inherit; }"), ["global-control-selector"]);

for (const capability of ["nativeFilesystem", "systemTray", "browserAuthorization", "containerRelativeLayout", "outgoingTransferRetry", "proxyConnectivityTest"]) {
  assert.match(types, new RegExp(`${capability}: boolean`, "u"));
  assert.match(desktop, new RegExp(`${capability}: (?:true|false)`, "u"));
  assert.match(web, new RegExp(`${capability}: (?:true|false)`, "u"));
}
assert.doesNotMatch(`${types}\n${desktop}\n${web}\n${settings}`, /platformCapabilities\.product|product: "(?:web|desktop)"/u);
assert.match(settings, /platformCapabilities\.proxyConnectivityTest/u);

assert.match(vite, /requireWebBuildId\(buildEnvironment\.KAIGEN_WEB_BUILD_ID\)/u);
assert.match(vite, /fileName: "kaigen-build-id"/u);
assert.match(identity, /__KAIGEN_WEB_BUILD_ID__/u);
assert.match(session, /headers\.set\(WEB_BUILD_HEADER, WEB_BUILD_ID\)/u);
assert.match(session, /"\/api\/v1\/build-identity"/u);
assert.match(session, /response\.status === 426[^]*this\.requireUpgrade\(\)/u);
assert.match(session, /if \(this\.upgradeRequired\) throw new Error\("UPGRADE_REQUIRED"\)/u);
assert.match(session, /this\.fetchResponse\("\/api\/v1\/workspaces\/import\/upload"/u);
assert.match(session, /body\?\.code === "UPGRADE_REQUIRED"[^]*this\.requireUpgrade\(\)[^]*throw new Error\("UPGRADE_REQUIRED"\)/u);
assert.equal([...session.matchAll(/\bfetch\(/gu)].length, 1, "all Web requests must share the terminal upgrade gate");
assert.match(session, /ws\/v1\?build=\$\{encodeURIComponent\(WEB_BUILD_ID\)\}/u);
assert.match(session, /const scheduleReconnect = \(\) => \{[^]*!this\.upgradeRequired && this\.realtimeActive[^]*\.then\(scheduleReconnect, scheduleReconnect\)/u);
assert.doesNotMatch(session, /WEB_BUILD_PROTOCOL|kaigen\.build\./u);
assert.match(installer, /ui_build_id[^]*== "\$RELEASE_ID"/u);
assert.match(installer, /add_header Cache-Control "no-store" always/u);
assert.match(installer, /location = \/api\/v1\/build-identity/u);
assert.match(installer, /http_x_kaigen_client_build != \\\$kaigen_web_build_id[^]*UPGRADE_REQUIRED/u);
assert.match(installer, /arg_build != \\\$kaigen_web_build_id[^]*UPGRADE_REQUIRED/u);

const sourceNames = (await readdir(new URL("src/", root), { recursive: true }))
  .filter((name) => /\.(?:ts|tsx)$/u.test(name));
const sourceText = (await Promise.all(sourceNames.map((name) => read(`src/${name.replaceAll("\\", "/")}`)))).join("\n");
assert.doesNotMatch(sourceText, /platformCapabilities\.product/u);

console.log("Web renderer/build identity contract passed.");
