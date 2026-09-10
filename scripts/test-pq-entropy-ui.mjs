import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

const repository = path.resolve(import.meta.dirname, "..");
const fixture = path.join(import.meta.dirname, "fixtures", "pq-entropy-runtime");

const [component, styles, app, translations] = await Promise.all([
  readFile(new URL("../src/PqEntropy.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/PqEntropy.css", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n.tsx", import.meta.url), "utf8"),
]);

assert.match(component, /PQ_ENTROPY_COLLECTION_MS = 3_000/u, "the automatic entropy window stays short and bounded");
assert.match(component, /onBeginRef\.current\(friendNumber\)/u, "the collector reserves a real backend window before gathering noise");
assert.match(component, /if \(!collectionReady && !error\) return null/u, "an unavailable backend lease must not show a fake collector");
assert.match(component, /PQ_ENTROPY_SAMPLE_LIMIT = 96/u, "pointer samples are bounded");
assert.match(component, /PQ_ENTROPY_DIGEST_BYTES = 32/u, "the backend receives at most one SHA-256 digest");
assert.match(component, /subtle\.digest\("SHA-256", input\)/u, "additional interaction is reduced with the platform hash primitive");
assert.match(component, /bufferRef\.current\.fill\(0\)/u, "raw pointer deltas are erased after use and on unmount");
assert.match(component, /input\.fill\(0\)/u, "the temporary digest input is erased");
assert.match(component, /point\.clientX - previous\.x/u);
assert.match(component, /point\.clientY - previous\.y/u);
assert.doesNotMatch(component, /addEventListener\(["']pointer(?:move|down|up)/u, "pointer collection must never escape the in-chat surface");
assert.match(component, /document\.visibilityState !== "visible"/u, "background chats cannot collect interaction noise");
assert.match(component, /!document\.hasFocus\(\)/u, "an unfocused Kaigen window cannot collect interaction noise");
assert.match(component, /finish\(true\)/u, "an explicit OS-only path is always available");
assert.doesNotMatch(component, /entropy.{0,16}(?:bit|бит)|(?:bit|бит).{0,16}entropy/iu, "the UI must not claim measured entropy bits");

assert.match(app, /activePq\?\.identity_needs_entropy && activePq\.identity_waiting/u, "existing identities and idle chats must never show the collector");
assert.match(app, /invoke<PqStatus>\("complete_pq_identity", \{ friendNumber, extraNoise \}\)/u, "the digest is scoped to the waiting contact");
assert.match(app, /\(!activePq\.supported \|\| activePqCancelledAwaitingDecision\)/u, "unknown capability and cancelled first negotiation both keep the first send behind an explicit decision");
assert.match(app, /reason=\{activePqCancelledAwaitingDecision \? "cancelled" : "checking"\}/u, "the decision row distinguishes stopped negotiation from a pending capability check");
for (const errorCode of ["PQ_AUTO_ALREADY_NEGOTIATING", "PQ_CONTACT_IDENTITY_CHANGED", "PQ_OUTBOX_BACKPRESSURE", "PQ_SESSION_WAIT", "PQ_PEER_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ", "PQ_NEGOTIATION_CANCELLED_MESSAGES_WAIT_FOR_MANUAL_PQ"]) {
  assert.match(app, new RegExp(errorCode, "u"), `${errorCode} must have a friendly PQ-specific UI message`);
}
assert.match(app, /formatPqUserFacingError\(error, \{ ru: "Не удалось отправить сообщение"/u, "send failures must use friendly PQ error labels");
assert.match(app, /invoke<PqStatus>\("skip_pq_auto", \{ friendNumber \}\)/u, "plain Tox fallback requires an explicit contact-scoped command");
assert.match(app, /key=\{`\$\{activeProfileId\}:\$\{active\.friendNumber\}`\}/u, "profile or contact changes remount and clear the collector");

assert.match(styles, /var\(--kaigen-color-accent\)/u);
assert.match(styles, /var\(--palette4-composer\)/u);
assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/iu, "the collector uses the shared semantic palette in every theme");
assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u, "motion follows the system accessibility preference");
assert.match(styles, /container:\s*pq-composer \/ inline-size/u, "responsive layout follows the actual chat width after desktop sidebars");
assert.match(styles, /@container pq-composer \(max-width: 520px\)/u, "a narrow conversation stacks the compact collector even in a wider app window");
for (const selector of ["pq-entropy-panel", "pq-capability-wait"]) {
  const block = styles.match(new RegExp(`\\.${selector} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1] ?? "";
  assert.doesNotMatch(block, /position:\s*absolute/u, `${selector} must reserve space above the composer instead of covering history`);
  assert.match(block, /flex:\s*0 0 auto/u, `${selector} must remain a bounded row in the composer section`);
}
assert.match(app, /\[active\.id, activePqComposerStage, screen\]/u, "PQ row geometry must reposition a followed chat at its latest message");

for (const phrase of [
  "Дополнительная случайность для нового PQ-ключа",
  "Только системная случайность",
  "Движения добавляются только локально",
  "Согласование PQ остановлено",
  "Сообщения ожидают. Включите PQ в меню чата или продолжите без него.",
]) {
  assert.ok(translations.includes(`\"${phrase}\":`), `missing English translation: ${phrase}`);
}

if (!process.argv.includes("--runtime")) {
  console.log("PQ entropy chat UI static contract passed.");
  process.exit(0);
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
        path.join(process.env["PROGRAMFILES(X86)"] ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"),
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
  const found = (requested ? [path.resolve(requested)] : [...fixed, ...pathCandidates])
    .find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("PQ_ENTROPY_BROWSER_MISSING: set KAIGEN_UI_TEST_BROWSER to an existing Chrome/Edge/Chromium executable");
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
    if (intentionalClose) return;
    for (const request of pending.values()) request.reject(new Error(`${request.method} was interrupted`));
    pending.clear();
  });
  return {
    close: () => socket.close(),
    shutdown() {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: ++sequence, method: "Browser.close", params: {} }));
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

const profile = await mkdtemp(path.join(os.tmpdir(), "kaigen-pq-entropy-ui-"));
const server = await createServer({
  configFile: false,
  root: fixture,
  plugins: [react()],
  define: {
    __KAIGEN_PRODUCT__: JSON.stringify("desktop"),
    __KAIGEN_WEB_BUILD_ID__: JSON.stringify("pq-entropy-runtime"),
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
  const requestedTheme = process.argv.find((argument) => argument.startsWith("--theme="))?.slice("--theme=".length);
  const themeQuery = requestedTheme === "softlifegreen" ? "&theme=softlifegreen" : "";
  browser = spawn(browserPath(), [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--disable-component-update",
    "--disable-default-apps", "--disable-sync", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=860,560", "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  browser.stderr?.on("data", (chunk) => {
    if (browserErrors.length < 8_192) browserErrors += String(chunk);
  });
  const activePort = path.join(profile, "DevToolsActivePort");
  let debugPort;
  try {
    debugPort = await waitFor(async () => {
      const [port] = (await readFile(activePort, "utf8")).trim().split(/\r?\n/u);
      const parsed = Number(port);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }, 4_000, "Chrome DevTools endpoint");
  } catch (error) {
    throw new Error(`${error.message}\n${browserErrors}`);
  }
  const page = await fetch(`http://127.0.0.1:${debugPort}/json/new?about%3Ablank`, {
    method: "PUT",
    signal: AbortSignal.timeout(1_000),
  }).then((response) => response.json());
  cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 860, height: 560, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.bringToFront");
  await cdp.send("Page.navigate", { url: `${origin}/?mode=baseline${themeQuery}` });
  const baseline = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const composer = document.querySelector('.composer');
        const header = document.querySelector('.conversation-header');
        if (!composer || !header) return undefined;
        const composerBox = composer.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        return { composerBottom: composerBox.bottom, headerHeight: headerBox.height };
      })()`,
      returnByValue: true,
    });
    return evaluated.result?.value;
  }, 3_000, "PQ baseline fixture");
  await cdp.send("Page.navigate", { url: `${origin}/?mode=entropy${themeQuery}` });
  const layout = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const panel = document.querySelector('.pq-entropy-panel');
        const field = document.querySelector('.pq-entropy-constellation');
        const composer = document.querySelector('.composer');
        const header = document.querySelector('.conversation-header');
        const scroller = document.querySelector('.message-scroll');
        const pending = document.querySelector('[data-message-key="pending-first"]');
        if (!panel || !field || !composer || !header || !scroller || !pending || !window.__PQ_ENTROPY_VISIBLE_AT__) return undefined;
        const panelBox = panel.getBoundingClientRect();
        const fieldBox = field.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const pendingBox = pending.getBoundingClientRect();
        return {
          panel: { left: panelBox.left, top: panelBox.top, right: panelBox.right, bottom: panelBox.bottom, width: panelBox.width },
          field: { left: fieldBox.left, top: fieldBox.top, width: fieldBox.width, height: fieldBox.height },
          composerTop: composerBox.top,
          composerBottom: composerBox.bottom,
          headerHeight: headerBox.height,
          scrollerBottom: scrollerBox.bottom,
          pendingBottom: pendingBox.bottom,
          background: getComputedStyle(panel).backgroundColor,
          starAnimation: getComputedStyle(document.querySelector('.pq-entropy-map circle')).animationName,
        };
      })()`,
      returnByValue: true,
    });
    return evaluated.result?.value;
  }, 3_000, "PQ entropy fixture");
  if (process.argv.includes("--debug-layout")) console.log(JSON.stringify(layout));
  assert.equal(layout.headerHeight, 68, "the in-chat collector must preserve the current header geometry");
  assert.equal(layout.headerHeight, baseline.headerHeight, "the PQ row must not move or resize the header");
  assert.ok(Math.abs(layout.composerBottom - baseline.composerBottom) <= 0.5, "the composer must remain pinned to the bottom edge");
  assert.ok(layout.panel.width <= 720 && layout.panel.width >= 540, "the panel stays compact inside a wide chat");
  assert.ok(layout.panel.bottom <= layout.composerTop - 8, "the panel remains a distinct row above the composer");
  assert.ok(layout.scrollerBottom <= layout.panel.top + 0.5, "the PQ row must take space from the history viewport instead of covering it");
  assert.ok(layout.pendingBottom <= layout.scrollerBottom + 0.5, "the newest pending message must stay visible during PQ setup");
  assert.ok(layout.field.height >= 70, "the constellation retains a usable mouse and touch target");
  assert.notEqual(layout.background, "rgba(0, 0, 0, 0)", "the panel consumes the active theme surface");
  assert.equal(layout.starAnimation, "pq-star-breathe", "the foreground constellation uses its restrained animation");

  const y = layout.field.top + layout.field.height / 2;
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: layout.field.left + layout.field.width * step / 11,
      y: y + (step % 2 === 0 ? 12 : -12),
    });
  }
  const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 860, height: 560, scale: 1 } }, 4_000);
  const screenshotTarget = process.argv.find((argument) => argument.startsWith("--screenshot="))?.slice("--screenshot=".length)
    ?? process.env.KAIGEN_PQ_ENTROPY_SCREENSHOT;
  if (screenshotTarget) {
    await mkdir(path.dirname(path.resolve(screenshotTarget)), { recursive: true });
    await writeFile(path.resolve(screenshotTarget), Buffer.from(screenshot.data, "base64"));
  }

  const autoResult = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", { expression: "window.__PQ_ENTROPY_RUNTIME__", returnByValue: true });
    return evaluated.result?.value;
  }, 4_000, "automatic entropy completion");
  assert.equal(autoResult.calls, 1, "the automatic window completes exactly once");
  assert.equal(autoResult.noise.length, 32, "pointer interaction sends one bounded digest");
  assert.ok(autoResult.noise.every((value) => Number.isInteger(value) && value >= 0 && value <= 255));
  const visibleAt = await cdp.send("Runtime.evaluate", { expression: "window.__PQ_ENTROPY_VISIBLE_AT__", returnByValue: true });
  assert.ok(autoResult.completedAt - visibleAt.result.value >= 3_000, "automatic completion leaves the real collector visible for at least three seconds");

  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const reducedMotion = await cdp.send("Runtime.evaluate", {
    expression: "getComputedStyle(document.querySelector('.pq-entropy-map circle')).animationName",
    returnByValue: true,
  });
  assert.equal(reducedMotion.result?.value, "none", "reduced motion disables decorative animation");

  await cdp.send("Page.navigate", { url: `${origin}/?mode=capability${themeQuery}` });
  const capabilityLayout = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const panel = document.querySelector('.pq-capability-wait');
        const scroller = document.querySelector('.message-scroll');
        const pending = document.querySelector('[data-message-key="pending-first"]');
        const header = document.querySelector('.conversation-header');
        const composer = document.querySelector('.composer');
        if (!panel || !scroller || !pending || !header || !composer) return undefined;
        const panelBox = panel.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const pendingBox = pending.getBoundingClientRect();
        const headerBox = header.getBoundingClientRect();
        const composerBox = composer.getBoundingClientRect();
        return { panelTop: panelBox.top, scrollerBottom: scrollerBox.bottom, pendingBottom: pendingBox.bottom, headerTop: headerBox.top, headerHeight: headerBox.height, composerBottom: composerBox.bottom, scrollY };
      })()`,
      returnByValue: true,
    });
    return evaluated.result?.value;
  }, 3_000, "PQ capability fixture");
  assert.ok(capabilityLayout.scrollerBottom <= capabilityLayout.panelTop + 0.5, "the capability row must not overlay history");
  assert.ok(capabilityLayout.pendingBottom <= capabilityLayout.scrollerBottom + 0.5, "the pending first message stays visible during capability detection");
  assert.equal(capabilityLayout.headerTop, 0, "the capability row must not displace the fixed chat header");
  assert.equal(capabilityLayout.headerHeight, baseline.headerHeight, "the capability row must not resize the chat header");
  assert.ok(Math.abs(capabilityLayout.composerBottom - baseline.composerBottom) <= 0.5, "the capability row must leave the composer on the bottom edge");
  assert.equal(capabilityLayout.scrollY, 0, "the full-screen chat document must not scroll around a PQ row");
  const capabilityScreenshotTarget = process.argv.find((argument) => argument.startsWith("--capability-screenshot="))?.slice("--capability-screenshot=".length);
  if (capabilityScreenshotTarget) {
    const capabilityScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 860, height: 560, scale: 1 } }, 4_000);
    await mkdir(path.dirname(path.resolve(capabilityScreenshotTarget)), { recursive: true });
    await writeFile(path.resolve(capabilityScreenshotTarget), Buffer.from(capabilityScreenshot.data, "base64"));
  }

  const controlCases = [
    ...["peer", "local"].flatMap((decision) => ["error", "accepting"].map((state) => ({
      mode: "cancelled", decision, state, label: "Включить PQ", command: "request_pq_session",
    }))),
    { mode: "cancelled", decision: "peer", state: "error", language: "en", label: "Enable PQ", command: "request_pq_session" },
    { mode: "control", state: "available", label: "Включить PQ", command: "request_pq_session" },
    { mode: "control", state: "error", label: "Включить PQ", command: "request_pq_session" },
    { mode: "control", state: "offered", label: "Отозвать предложение PQ", command: "withdraw_pq_session" },
    { mode: "control", state: "active", label: "Отменить PQ", command: "request_pq_shutdown" },
    { mode: "control", state: "incoming_offer", decision: "peer", label: "Инициация PQ", command: null },
    { mode: "control", state: "accepting", label: "Инициация PQ", command: null },
    { mode: "control", state: "accepting", decision: "peer", identityWaiting: "true", label: "Инициация PQ", command: null },
    ...["closing", "closing_commit", "closing_ack", "closing_final"].map((state) => ({
      mode: "control", state, decision: "peer", label: "Отключение PQ…", command: null,
    })),
    { mode: "control", state: "unavailable", supported: "false", command: null },
  ];
  for (const controlCase of controlCases) {
    const { label, command, ...query } = controlCase;
    await cdp.send("Page.navigate", { url: `${origin}/?${new URLSearchParams(query)}${themeQuery}` });
    const rendered = await waitFor(async () => {
      const evaluated = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const control = document.querySelector('[data-pq-control]');
          if (!control || !window.__PQ_CONTROL_COMMANDS__) return undefined;
          const button = control.querySelector('button');
          const panel = document.querySelector('.pq-capability-wait');
          return { present: !!button, label: button?.textContent, disabled: button?.disabled, copy: panel?.textContent };
        })()`,
        returnByValue: true,
      });
      return evaluated.result?.value;
    }, 3_000, `PQ action ${JSON.stringify(query)}`);
    assert.equal(rendered.present, query.supported !== "false", "an unsupported peer has no manual PQ action");
    if (rendered.present) {
      assert.equal(rendered.label, label);
      assert.equal(rendered.disabled, !command, `${query.state} must expose only a valid action`);
    }
    if (query.mode === "cancelled") {
      assert.match(rendered.copy, query.language === "en" ? /PQ negotiation stopped/u : /Согласование PQ остановлено/u,
        "a protocol cancellation is not attributed to a human decision");
      assert.match(rendered.copy, query.language === "en" ? /Enable PQ in the chat menu/u : /Включите PQ в меню чата/u,
        "the pending-message recovery points to the enabled menu action");
    }
    await cdp.send("Runtime.evaluate", { expression: "document.querySelector('[data-pq-control] button')?.click()" });
    const dispatched = await cdp.send("Runtime.evaluate", {
      expression: "({ commands: window.__PQ_CONTROL_COMMANDS__, skipped: window.__PQ_ENTROPY_RUNTIME__ })",
      returnByValue: true,
    });
    assert.deepEqual(dispatched.result?.value?.commands, command ? [command] : [], "the rendered button dispatches the exact PQ action");
    assert.equal(dispatched.result?.value?.skipped, undefined, "retry never converts waiting messages to plain Tox");
  }

  await cdp.send("Page.navigate", { url: `${origin}/?mode=entropy&shell=full${themeQuery}` });
  const narrowLayout = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const conversation = document.querySelector('.conversation');
        const panel = document.querySelector('.pq-entropy-panel');
        const copy = document.querySelector('.pq-entropy-copy');
        const field = document.querySelector('.pq-entropy-constellation');
        const scroller = document.querySelector('.message-scroll');
        const pending = document.querySelector('[data-message-key="pending-first"]');
        if (!conversation || !panel || !copy || !field || !scroller || !pending || !window.__PQ_ENTROPY_VISIBLE_AT__) return undefined;
        const conversationBox = conversation.getBoundingClientRect();
        const panelBox = panel.getBoundingClientRect();
        const copyBox = copy.getBoundingClientRect();
        const fieldBox = field.getBoundingClientRect();
        const scrollerBox = scroller.getBoundingClientRect();
        const pendingBox = pending.getBoundingClientRect();
        return {
          conversationWidth: conversationBox.width,
          panelLeft: panelBox.left,
          panelRight: panelBox.right,
          conversationLeft: conversationBox.left,
          conversationRight: conversationBox.right,
          copyBottom: copyBox.bottom,
          fieldTop: fieldBox.top,
          panelScrollWidth: panel.scrollWidth,
          panelClientWidth: panel.clientWidth,
          scrollerBottom: scrollerBox.bottom,
          pendingBottom: pendingBox.bottom,
        };
      })()`,
      returnByValue: true,
    });
    return evaluated.result?.value;
  }, 3_000, "narrow full-shell PQ fixture");
  if (process.argv.includes("--debug-layout")) console.log(JSON.stringify(narrowLayout));
  assert.ok(narrowLayout.conversationWidth >= 480 && narrowLayout.conversationWidth <= 500, "the 860px full shell must exercise the actual narrow conversation width");
  assert.ok(narrowLayout.panelLeft >= narrowLayout.conversationLeft && narrowLayout.panelRight <= narrowLayout.conversationRight, "the collector must stay inside the narrow chat column");
  assert.ok(narrowLayout.fieldTop >= narrowLayout.copyBottom, "the narrow chat stacks the constellation below its copy");
  assert.ok(narrowLayout.panelScrollWidth <= narrowLayout.panelClientWidth, "the collector must not overflow horizontally in the narrow chat");
  assert.ok(narrowLayout.pendingBottom <= narrowLayout.scrollerBottom + 0.5, "the pending message stays visible in the narrow full shell");
  const narrowScreenshotTarget = process.argv.find((argument) => argument.startsWith("--narrow-screenshot="))?.slice("--narrow-screenshot=".length);
  if (narrowScreenshotTarget) {
    const narrowScreenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 860, height: 560, scale: 1 } }, 4_000);
    await mkdir(path.dirname(path.resolve(narrowScreenshotTarget)), { recursive: true });
    await writeFile(path.resolve(narrowScreenshotTarget), Buffer.from(narrowScreenshot.data, "base64"));
  }

  await cdp.send("Page.navigate", { url: `${origin}/?mode=entropy${themeQuery}` });
  await cdp.send("Page.bringToFront");
  await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `(() => { const button = document.querySelector('.pq-entropy-system'); if (!button || !document.hasFocus()) return false; button.focus(); return document.activeElement === button; })()`,
      returnByValue: true,
    });
    return evaluated.result?.value ? true : undefined;
  }, 3_000, "OS-only keyboard action");
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
  const systemResult = await waitFor(async () => {
    const evaluated = await cdp.send("Runtime.evaluate", { expression: "window.__PQ_ENTROPY_RUNTIME__", returnByValue: true });
    return evaluated.result?.value;
  }, 1_000, "OS-only completion");
  assert.equal(systemResult.calls, 1);
  assert.deepEqual(systemResult.noise, [], "the keyboard-accessible skip path adds no synthetic noise");

  const readRuntime = async () => {
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: `({ mode: new URLSearchParams(location.search).get('mode'), begin: window.__PQ_ENTROPY_BEGIN__, visibleAt: window.__PQ_ENTROPY_VISIBLE_AT__, result: window.__PQ_ENTROPY_RUNTIME__, visible: !!document.querySelector('.pq-entropy-panel') })`,
      returnByValue: true,
    });
    return evaluated.result?.value;
  };
  for (const mode of ["denied", "expired"]) {
    await cdp.send("Page.navigate", { url: `${origin}/?mode=${mode}${themeQuery}` });
    await waitFor(async () => {
      const state = await readRuntime();
      return state?.mode === mode && state.begin?.calls ? state : undefined;
    }, 3_000, `${mode} entropy lease`);
    await new Promise((resolve) => setTimeout(resolve, 3_200));
    const denied = await readRuntime();
    assert.equal(denied.visible, false, `${mode} lease never displays a collector after the key is unavailable`);
    assert.equal(denied.result, undefined, `${mode} lease never submits synthetic completion`);
  }

  await cdp.send("Page.navigate", { url: `${origin}/?mode=delayed${themeQuery}` });
  const beforeGrant = await waitFor(async () => {
    const state = await readRuntime();
    return state?.mode === "delayed" && state.begin?.calls && !state.begin.grantedAt ? state : undefined;
  }, 3_000, "delayed entropy lease request");
  assert.equal(beforeGrant.visible, false, "a pending reservation cannot pretend to gather noise");
  const delayed = await waitFor(async () => {
    const state = await readRuntime();
    return state?.result ? state : undefined;
  }, 6_000, "delayed entropy lease completion");
  assert.ok(delayed.visibleAt >= delayed.begin.grantedAt, "the collection window starts after the backend grant");
  assert.ok(delayed.result.completedAt - delayed.visibleAt >= 3_000, "lease latency cannot consume the visible collection window");
  assert.deepEqual(delayed.result.noise, [], "an untouched constellation uses only OS randomness");

  await cdp.send("Page.navigate", { url: `${origin}/?mode=begin-error${themeQuery}` });
  await waitFor(async () => {
    const state = await readRuntime();
    return state?.mode === "begin-error" && state.visible ? state : undefined;
  }, 3_000, "failed entropy reservation");
  await cdp.send("Runtime.evaluate", { expression: "document.querySelector('.pq-entropy-continue').click()" });
  const retried = await waitFor(async () => {
    const state = await readRuntime();
    return state?.begin?.calls === 2 && state.begin.grantedAt && state.visible ? state : undefined;
  }, 3_000, "retried entropy reservation");
  assert.equal(retried.result, undefined, "retry obtains a new collection opportunity before completion");
  await cdp.send("Runtime.evaluate", { expression: "window.__PQ_ENTROPY_UNMOUNT__()" });
  await new Promise((resolve) => setTimeout(resolve, 3_200));
  const unmounted = await readRuntime();
  assert.equal(unmounted.visible, false, "switching away removes the collector");
  assert.equal(unmounted.result, undefined, "unmount cancels the local timer and leaves fallback to the backend");

  console.log(`PQ entropy chat UI: static contract + real DOM timing, lease, error/retry, ${controlCases.length} PQ menu actions and unmount assertions passed (panel=${Math.round(layout.panel.width)}px, narrow-chat=${Math.round(narrowLayout.conversationWidth)}px, digest=${autoResult.noise.length} bytes, visible=${Math.round(autoResult.completedAt - visibleAt.result.value)}ms).`);
} finally {
  if (cdp) {
    cdp.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 100));
    cdp.close();
  }
  browser?.kill();
  await server.close().catch(() => {});
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
