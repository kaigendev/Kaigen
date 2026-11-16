import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const commandTimeout = 35_000;
const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 1000 },
];

async function until(check, label, timeout = commandTimeout) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for " + label, { cause: lastError });
}

/** Own one CDP/BiDi connection. Requests and event capture share the same page lifetime. */
async function connect(endpoint, observe) {
  const socket = new WebSocket(endpoint);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.id === undefined) {
      observe(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error + ": " + message.message));
    else request.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Browser debugging socket closed"));
    }
    pending.clear();
  });
  try {
    await new Promise((resolve, reject) => {
      const signal = AbortSignal.timeout(commandTimeout);
      signal.addEventListener("abort", () => reject(new Error("Browser debugging socket timed out")), { once: true });
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("Browser debugging socket failed")), { once: true });
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return {
    call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Browser command timed out: " + method));
        }, commandTimeout);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

function consoleRecord(message, phase) {
  const { method, params } = message;
  if (method === "Runtime.consoleAPICalled") {
    return { phase, method, level: params.type, arguments: params.args.map(({ type, value, description }) => ({ type, value, description })) };
  }
  if (method === "Runtime.exceptionThrown") {
    const { text, exception, lineNumber, columnNumber } = params.exceptionDetails;
    return { phase, method, level: "error", text, description: exception?.description, lineNumber, columnNumber };
  }
  if (method === "Log.entryAdded" || method === "log.entryAdded") {
    const entry = method === "Log.entryAdded" ? params.entry : params;
    return { phase, method, level: entry.level, text: entry.text };
  }
  if (method === "Network.loadingFailed" && !params.canceled) {
    return { phase, method, level: "network-error", error: params.errorText, type: params.type };
  }
  if (method === "network.fetchError") {
    return { phase, method, level: "network-error", error: params.errorText };
  }
  const response = params?.response;
  if (["Network.responseReceived", "network.responseCompleted"].includes(method)) {
    const pathname = new URL(response.url).pathname;
    if (response.status >= 400) return { phase, method, level: "http-error", status: response.status, path: pathname };
    if (["/api/v1/auth/password", "/api/v1/workspaces/destroy"].includes(pathname)) {
      return { phase, method, level: "proof", status: response.status, path: pathname };
    }
  }
}

async function chromiumPage(client, url) {
  for (const domain of ["Page", "Runtime", "Log", "Network"]) await client.call(domain + ".enable");
  const identity = await client.call("Browser.getVersion");
  return {
    identity,
    async navigate() {
      const result = await client.call("Page.navigate", { url });
      assert(!result.errorText, result.errorText);
    },
    resize: ({ width, height }) => client.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }),
    insertText: (text) => client.call("Input.insertText", { text }),
    async evaluate(expression) {
      const result = await client.call("Runtime.evaluate", { expression, returnByValue: true });
      assert(!result.exceptionDetails, result.exceptionDetails?.text);
      return result.result.value;
    },
    async screenshot() { return (await client.call("Page.captureScreenshot", { format: "png" })).data; },
  };
}

async function firefoxPage(client, url, allowFixtureCertificate) {
  const session = await client.call("session.new", {
    capabilities: allowFixtureCertificate ? { alwaysMatch: { acceptInsecureCerts: true } } : {},
  });
  if (!allowFixtureCertificate && session.capabilities.acceptInsecureCerts !== undefined) {
    assert.equal(session.capabilities.acceptInsecureCerts, false, "Live Firefox must verify TLS certificates");
  }
  const { context } = await client.call("browsingContext.create", { type: "tab" });
  assert(context, "Firefox did not open a disposable tab");
  await client.call("session.subscribe", { contexts: [context], events: ["log.entryAdded", "network.responseCompleted", "network.fetchError"] });
  return {
    identity: session.capabilities,
    navigate: () => client.call("browsingContext.navigate", { context, url, wait: "complete" }),
    resize: ({ width, height }) => client.call("browsingContext.setViewport", { context, viewport: { width, height } }),
    insertText: (text) => client.call("input.performActions", { context, actions: [{
      type: "key", id: "fixture-keyboard",
      actions: Array.from(text).flatMap(value => [{ type: "keyDown", value }, { type: "keyUp", value }]),
    }] }),
    async evaluate(expression) {
      const result = await client.call("script.evaluate", {
        expression: "JSON.stringify(" + expression + ")", target: { context }, awaitPromise: false,
      });
      assert.equal(result.type, "success");
      return result.result.value === undefined ? undefined : JSON.parse(result.result.value);
    },
    async screenshot() { return (await client.call("browsingContext.captureScreenshot", { context })).data; },
  };
}

/** Exercise the shipped Web gate with generated credentials and the real backend. */
async function createWorkspace(page, password, submitted) {
  await until(() => page.evaluate('document.querySelectorAll(".web-gate input[autocomplete=new-password]").length === 2'), "workspace creation form");
  for (const index of [0, 1]) {
    assert(await page.evaluate('(() => {'
      + 'const field = document.querySelectorAll(".web-gate input[autocomplete=new-password]")[' + index + '];'
      + 'field.focus(); return document.activeElement === field; })()'));
    await page.insertText(password);
  }
  await until(() => page.evaluate('(() => { const button = document.querySelector(".web-gate form button.web-primary");'
    + 'if (!button || button.type !== "submit" || button.disabled) return false; button.click(); return true; })()'), "creation submit");
  submitted();
  await until(() => page.evaluate('!!document.querySelector(".web-shell .web-app-window")'), "authenticated workspace", 180_000);
}

const snapshotExpression = '({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,'
  + ' workspaceVisible: !!document.querySelector(".web-shell .web-app-window"), authGateVisible: !!document.querySelector(".web-gate") })';

async function destroyWorkspace(page, url, ownedHash) {
  assert(/^#(?:k=)?[A-Za-z0-9_-]{40,80}$/u.test(ownedHash));
  await page.resize(viewports.at(-1));
  await until(() => page.evaluate('(() => { const menu = document.querySelector(".web-menu > button[aria-haspopup=menu]");'
    + 'if (!menu) return false; if (menu.getAttribute("aria-expanded") !== "true") menu.click(); return true; })()'), "workspace menu");
  const destination = JSON.stringify({ origin: new URL(url).origin, hash: ownedHash });
  await until(() => page.evaluate('(() => { const expected = ' + destination + ';'
    + 'if (location.origin !== expected.origin || location.hash !== expected.hash) throw Error("Workspace changed");'
    + 'const button = document.querySelector(".web-menu nav button.danger");'
    + 'if (!button || button.disabled) return false; button.click(); return true; })()'), "owned workspace destroy action");
  await until(() => page.evaluate('(() => { const button = document.querySelector("form[aria-labelledby=web-destroy-title] button.danger");'
    + 'if (!button || button.disabled) return false; button.click(); return true; })()'), "owned workspace destroy confirmation");
  await until(() => page.evaluate('!location.hash && !!document.querySelector(".web-gate .web-success")'), "workspace destroy acknowledgement");
}

async function collect(browser, url, certificatePin, directory, destroyAfterRun) {
  await mkdir(directory);
  const profile = path.join(directory, "profile");
  await mkdir(profile);
  const chromium = browser.name !== "firefox";
  if (!chromium) {
    await writeFile(path.join(profile, "user.js"), [
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.firstrunSkipsHomepage", true);',
      'user_pref("network.captive-portal-service.enabled", false);',
      'user_pref("network.connectivity-service.enabled", false);',
    ].join("\n") + "\n", { flag: "wx" });
  }
  const flags = chromium
    ? ["--headless=new", "--remote-debugging-port=0", "--disable-background-networking",
      "--disable-component-update", "--no-first-run", "--no-default-browser-check",
      ...(certificatePin ? ["--ignore-certificate-errors-spki-list=" + certificatePin] : []),
      "--user-data-dir=" + profile]
    : ["-headless", "-no-remote", "-profile", profile, "--remote-debugging-port", "0"];
  const child = spawn(browser.executable, [...flags, "about:blank"], { windowsHide: true });
  const stdout = [], stderr = [], records = [];
  const password = randomBytes(24).toString("base64url");
  let spawnError, client, page, ownedHash, creationSubmitted = false, phase = "workspace-entry";
  child.on("error", error => { spawnError = error; });
  child.stdout.on("data", bytes => stdout.push(bytes));
  child.stderr.on("data", bytes => stderr.push(bytes));
  const closed = new Promise(resolve => child.once("close", (exit, signal) => resolve({ exit, signal })));
  const report = { browser: browser.name, executable: browser.executable, viewports: [], status: "FAIL" };
  try {
    const endpoint = await until(async () => {
      if (spawnError) throw spawnError;
      if (!chromium) {
        const match = /WebDriver BiDi listening on (ws:\/\/(?:127\.0\.0\.1|localhost):\d+)/u.exec(Buffer.concat(stderr).toString("utf8"));
        return match && match[1] + "/session";
      }
      const port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0].trim();
      const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(3000) })).json();
      return targets.find(target => target.type === "page")?.webSocketDebuggerUrl;
    }, browser.name + " debugging endpoint");
    client = await connect(endpoint, message => {
      const record = consoleRecord(message, phase);
      if (record) records.push(record);
    });
    page = chromium ? await chromiumPage(client, url) : await firefoxPage(client, url, Boolean(certificatePin));
    report.identity = page.identity;
    await page.resize(viewports[0]);
    await page.navigate();
    await createWorkspace(page, password, () => { creationSubmitted = true; });
    if (destroyAfterRun) ownedHash = await page.evaluate("location.hash");
    for (const viewport of viewports) {
      phase = viewport.name;
      await page.resize(viewport);
      const layout = await until(async () => {
        const current = await page.evaluate(snapshotExpression);
        return current?.width === viewport.width && current.height === viewport.height && current;
      }, viewport.name + " viewport geometry");
      assert(layout.workspaceVisible && !layout.authGateVisible, viewport.name + " has no authenticated workspace");
      assert(layout.scrollWidth <= layout.width, viewport.name + " overflows the viewport");
      await delay(700);
      await writeFile(path.join(directory, viewport.name + ".png"), Buffer.from(await page.screenshot(), "base64"), { flag: "wx" });
      report.viewports.push({ ...viewport, ...layout });
    }
    const severe = records.filter(record => ["error", "assert", "network-error", "http-error"].includes(record.level));
    const oldMetaWarnings = records.filter(record => record.level === "warning" && record.text?.includes("apple-mobile-web-app-capable"));
    report.diagnostics = { severe: severe.length, oldMetaWarnings: oldMetaWarnings.length, total: records.length };
    assert(records.some(record => record.level === "proof" && record.path === "/api/v1/auth/password" && record.status === 200),
      "Missing password authentication receipt");
    assert.equal(severe.length, 0, "Console or network errors in " + browser.name);
    assert.equal(oldMetaWarnings.length, 0, "Deprecated PWA metadata warning in " + browser.name);
    report.status = "PASS";
  } catch (error) {
    report.error = String(error.stack ?? error);
  } finally {
    if (destroyAfterRun && creationSubmitted) {
      phase = "cleanup";
      try {
        ownedHash ||= await page.evaluate("location.hash");
        await destroyWorkspace(page, url, ownedHash);
        report.workspaceDestroyed = true;
      } catch (error) {
        report.workspaceDestroyed = false;
        report.workspaceCleanupError = error.message;
        report.status = "FAIL";
      }
    }
    if (client) {
      await Promise.race([client.call(chromium ? "Browser.close" : "browser.close").catch(() => {}), delay(500)]);
      client.close();
    }
    let outcome = await Promise.race([closed, delay(1000)]);
    if (!outcome) {
      child.kill();
      outcome = await Promise.race([closed, delay(3000)]);
    }
    report.process = outcome ?? { stopped: false };
    try {
      assert(outcome, "Browser process did not close");
      const resolvedProfile = await realpath(profile);
      assert.equal(resolvedProfile, path.join(await realpath(directory), "profile"));
      await rm(resolvedProfile, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
      report.profileRemoved = true;
    } catch (error) {
      report.profileRemoved = false;
      report.cleanupError = error.message;
      report.status = "FAIL";
    }
    const redact = text => text.replaceAll(password, "[test password]")
      .replace(/#(?:k=)?[A-Za-z0-9_-]{40,80}/gu, "#[test workspace]");
    await Promise.all([
      writeFile(path.join(directory, "console.jsonl"), redact(records.map(record => JSON.stringify(record) + "\n").join("")), { flag: "wx" }),
      writeFile(path.join(directory, "browser.stdout.log"), redact(Buffer.concat(stdout).toString("utf8")), { flag: "wx" }),
      writeFile(path.join(directory, "browser.stderr.log"), redact(Buffer.concat(stderr).toString("utf8")), { flag: "wx" }),
      writeFile(path.join(directory, "report.json"), redact(JSON.stringify(report, null, 2)) + "\n", { flag: "wx" }),
    ]);
  }
  return report;
}

/** Run branded browsers only against the disposable loopback Web engine fixture. */
export async function runWorkspaceConsoleMatrix({ origin, certificate, evidenceRoot, browsers }) {
  const url = new URL(origin);
  assert(url.protocol === "https:" && url.hostname === "127.0.0.1" && url.pathname === "/"
    && !url.search && !url.hash && !url.username && !url.password);
  const spki = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" });
  const pin = createHash("sha256").update(spki).digest("base64");
  return runMatrix(url, pin, evidenceRoot, browsers, false);
}

async function runMatrix(url, certificatePin, evidenceRoot, browsers, destroyAfterRun) {
  await mkdir(evidenceRoot);
  const reports = [];
  for (const browser of browsers) {
    reports.push(await collect(browser, url.href, certificatePin, path.join(evidenceRoot, browser.name), destroyAfterRun));
    if (destroyAfterRun && reports.at(-1).workspaceDestroyed === false) break;
  }
  const summary = { reports, status: reports.length === browsers.length && reports.every(report => report.status === "PASS") ? "PASS" : "FAIL" };
  await writeFile(path.join(evidenceRoot, "matrix.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
  return summary;
}

async function runAuthorizedLab() {
  const [target, expectedBuildId, output, authorization, ...extra] = process.argv.slice(2);
  assert(target === "https://kaigen.test/" && /^[A-Za-z0-9._-]{12,80}$/u.test(expectedBuildId ?? "")
    && output && authorization === "--create-and-destroy-test-workspaces" && !extra.length,
  "Use node --use-system-ca workspace-console-matrix.mjs https://kaigen.test/ BUILD_ID FRESH_OUTPUT --create-and-destroy-test-workspaces");
  const url = new URL(target);
  const identity = async () => {
    const response = await fetch(new URL("/api/v1/build-identity", url), { signal: AbortSignal.timeout(15_000) });
    assert(response.ok, "Lab identity endpoint HTTP " + response.status);
    const raw = await response.text();
    assert.equal(JSON.parse(raw).buildId, expectedBuildId, "Unexpected Lab candidate");
    return raw;
  };
  const evidence = path.resolve(output);
  const before = await identity();
  const browsers = [
    { name: "chrome", executable: path.join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe") },
    { name: "edge", executable: path.join(process.env["ProgramFiles(x86)"], "Microsoft/Edge/Application/msedge.exe") },
    { name: "firefox", executable: path.join(process.env.ProgramFiles, "Mozilla Firefox/firefox.exe") },
  ];
  const result = await runMatrix(url, null, evidence, browsers, true);
  await writeFile(path.join(evidence, "build-identity-before.json"), before, { flag: "wx" });
  await writeFile(path.join(evidence, "build-identity-after.json"), await identity(), { flag: "wx" });
  if (result.status !== "PASS") process.exitCode = 1;
  console.log("LAB_WORKSPACE_CONSOLE_" + result.status);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runAuthorizedLab();
}
