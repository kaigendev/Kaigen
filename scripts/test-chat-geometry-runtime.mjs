import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "chat-geometry-runtime");
const evidenceDirectory = process.env.KAIGEN_CHAT_GEOMETRY_EVIDENCE_DIR
  ? path.resolve(process.env.KAIGEN_CHAT_GEOMETRY_EVIDENCE_DIR)
  : null;
const startedAt = Date.now();
let phase = "setup";
function enterPhase(name) {
  phase = name;
  console.log(`chat geometry phase: ${phase} (${Date.now() - startedAt}ms)`);
}

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
  let lastError;
  while (Date.now() < deadline) {
    const result = await read().catch((error) => {
      if (error.geometryFatal) throw error;
      lastError = error;
      return undefined;
    });
    if (result !== undefined) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${label} timed out in ${phase}${lastError ? `; last error: ${lastError.message}` : ""}`, { cause: lastError });
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

async function connectCdp(url, timeoutMs = 5_000) {
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
  const runtimeErrors = [];
  socket.addEventListener("message", ({ data }) => {
    const response = JSON.parse(String(data));
    if (response.method === "Runtime.exceptionThrown") {
      const details = response.params?.exceptionDetails;
      runtimeErrors.push(sanitizeBrowserText(details?.exception?.description ?? details?.text ?? "Browser exception"));
      if (runtimeErrors.length > 6) runtimeErrors.shift();
    }
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
      request.reject(Object.assign(new Error(`Chrome DevTools connection closed during ${request.method}`), { geometryFatal: true }));
    }
    pending.clear();
  });
  return {
    close: () => socket.close(),
    diagnostics: () => ({ runtimeErrors, pending: [...pending.values()].map(({ method }) => method) }),
    shutdown() {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close", params: {} }));
      }
    },
    send(method, params = {}, timeoutMs = 5_000) {
      if (socket.readyState !== WebSocket.OPEN) {
        const response = Promise.reject(Object.assign(new Error(`Chrome DevTools is not open for ${phase}/${method}`), { geometryFatal: true }));
        response.catch(() => {});
        return response;
      }
      const id = ++sequence;
      const timeoutError = new Error(`${phase}/${method} timed out after ${timeoutMs}ms (request ${id})`);
      Error.captureStackTrace(timeoutError, this.send);
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(timeoutError);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
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
let browserClosed;
let browserSpawnError;
let cdp;
let browserErrors = "";
let primaryError;
const sanitizeBrowserText = (value) => [profile, repository, os.homedir(), os.tmpdir()]
  .filter(Boolean)
  .reduce((text, root) => text.replaceAll(root, "<path>").replaceAll(root.replaceAll("\\", "/"), "<path>"), String(value))
  .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gu, "<url>")
  .slice(-4_096);
try {
  enterPhase("fixture-preparation");
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  const fixtureUrl = `${origin}/`;
  // Start the complete static-import crawl before the first HTTP request.
  // Transforming modules does not run their browser scenarios.
  const fixtureModules = process.argv.includes("--links-only")
    ? ["/main.ts", "/app-entry.tsx", "/app-links-scenario.ts"]
    : ["/main.ts", "/app-entry.tsx", "/app-scenario.ts", "/app-rich-scenario.ts", "/app-links-scenario.ts"];
  await within((async () => {
    await Promise.all(fixtureModules.map(async (url) => {
      if (!await server.transformRequest(url)) throw new Error(`Geometry fixture module unavailable: ${url}`);
    }));
    await server.waitForRequestsIdle();
  })(), 60_000, "Geometry fixture module preparation");
  const [fixtureResponse, moduleResponse] = await Promise.all([
    fetch(fixtureUrl, { signal: AbortSignal.timeout(10_000) }),
    fetch(`${origin}/main.ts`, { signal: AbortSignal.timeout(10_000) }),
  ]);
  assert.equal(fixtureResponse.status, 200, "geometry fixture HTML must be served");
  assert.equal(moduleResponse.status, 200, "geometry fixture module must be transformed");
  const args = [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,720", "about:blank",
  ];
  if (process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");
  const selectedBrowser = browserPath();
  enterPhase("browser-startup");
  const startupAt = Date.now();
  browser = spawn(selectedBrowser, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  browserClosed = new Promise((resolve) => browser.once("close", resolve));
  browser.once("error", (error) => { browserSpawnError = error; });
  browser.stderr?.on("data", (chunk) => {
    browserErrors = sanitizeBrowserText(browserErrors + String(chunk));
  });
  const activePort = path.join(profile, "DevToolsActivePort");
  const startupFailure = (message) => new Error(`${message}; browserStartup=${JSON.stringify({
    browser: path.basename(selectedBrowser), elapsedMs: Date.now() - startupAt,
    pid: browser.pid ?? null, exitCode: browser.exitCode, signal: browser.signalCode,
    spawnError: browserSpawnError ? sanitizeBrowserText(browserSpawnError.message) : null,
    activePortExists: existsSync(activePort), stderr: browserErrors,
  })}`);
  let debugPort;
  while (Date.now() - startupAt < 20_000) {
    if (browserSpawnError) throw startupFailure("Chrome browser spawn failed");
    if (browser.exitCode !== null || browser.signalCode !== null) {
      throw startupFailure("Chrome browser exited before DevTools readiness");
    }
    const portText = await readFile(activePort, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw startupFailure(`Chrome DevTools port read failed (${error.code ?? error.name})`);
      return "";
    });
    const [port] = portText.trim().split(/\r?\n/u);
    const parsed = Number(port);
    if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535) {
      debugPort = parsed;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (!debugPort) throw startupFailure("Chrome DevTools endpoint timed out");
  const page = await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, {
    method: "PUT",
    signal: AbortSignal.timeout(5_000),
  }).then((response) => {
    assert.equal(response.status, 200, "Chrome must create the geometry fixture target");
    return response.json();
  });
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Page.bringToFront");
  const waitForDocument = (url, navigation, label) => {
    if (!navigation.frameId || !navigation.loaderId) throw new Error(`${label}: navigation has no document identity`);
    return waitFor(async () => {
      // URL alone can still identify the previous document during a same-URL reload.
      const tree = await cdp.send("Page.getFrameTree", {}, 500);
      const frame = tree.frameTree?.frame;
      if (frame?.id !== navigation.frameId || frame.loaderId !== navigation.loaderId) return undefined;
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: `location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`,
        returnByValue: true,
      }, 500);
      return evaluated.result?.value ? true : undefined;
    }, 30_000, label);
  };
  const prepareScenarioModules = async (urls) => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `Promise.all(${JSON.stringify(urls)}.map((url) => import(url))).then(() => true)`,
      awaitPromise: true, returnByValue: true,
    }, 30_000);
    if (evaluated.exceptionDetails || evaluated.result?.value !== true) {
      throw new Error(evaluated.exceptionDetails?.exception?.description ?? "Geometry scenario module import failed");
    }
  };
  const captureFixtureEvidence = async (name) => {
    if (!evidenceDirectory) return;
    assert.match(name, /^[a-z0-9-]+\.png$/u, "fixture evidence must use a safe PNG leaf name");
    const capture = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, name), Buffer.from(capture.data, "base64"));
  };
  const version = await cdp.send("Browser.getVersion");
  enterPhase("blank-evaluation");
  const baseline = await cdp.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
  assert.equal(baseline.result?.value, 2, "Chrome fixture target must evaluate JavaScript");
  if (!process.argv.includes("--links-only")) {
  enterPhase("fixture-navigation");
  const navigation = await cdp.send("Page.navigate", { url: fixtureUrl });
  assert.equal(navigation.errorText, undefined, `fixture navigation failed: ${navigation.errorText}`);
  await cdp.send("Page.bringToFront");
  await waitForDocument(fixtureUrl, navigation, "geometry fixture document load");
  enterPhase("fixture-result");
  let result;
  try {
    result = await waitFor(async () => {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: "globalThis.__KAIGEN_CHAT_GEOMETRY_RESULT__",
        returnByValue: true,
      }, 500);
      if (evaluated.exceptionDetails) throw Object.assign(new Error(evaluated.exceptionDetails.exception?.description ?? "fixture evaluation failed"), { geometryFatal: true });
      return evaluated.result?.value;
    }, 7_000, "chat geometry fixture");
  } catch (error) {
    const diagnostic = await cdp.send("Runtime.evaluate", {
      expression: `({ readyState: document.readyState, url: location.href,
        title: document.title, html: document.documentElement.outerHTML.slice(0, 500),
        phase: globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__,
        body: document.body.innerText.slice(0, 200), scripts: [...document.scripts].map((item) => item.src || "inline") })`,
      returnByValue: true,
    }).then((reply) => reply.result?.value).catch((diagnosticError) => ({ unavailable: diagnosticError.message }));
    throw new Error(`${error.message}; diagnostic=${sanitizeBrowserText(JSON.stringify(diagnostic))}`, { cause: error });
  }
  assert.equal(result?.ok, true, result?.error ?? "chat geometry fixture failed");
  assert.equal(result.assertions, 14, "update the declared real-DOM assertion count when the contract changes");
  assert.equal(result.fileGeometry?.assertions, 321, "attachment geometry assertion contract");
  assert.equal(result.fileGeometry?.terminalCases, 24, "RU/EN/token errors at two chat widths, font sizes and directions");
  assert.equal(result.fileGeometry?.preservedCases, 48, "all six unaffected file states at each width/font/direction");
  assert.equal(result.fileGeometry?.oldNoWrapOverflow, true, "the old terminal style must reproduce overflow");
  assert.equal(result.fileGeometry?.cases.length, 72, "each file geometry case must produce measured evidence");
  if (evidenceDirectory) {
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(path.join(evidenceDirectory, "attachment-geometry.json"), `${JSON.stringify(result.fileGeometry, null, 2)}\n`);
  }

  enterPhase("actual-app-navigation");
  const appNavigation = await cdp.send("Page.navigate", { url: `${origin}/app.html` });
  assert.equal(appNavigation.errorText, undefined, `actual App fixture navigation failed: ${appNavigation.errorText}`);
  await cdp.send("Page.bringToFront");
  await waitForDocument(`${origin}/app.html`, appNavigation, "actual App document load");
  enterPhase("actual-app-module-imports");
  await prepareScenarioModules(["/app-scenario.ts", "/app-rich-scenario.ts"]);
  enterPhase("actual-app-geometry");
  // Aggregate CDP budgets must allow the unchanged per-action scenario deadlines.
  const actualApp = await cdp.send("Runtime.evaluate", {
    expression: `import('/app-scenario.ts').then((module) => module.runActualAppGeometryScenario())`,
    awaitPromise: true,
    returnByValue: true,
  }, 45_000);
  if (actualApp.exceptionDetails) throw new Error(actualApp.exceptionDetails.exception?.description ?? "actual App scenario evaluation failed");
  const actualResult = actualApp.result?.value;
  assert.equal(actualResult?.ok, true, actualResult?.error ?? "actual App geometry scenario failed");
  assert.equal(actualResult.assertions, 13, "update the actual App geometry assertion count when its contract changes");

  enterPhase("actual-app-unread");
  const unreadUiPromise = cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const frame = document.createElement("iframe");
      frame.id = "kaigen-unread-geometry-frame";
      Object.assign(frame.style, { position: "fixed", inset: "0", width: "1280px", height: "720px", border: "0", zIndex: "2147483647", background: "white" });
      const focusSink = document.createElement("button");
      focusSink.id = "kaigen-unread-parent-focus-sink";
      focusSink.type = "button";
      focusSink.tabIndex = 0;
      focusSink.setAttribute("aria-label", "Unread geometry parent focus sink");
      Object.assign(focusSink.style, { position: "fixed", left: "0", top: "0", width: "8px", height: "8px", padding: "0", border: "0", opacity: "0", zIndex: "2147483647" });
      frame.src = "/app.html";
      document.body.append(frame);
      document.body.append(focusSink);
      return new Promise((resolve, reject) => frame.addEventListener("load", () => {
        frame.contentWindow.eval("import('/app-rich-scenario.ts').then((module) => module.runActualAppUnreadGeometryScenario())").then(resolve, reject);
      }, { once: true }));
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }, 90_000);
  const readUnreadStage = async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const child = document.querySelector("#kaigen-unread-geometry-frame")?.contentWindow; return { stage: child?.__KAIGEN_UNREAD_GEOMETRY_STAGE__, result: child?.__KAIGEN_ACTUAL_APP_UNREAD_RESULT__ }; })()`,
      returnByValue: true,
    }, 500);
    return evaluated.result?.value;
  };
  const waitForUnreadStage = (phase, timeoutMs, label) => waitFor(async () => {
    const state = await readUnreadStage();
    if (state?.result?.ok === false) return { error: state.result.error ?? `iframe unread scenario failed before ${label}` };
    return state?.stage?.phase === phase ? state.stage : undefined;
  }, timeoutMs, label);
  const completeUnreadStage = async (expected, next) => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const stage = document.querySelector("#kaigen-unread-geometry-frame")?.contentWindow?.__KAIGEN_UNREAD_GEOMETRY_STAGE__; if (!stage || stage.phase !== ${JSON.stringify(expected)}) return false; stage.phase = ${JSON.stringify(next)}; return true; })()`,
      returnByValue: true,
    });
    assert.equal(evaluated.result?.value, true, `iframe unread stage moved before ${expected} completed`);
  };
  const resizeUnreadFrame = async (width, height) => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const frame = document.querySelector("#kaigen-unread-geometry-frame"); if (!(frame instanceof HTMLIFrameElement)) return false; frame.style.width = ${JSON.stringify(`${width}px`)}; frame.style.height = ${JSON.stringify(`${height}px`)}; return true; })()`,
      returnByValue: true,
    });
    assert.equal(evaluated.result?.value, true, "the disposable unread App iframe must exist for viewport resize");
    await waitFor(async () => {
      const resized = await cdp.send("Runtime.evaluate", {
        expression: `(() => { const child = document.querySelector("#kaigen-unread-geometry-frame")?.contentWindow; return child?.innerWidth === ${width} && child?.innerHeight === ${height}; })()`,
        returnByValue: true,
      }, 500);
      return resized.result?.value ? true : undefined;
    }, 2_000, `${width}x${height} unread iframe viewport`);
  };

  let unreadAssertionCount = 0;
  try {
    const unfocusRequest = await waitForUnreadStage("request-unfocus", 10_000, "trusted parent focus-transfer stage");
    if (unfocusRequest.error) throw new Error(unfocusRequest.error);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 4, y: 4, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 4, y: 4, button: "left", clickCount: 1 });
    await waitFor(async () => {
      const focused = await cdp.send("Runtime.evaluate", {
        expression: `document.activeElement?.id === "kaigen-unread-parent-focus-sink" && !document.querySelector("#kaigen-unread-geometry-frame")?.contentDocument?.hasFocus()`,
        returnByValue: true,
      }, 500);
      return focused.result?.value ? true : undefined;
    }, 2_000, "trusted parent focus transfer");
    await completeUnreadStage("request-unfocus", "unfocused");
    const shortFit = await waitForUnreadStage("short-fit", 10_000, "short-fit unread geometry stage");
    if (shortFit.error) throw new Error(shortFit.error);
    await captureFixtureEvidence("r9-unread-short-fit.png");
    await completeUnreadStage("short-fit", "short-captured");
    const largeRequest = await waitForUnreadStage("request-large", 6_000, "large unread geometry stage");
    if (largeRequest.error) throw new Error(largeRequest.error);
    await resizeUnreadFrame(largeRequest.width, largeRequest.height);
    await completeUnreadStage("request-large", "large");
    const smallRequest = await waitForUnreadStage("request-small", 6_000, "small unread geometry stage");
    if (smallRequest.error) throw new Error(smallRequest.error);
    await resizeUnreadFrame(smallRequest.width, smallRequest.height);
    await completeUnreadStage("request-small", "small");
    const topScrollRequest = await waitForUnreadStage("request-top-scroll", 6_000, "trusted unread wheel-up stage");
    if (topScrollRequest.error) throw new Error(topScrollRequest.error);
    assert.ok(Number.isFinite(topScrollRequest.x) && Number.isFinite(topScrollRequest.y), "the child unread scroller must expose finite trusted-wheel coordinates");
    const unreadFrameOffset = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const frame = document.querySelector("#kaigen-unread-geometry-frame"); if (!(frame instanceof HTMLIFrameElement)) return null; const rect = frame.getBoundingClientRect(); return { left: rect.left, top: rect.top }; })()`,
      returnByValue: true,
    });
    assert.ok(unreadFrameOffset.result?.value, "the disposable unread App iframe must exist for trusted wheel input");
    const wheelX = unreadFrameOffset.result.value.left + topScrollRequest.x;
    const wheelY = unreadFrameOffset.result.value.top + topScrollRequest.y;
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: wheelX, y: wheelY });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: wheelX, y: wheelY, deltaX: 0, deltaY: -10_000 });
    await waitFor(async () => {
      const scrolled = await cdp.send("Runtime.evaluate", {
        expression: `document.querySelector("#kaigen-unread-geometry-frame")?.contentDocument?.querySelector(".message-scroll")?.scrollTop <= 1`,
        returnByValue: true,
      }, 500);
      return scrolled.result?.value ? true : undefined;
    }, 2_000, "trusted wheel-up top position");
    await completeUnreadStage("request-top-scroll", "top-scrolled");
    const unreadUi = await unreadUiPromise;
    if (unreadUi.exceptionDetails) throw new Error(unreadUi.exceptionDetails.exception?.description ?? "iframe unread scenario evaluation failed");
    const unreadResult = unreadUi.result?.value;
    assert.equal(unreadResult?.ok, true, unreadResult?.error ?? "iframe unread scenario failed");
    assert.equal(unreadResult.assertions, 29, "update the iframe unread geometry assertion count when its contract changes");
    unreadAssertionCount = unreadResult.assertions;
  } finally {
    await cdp.send("Runtime.evaluate", {
      expression: `document.querySelector("#kaigen-unread-geometry-frame")?.remove(); document.querySelector("#kaigen-unread-parent-focus-sink")?.remove()`,
      returnByValue: true,
    }).catch(() => {});
  }

  enterPhase("actual-app-rich-ui");
  const richUiPromise = cdp.send("Runtime.evaluate", {
    expression: `import('/app-rich-scenario.ts').then((module) => module.runActualAppRichScenario())`,
    awaitPromise: true,
    returnByValue: true,
  }, 180_000);
  const readRichStage = async (name) => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `({ stage: globalThis[${JSON.stringify(name)}], result: globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__ })`,
      returnByValue: true,
    }, 500);
    return evaluated.result?.value;
  };
  const waitForRichStage = (name, phase, timeoutMs, label) => waitFor(async () => {
    const state = await readRichStage(name);
    if (state?.result?.ok === false) return { error: state.result.error ?? `actual App rich UI scenario failed before ${label}` };
    return state?.stage?.phase === phase ? state.stage : undefined;
  }, timeoutMs, label);
  const completeRichStage = async (name, expected, next) => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const stage = globalThis[${JSON.stringify(name)}]; if (!stage || stage.phase !== ${JSON.stringify(expected)}) return false; stage.phase = ${JSON.stringify(next)}; return true; })()`,
      returnByValue: true,
    });
    assert.equal(evaluated.result?.value, true, `${name} moved before the owner completed ${expected}`);
  };

  const rightMessage = await waitForRichStage("__KAIGEN_MESSAGE_CONTEXT_STAGE__", "right-ready", 12_000, "trusted message right-click stage");
  if (rightMessage.error) throw new Error(rightMessage.error);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: rightMessage.x, y: rightMessage.y, button: "right", buttons: 2, clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: rightMessage.x, y: rightMessage.y, button: "right", buttons: 0, clickCount: 1,
  });
  await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `document.querySelectorAll(".restricted-context-menu .reaction-palette > button[role=menuitemcheckbox]").length === 6`,
      returnByValue: true,
    }, 500);
    return evaluated.result?.value ? true : undefined;
  }, 1_000, "trusted message reaction palette before evidence capture");
  await captureFixtureEvidence("r9-message-reaction-menu.png");
  await completeRichStage("__KAIGEN_MESSAGE_CONTEXT_STAGE__", "right-ready", "right-complete");

  const macMessage = await waitForRichStage("__KAIGEN_MESSAGE_CONTEXT_STAGE__", "mac-ready", 5_000, "trusted message macOS control-click stage");
  if (macMessage.error) throw new Error(macMessage.error);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: macMessage.x, y: macMessage.y, button: "left", buttons: 1, modifiers: 2, clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: macMessage.x, y: macMessage.y, button: "left", buttons: 0, modifiers: 2, clickCount: 1,
  });
  await completeRichStage("__KAIGEN_MESSAGE_CONTEXT_STAGE__", "mac-ready", "mac-complete");

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
  await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `({ phase: globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__?.phase,
        failure: globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__?.ok === false ? globalThis.__KAIGEN_ACTUAL_APP_RICH_RESULT__.error : null,
        menuReady: !!document.querySelector(".text-edit-context-menu .text-edit-formatting-group") })`,
      returnByValue: true,
    }, 500);
    const state = evaluated.result?.value;
    if (state?.failure || (state && state.phase !== "ready")) {
      throw Object.assign(new Error(state.failure ?? "trusted Mac input stage changed before the menu rendered"), { geometryFatal: true });
    }
    return state?.menuReady ? true : undefined;
  }, 1_000, "trusted macOS formatting menu rendered");
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
  assert.equal(richResult.assertions, 90, "update the actual App rich UI assertion count when its contract changes");

  console.log(`chat geometry runtime: ${result.assertions + result.fileGeometry.assertions + actualResult.assertions + unreadAssertionCount + richResult.assertions + 10} assertions passed (${version.product}; outer=${actualResult.details.outer}; search=${actualResult.details.searchRange}; queued=${actualResult.details.queuedRange}; unread=headless-visible-unfocused-iframe; formatting=${richResult.details.formattingKinds}; mac=trusted-cdp-emulation)`);
  }

  enterPhase("actual-app-links-navigation");
  const linkNavigation = await cdp.send("Page.navigate", { url: `${origin}/app.html` });
  assert.equal(linkNavigation.errorText, undefined, "actual App links navigation must succeed");
  await cdp.send("Page.bringToFront");
  await waitForDocument(`${origin}/app.html`, linkNavigation, "actual App links document load");
  enterPhase("actual-app-links-module-imports");
  await prepareScenarioModules(["/app-links-scenario.ts"]);
  enterPhase("actual-app-links");
  const linksPromise = cdp.send("Runtime.evaluate", {
    expression: "import('/app-links-scenario.ts').then(module => module.runActualAppLinksScenario())", awaitPromise: true, returnByValue: true,
  }, 150_000);
  let handled = 0;
  while (true) {
    const state = await waitFor(async () => {
      const reply = await cdp.send("Runtime.evaluate", { expression: "({ stage: globalThis.__KAIGEN_LINK_STAGE__, result: globalThis.__KAIGEN_LINK_RESULT__ })", returnByValue: true }, 500);
      const value = reply.result?.value;
      return value?.result || value?.stage?.id > handled ? value : undefined;
    }, 8_000, "actual App link gesture or result");
    if (state.result) break;
    const { id, kind, x, y, name } = state.stage;
    handled = id;
    if (kind === "capture") await captureFixtureEvidence(name);
    else if (["enter", "context", "shiftf10"].includes(kind)) {
      const key = kind === "enter" ? "Enter" : kind === "context" ? "ContextMenu" : "F10";
      const windowsVirtualKeyCode = kind === "enter" ? 13 : kind === "context" ? 93 : 121;
      for (const type of ["keyDown", "keyUp"]) await cdp.send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode, modifiers: kind === "shiftf10" ? 8 : 0 });
    } else {
      assert.ok(["right", "mac", "click", "middle"].includes(kind), `unknown link gesture ${kind}`);
      const button = kind === "right" ? "right" : kind === "middle" ? "middle" : "left";
      const buttons = button === "right" ? 2 : button === "middle" ? 4 : 1;
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, buttons, modifiers: kind === "mac" ? 2 : 0, clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, buttons: 0, modifiers: kind === "mac" ? 2 : 0, clickCount: 1 });
    }
    const complete = await cdp.send("Runtime.evaluate", { expression: `(() => { const stage = globalThis.__KAIGEN_LINK_STAGE__; if (stage?.id !== ${id}) return false; stage.done = true; return true; })()`, returnByValue: true });
    assert.equal(complete.result?.value, true, "the owner must complete the same link gesture");
  }
  const linkReply = await linksPromise;
  if (linkReply.exceptionDetails) throw new Error(linkReply.exceptionDetails.exception?.description ?? "actual App links scenario failed");
  const links = linkReply.result?.value;
  assert.equal(links?.ok, true, links?.error ?? "actual App links scenario failed");
  assert.equal(links.cases?.length, 4, "long-link actual geometry covers narrow/wide and 15/28px text");
  assert.equal(links.assertions, 55, "update the actual App link assertion contract when coverage changes");
  if (evidenceDirectory) await writeFile(path.join(evidenceDirectory, "chat-link-geometry.json"), `${JSON.stringify(links, null, 2)}\n`);
  console.log(`chat links actual App: ${links.assertions} assertions passed (${version.product}; geometry=${JSON.stringify(links.cases)}; input=trusted-cdp; clipboard=exact-platform-boundary)`);
} catch (error) {
  primaryError = error;
  const pageState = cdp ? await cdp.send("Runtime.evaluate", {
    expression: `({ readyState: document.readyState, visibility: document.visibilityState, focused: document.hasFocus(),
      geometry: globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__,
      unread: document.querySelector("#kaigen-unread-geometry-frame")?.contentWindow?.__KAIGEN_UNREAD_GEOMETRY_STAGE__?.phase,
      rich: globalThis.__KAIGEN_MESSAGE_CONTEXT_STAGE__?.phase,
      mac: globalThis.__KAIGEN_MAC_CTRL_CLICK_STAGE__?.phase,
      links: globalThis.__KAIGEN_LINK_STAGE__?.kind })`,
    returnByValue: true,
  }, 2_000).then((reply) => reply.result?.value).catch((diagnosticError) => ({ unavailable: diagnosticError.message })) : null;
  process.stderr.write(`CHAT_GEOMETRY_FAILURE ${JSON.stringify({
    phase, elapsedMs: Date.now() - startedAt, exitCode: browser?.exitCode,
    signal: browser?.signalCode, stderr: browserErrors, cdp: cdp?.diagnostics(), pageState,
  })}\n`);
  throw error;
} finally {
  const cleanupErrors = [];
  const cleanup = async (operation) => {
    try { await operation(); } catch (error) { cleanupErrors.push(sanitizeBrowserText(error.message)); }
  };
  await cleanup(async () => {
    if (cdp) {
      cdp.shutdown();
      await new Promise((resolve) => setTimeout(resolve, 100));
      cdp.close();
    }
  });
  let browserStopped = !browser;
  await cleanup(async () => {
    if (browser) {
      if (browser.pid && browser.exitCode === null && browser.signalCode === null) browser.kill();
      await within(browserClosed, 5_000, "Geometry browser shutdown");
      browserStopped = true;
    }
  });
  await cleanup(() => within(server.close(), 2_000, "Vite shutdown"));
  if (browserStopped) {
    await cleanup(() => rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  }
  if (cleanupErrors.length) {
    const message = `CHAT_GEOMETRY_CLEANUP_FAILED ${JSON.stringify(cleanupErrors)}`;
    if (primaryError) process.stderr.write(`${message}\n`);
    else throw new Error(message);
  }
}
