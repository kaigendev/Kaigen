import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "chat-geometry-runtime");

function browserPath() {
  const names = process.platform === "win32"
    ? ["chrome.exe", "msedge.exe"]
    : process.platform === "darwin"
      ? ["Google Chrome", "Microsoft Edge", "Chromium"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  const pathCandidates = (process.env.PATH ?? "").split(path.delimiter)
    .flatMap((directory) => names.map((name) => path.join(directory, name)));
  const fixed = process.platform === "win32"
    ? [
        path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
        path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
      ]
    : process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : names.map((name) => `/usr/bin/${name}`);
  const requested = process.env.KAIGEN_UI_TEST_BROWSER;
  const candidates = requested ? [path.resolve(requested)] : [...fixed, ...pathCandidates];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("CHAT_GEOMETRY_BROWSER_MISSING: set KAIGEN_UI_TEST_BROWSER to an existing Chrome/Edge/Chromium executable");
  return found;
}

async function waitFor(read, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read().catch(() => undefined);
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out`);
}

function within(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function connectCdp(url, timeoutMs = 2_000) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("Chrome DevTools connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    }, { once: true });
  });
  let sequence = 0;
  let intentionalClose = false;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(String(data));
    const request = pending.get(response.id);
    if (!request) return;
    pending.delete(response.id);
    clearTimeout(request.timer);
    if (response.error) request.reject(new Error(response.error.message));
    else request.resolve(response.result);
  });
  socket.addEventListener("close", () => {
    if (intentionalClose) {
      for (const request of pending.values()) clearTimeout(request.timer);
      pending.clear();
      return;
    }
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Chrome DevTools connection closed during ${request.method}`));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    shutdown() {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close", params: {} }));
      }
    },
    send(method, params = {}, timeoutMs = 2_000) {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
      response.catch(() => {});
      return response;
    },
  };
}

const appSource = await readFile(path.join(repository, "src", "App.tsx"), "utf8");
assert.equal([...appSource.matchAll(/\bscrollMessageWithinContainer\s*\(/gu)].length, 3,
  "all three search/pending/jump routes must use container-only scrolling");
assert.doesNotMatch(appSource, /\.scrollIntoView\s*\(/u,
  "App must not reintroduce ancestor-scrolling message navigation");

const profile = await mkdtemp(path.join(os.tmpdir(), "kaigen-chat-geometry-"));
const server = await createServer({
  configFile: false,
  root: fixture,
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@kaigen/platform": path.join(fixture, "app-platform.ts"),
      "@kaigen/root": path.join(repository, "src", "RootApp.tsx"),
      "@kaigen/theme": path.join(repository, "src", "theme.tsx"),
    },
  },
  define: {
    __KAIGEN_PRODUCT__: JSON.stringify("desktop"),
    __KAIGEN_WEB_BUILD_ID__: JSON.stringify("chat-geometry-runtime"),
  },
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, strictPort: true, fs: { allow: [repository] } },
});
let browser;
let cdp;
let browserErrors = "";
try {
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const fixtureUrl = `${origin}/`;
  const [fixtureResponse, moduleResponse] = await Promise.all([
    fetch(fixtureUrl, { signal: AbortSignal.timeout(1_000) }),
    fetch(`${origin}/main.ts`, { signal: AbortSignal.timeout(1_000) }),
  ]);
  assert.equal(fixtureResponse.status, 200, "geometry fixture HTML must be served");
  assert.equal(moduleResponse.status, 200, "geometry fixture module must be transformed");
  const args = [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,720", "about:blank",
  ];
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
  browser = spawn(browserPath(), args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  browser.once("exit", (code, signal) => {
    if (code !== 0) process.stderr.write(`geometry browser exited code=${code} signal=${signal ?? "none"}\n${browserErrors}`);
  });
  browser.stderr?.on("data", (chunk) => {
    if (browserErrors.length < 4_096) browserErrors += String(chunk);
  });
  const activePort = path.join(profile, "DevToolsActivePort");
  const debugPort = await waitFor(async () => {
    const [port] = (await readFile(activePort, "utf8")).trim().split(/\r?\n/u);
    const parsed = Number(port);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  }, 4_000, "Chrome DevTools endpoint");
  const page = await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, {
    method: "PUT",
    signal: AbortSignal.timeout(1_000),
  }).then((response) => {
    assert.equal(response.status, 200, "Chrome must create the geometry fixture target");
    return response.json();
  });
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const version = await cdp.send("Browser.getVersion");
  const baseline = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  assert.equal(baseline.result?.value, 2, "Chrome fixture target must evaluate JavaScript");
  const navigation = await cdp.send("Page.navigate", { url: fixtureUrl });
  assert.equal(navigation.errorText, undefined, `fixture navigation failed: ${navigation.errorText}`);
  let result;
  try {
    result = await waitFor(async () => {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: "globalThis.__KAIGEN_CHAT_GEOMETRY_RESULT__",
        returnByValue: true,
      }, 500);
      if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? "fixture evaluation failed");
      return evaluated.result?.value;
    }, 7_000, "chat geometry fixture");
  } catch (error) {
    const diagnostic = await cdp.send("Runtime.evaluate", {
      expression: `({ readyState: document.readyState, url: location.href,
        title: document.title, html: document.documentElement.outerHTML.slice(0, 500),
        phase: globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__,
        body: document.body.innerText.slice(0, 200), scripts: [...document.scripts].map((item) => item.src || "inline") })`,
      returnByValue: true,
    });
    throw new Error(`${error.message}; diagnostic=${JSON.stringify(diagnostic.result?.value)}`);
  }
  assert.equal(result?.ok, true, result?.error ?? "chat geometry fixture failed");
  assert.equal(result.assertions, 14, "update the declared real-DOM assertion count when the contract changes");

  const appNavigation = await cdp.send("Page.navigate", { url: `${origin}/app.html` });
  assert.equal(appNavigation.errorText, undefined, `actual App fixture navigation failed: ${appNavigation.errorText}`);
  await cdp.send("Page.bringToFront");
  await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", { expression: "document.readyState === 'complete'", returnByValue: true }, 500);
    return evaluated.result?.value ? true : undefined;
  }, 2_000, "actual App document load");
  const actualApp = await cdp.send("Runtime.evaluate", {
    expression: `import('/app-scenario.ts').then((module) => module.runActualAppGeometryScenario())`,
    awaitPromise: true,
    returnByValue: true,
  }, 12_000);
  if (actualApp.exceptionDetails) throw new Error(actualApp.exceptionDetails.exception?.description ?? "actual App scenario evaluation failed");
  const actualResult = actualApp.result?.value;
  assert.equal(actualResult?.ok, true, actualResult?.error ?? "actual App geometry scenario failed");
  assert.equal(actualResult.assertions, 5, "update the actual App geometry assertion count when its contract changes");

  const richUiPromise = cdp.send("Runtime.evaluate", {
    expression: `import('/app-rich-scenario.ts').then((module) => module.runActualAppRichScenario())`,
    awaitPromise: true,
    returnByValue: true,
  }, 20_000);
  const macControlClick = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `({
        stage: globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__,
        result: globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__,
      })`,
      returnByValue: true,
    }, 500);
    const state = evaluated.result?.value;
    if (state?.result?.ok === false) return { error: state.result.error ?? "actual App rich UI scenario failed before trusted Mac input" };
    return state?.stage?.phase === "ready" ? state.stage : undefined;
  }, 12_000, "trusted macOS control-click stage");
  if (macControlClick.error) throw new Error(macControlClick.error);
  assert.equal(macControlClick.direction, "backward", "the emulated Mac fixture must begin with a directional nonempty selection");
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: macControlClick.x,
    y: macControlClick.y,
    button: "left",
    buttons: 1,
    modifiers: 2,
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: macControlClick.x,
    y: macControlClick.y,
    button: "left",
    buttons: 0,
    modifiers: 2,
    clickCount: 1,
  });
  const trustedMacResult = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const stage = globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__;
      const textarea = document.querySelector(".composer textarea");
      const result = {
        trustedPress: stage?.trustedPress,
        trustedRelease: stage?.trustedRelease,
        menuCount: document.querySelectorAll(".text-edit-context-menu").length,
        formattingGroupCount: document.querySelectorAll(".text-edit-formatting-group").length,
        checkedFormattingCount: document.querySelectorAll('[data-kaigen-format-kind][aria-checked="true"]').length,
        value: textarea?.value,
        start: textarea?.selectionStart,
        end: textarea?.selectionEnd,
        direction: textarea?.selectionDirection,
      };
      if (stage) stage.phase = "complete";
      return result;
    })()`,
    returnByValue: true,
  });
  const trustedMac = trustedMacResult.result?.value;
  assert.equal(trustedMac?.trustedPress, true, "CDP must deliver a trusted Control+primary press to the emulated Mac path");
  assert.equal(trustedMac?.trustedRelease, true, "CDP must deliver a trusted Control+primary release to the emulated Mac path");
  assert.equal(trustedMac?.menuCount, 1, "trusted Control+primary input must open one shared text-edit menu");
  assert.equal(trustedMac?.formattingGroupCount, 1, "trusted Control+primary input must expose one formatting group");
  assert.equal(trustedMac?.checkedFormattingCount, 0, "trusted Control+primary release must not activate formatting before an explicit menu click");
  assert.equal(trustedMac?.value, macControlClick.value, "trusted Control+primary input must not mutate the draft");
  assert.equal(trustedMac?.start, macControlClick.start, "trusted Control+primary input must preserve the selection start");
  assert.equal(trustedMac?.end, macControlClick.end, "trusted Control+primary input must preserve the selection end");
  assert.equal(trustedMac?.direction, macControlClick.direction, "trusted Control+primary input must preserve the selection direction");
  const richUi = await richUiPromise;
  if (richUi.exceptionDetails) throw new Error(richUi.exceptionDetails.exception?.description ?? "actual App rich UI scenario evaluation failed");
  const richResult = richUi.result?.value;
  assert.equal(richResult?.ok, true, richResult?.error ?? "actual App rich UI scenario failed");
  assert.equal(richResult.assertions, 76, "update the actual App rich UI assertion count when its contract changes");

  console.log(`chat geometry runtime: ${result.assertions + actualResult.assertions + richResult.assertions + 10} assertions passed (${version.product}; outer=${actualResult.details.outer}; search=${actualResult.details.searchRange}; queued=${actualResult.details.queuedRange}; formatting=${richResult.details.formattingKinds}; mac=trusted-cdp-emulation)`);
} finally {
  if (cdp) {
    cdp.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    cdp.close();
  }
  browser?.kill();
  await within(server.close(), 2_000, "Vite shutdown").catch(() => {});
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
