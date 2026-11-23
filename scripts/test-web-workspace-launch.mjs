import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importStandaloneTypeScript } from "./import-standalone-typescript.mjs";

const cases = ["blank-installed-first", "blank-event-first", "blank-mode-first", "confirmed-transfer", "ordinary-window", "tombstoned-launch"];
const selected = process.argv[2];
if (!selected) {
  for (const name of cases) {
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], { stdio: "inherit" });
  }
  console.log(`PASS workspace launch: ${cases.length} installation/identity scenarios`);
} else {
  assert.ok(cases.includes(selected), "Unknown workspace launch scenario");
  const storage = new Map();
  const events = new Map();
  const media = new Map();
  const location = new URL("https://kaigen.invalid/");
  const history = { state: null, replaceState(state, _title, href) { this.state = state; location.href = new URL(href, location).href; } };
  let standalone = selected === "blank-installed-first" || selected === "tombstoned-launch";
  const launchToken = "0123456789abcdef0123456789abcdef";
  const identifier = "B".repeat(48);
  const key = token => `kaigen.web.launch.token.v1.${token}`;
  if (standalone) location.search = `kaigen-launch=${launchToken}`;
  if (selected === "tombstoned-launch") {
    storage.set(key(launchToken), JSON.stringify({ v: 1, identifier: null }));
    location.hash = `k=${identifier}`;
  }
  const manifest = { isConnected: false, rel: "", href: "" };
  globalThis.window = {
    location, history, crypto: webcrypto,
    localStorage: {
      getItem: name => storage.get(name) ?? null,
      setItem: (name, value) => storage.set(name, value),
    },
    matchMedia(query) {
      if (!media.has(query)) media.set(query, {
        get matches() { return query === "(display-mode: standalone)" && standalone; },
        addEventListener(type, callback) {
          const name = `${query}:${type}`;
          if (!events.has(name)) events.set(name, []);
          events.get(name).push(callback);
        },
      });
      return media.get(query);
    },
    addEventListener(type, callback) {
      if (!events.has(type)) events.set(type, []);
      events.get(type).push(callback);
    },
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    userAgent: "Mozilla/5.0 Chrome/157.0", vendor: "Google Inc.", platform: "Linux x86_64", maxTouchPoints: 0,
  } });
  globalThis.document = {
    querySelector: () => manifest.isConnected ? manifest : null,
    createElement: () => manifest,
    head: { append: element => { element.isConnected = true; } },
  };
  const moduleUrl = process.env.KAIGEN_TEST_WORKSPACE_LAUNCH_SOURCE
    ? pathToFileURL(process.env.KAIGEN_TEST_WORKSPACE_LAUNCH_SOURCE)
    : new URL("../src/web/workspaceLaunch.ts", import.meta.url);
  const launch = await importStandaloneTypeScript(moduleUrl);
  const fire = name => { for (const callback of events.get(name) ?? []) callback(); };
  launch.initializeWebLaunch();
  if (selected === "tombstoned-launch") {
    assert.equal(location.hash, "", "Cold launch cannot revive a destroyed workspace seed");
    fire("appinstalled");
    assert.deepEqual(JSON.parse(storage.get(key(launchToken))), { v: 1, identifier: null });
  } else if (selected === "ordinary-window") {
    fire("appinstalled");
    assert.equal(history.state.kaigenWebInstallation, undefined, "Ordinary browser does not acquire an installed slot");
    assert.equal(launch.rememberWorkspaceLaunch(identifier), true);
    assert.equal(storage.has("kaigen.web.launch.bound.v1"), false);
    assert.equal([...storage.values()].filter(value => JSON.parse(value).identifier === identifier).length, 1);
  } else {
    const token = selected === "blank-installed-first" ? launchToken
      : new URL(manifest.href).pathname.split("/").at(-1);
    assert.match(token, /^[a-f0-9]{32}$/u);
    if (selected === "confirmed-transfer") {
      assert.equal(launch.rememberWorkspaceLaunch(identifier), true);
    }
    if (selected === "blank-event-first") {
      fire("appinstalled");
      standalone = true;
      fire("(display-mode: standalone):change");
    } else if (selected !== "blank-installed-first") {
      standalone = true;
      if (selected === "blank-mode-first") fire("(display-mode: standalone):change");
      fire("appinstalled");
    }
    if (selected !== "confirmed-transfer") {
      assert.equal(storage.has(key(token)), false, "Blank install must not write a null binding");
    }
    assert.equal(launch.rememberWorkspaceLaunch(identifier), true, "Authenticated creation persists the installed app's own selector");
    assert.deepEqual(history.state.kaigenWebInstallation, { v: 1, token });
    assert.deepEqual(JSON.parse(storage.get(key(token))), { v: 1, identifier });
    assert.equal(storage.has("kaigen.web.launch.bound.v1"), false, "Chromium slots stay independent of the shared WebKit slot");
    fire("appinstalled");
    fire("(display-mode: standalone):change");
    assert.deepEqual(JSON.parse(storage.get(key(token))), { v: 1, identifier }, "Repeated install events preserve the binding");
  }
  console.log(`PASS ${selected}`);
}
