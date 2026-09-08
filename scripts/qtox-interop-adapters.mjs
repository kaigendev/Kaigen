import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  KaigenProcess, check, freeLoopbackPort, sha256File, waitUntil,
} from "./test-pq-two-instances.mjs";
import {
  launchBrowser, WebCommandClient, createWorkspaceAndProfile, reopenWorkspace, readWebIdentity,
} from "./test-pq-desktop-web.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RUNS_ROOT = path.join(PROJECT_ROOT, "local-data/compatibility-runs/qtox");
const QTOX_CACHE = path.join(PROJECT_ROOT, "local-data/compatibility-cache/qtox/v1.18.5");
const QTOX_INSTALLER_SHA256 = "D947E5CC1042B2AD72600A1E2B9952D1E5B0691930D619F4347DBB1085D76F09";
const QTOX_LAUNCH_ALIAS = "qtox-kaigen-compat.exe";
const PORTABLE_INI = "[Advanced]\nmakeToxPortable=true\n";
const FIXED_SCREENSHOT_MASKS = [
  '.web-gate-card input[type="password"]', ".web-lease-actions", ".own-tox-meta", ".own-tox-id", ".tox-id",
  ".pq-history-fingerprints", ".friend-requests-view code", ".incoming-request code", ".outgoing-request code",
  '[class*="fingerprint"]',
];
const COMMANDS = new Set([
  "add_tox_friend", "get_tox_id", "get_tox_friends", "get_tox_messages", "get_pq_status",
  "get_chat_capabilities", "get_file_receive_settings", "set_file_receive_settings", "send_tox_message",
]);

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function safeManifestRelativePath(value) {
  return typeof value === "string" && value.split("/").every((part) =>
    /^[A-Za-z0-9_$+.-]+$/u.test(part) && part !== "." && part !== "..");
}

function assertQtoxLaunchBindings(expected, original, alias) {
  check(expected?.relativePath === "qtox.exe" && Number.isSafeInteger(expected.bytes) && expected.bytes > 0
    && /^[0-9A-F]{64}$/u.test(expected.sha256), "qTox executable manifest binding is invalid");
  for (const [label, observed] of [["original executable", original], ["launch alias", alias]]) {
    check(observed?.bytes === expected.bytes && observed.sha256 === expected.sha256,
      `owned qTox ${label} changed`);
  }
}

async function ordinaryPath(value, root, kind) {
  const resolved = path.resolve(value);
  check(within(root, resolved), `${kind} escaped the disposable root`);
  const info = await lstat(resolved);
  check(!info.isSymbolicLink() && (kind === "directory" ? info.isDirectory() : info.isFile()), `${kind} is not ordinary`);
  check(await realpath(resolved) === resolved, `${kind} traverses a redirected path`);
  return resolved;
}

async function boundFile(binding, label) {
  check(binding && /^[0-9A-F]{64}$/u.test(binding.sha256), `${label} hash is invalid`);
  const resolved = path.resolve(binding.path);
  const info = await lstat(resolved);
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0, `${label} is not an ordinary file`);
  check(await realpath(resolved) === resolved, `${label} path is redirected`);
  check(await sha256File(resolved) === binding.sha256, `${label} hash changed`);
  return { path: resolved, sha256: binding.sha256 };
}

async function validateOwnedRoot(runRoot, target) {
  const root = await ordinaryPath(runRoot, RUNS_ROOT, "directory");
  check(path.basename(root) === target && path.dirname(path.dirname(root)) === RUNS_ROOT, "unexpected target run root");
  const marker = JSON.parse(await readFile(path.join(root, ".kaigen-qtox-run.json"), "utf8"));
  check(marker.schemaVersion === 1 && marker.scope === "qtox-interop" && marker.target === target
    && marker.runId === path.basename(path.dirname(root)) && marker.status === "OWNED_NEW_ROOT", "qTox run ownership mismatch");
  return root;
}

async function copyObservedDownload(root, source, name, destinationRoot) {
  check(path.basename(name) === name && name.startsWith("qtox-to-kaigen-") && name.endsWith(".bin"), "unexpected download name");
  const file = await ordinaryPath(source, root, "file");
  check(path.basename(file) === name, "received filename changed");
  const bytes = await readFile(file);
  check(bytes.length === 64 * 1024, "received fixture byte count changed");
  const destination = path.join(destinationRoot, name);
  if (file !== destination) {
    try { await writeFile(destination, bytes, { flag: "wx" }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      await ordinaryPath(destination, destinationRoot, "file");
      check((await readFile(destination)).equals(bytes), "existing received evidence differs");
    }
  }
  return { path: destination, bytes };
}

function uiAdapter(getDriver, send, capture, timeoutMs) {
  const evaluate = (expression) => getDriver().evaluate(expression);
  const waitFor = (expression, label, timeout = timeoutMs) => waitUntil(async () =>
    (await evaluate(expression)) || undefined, timeout, label, 100);
  return {
    evaluate, waitFor,
    ensureChat: async () => {
      await waitFor(`(() => {
        const splash = document.querySelector('.splash-screen');
        if (splash && splash.getBoundingClientRect().width > 0) return false;
        const area = document.querySelector('.compose-row textarea');
        if (area instanceof HTMLTextAreaElement && area.getBoundingClientRect().width > 0) return true;
        const contacts = document.querySelectorAll('button.chat-item');
        if (contacts.length === 1) contacts[0].click();
        return false;
      })()`, "visible single qTox chat");
    },
    setValue: async (selector, value) => {
      check(await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!(node instanceof HTMLTextAreaElement)) return false;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, ${JSON.stringify(value)});
        node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: null }));
        node.focus({ preventScroll: true });
        return true;
      })()`) === true, "composer is unavailable");
    },
    setSelection: async (selector, start, end) => {
      check(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end >= start, "selection is invalid");
      check(await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!(node instanceof HTMLTextAreaElement)) return false;
        node.focus({ preventScroll: true }); node.setSelectionRange(${start}, ${end}, 'forward');
        node.dispatchEvent(new Event('select', { bubbles: true }));
        return node.selectionStart === ${start} && node.selectionEnd === ${end};
      })()`) === true, "exact composer selection failed");
    },
    contextClick: async (selector) => {
      const position = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        if (!(node instanceof HTMLTextAreaElement)) return null;
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
        const context = document.createElement('canvas').getContext('2d');
        if (!context || node.selectionStart === node.selectionEnd || rect.width <= 0) return null;
        context.font = style.font;
        const before = node.value.slice(0, node.selectionStart), selected = node.value.slice(node.selectionStart, node.selectionEnd);
        const spacing = parseFloat(style.letterSpacing) || 0;
        const x = rect.left + (parseFloat(style.paddingLeft) || 0) + context.measureText(before).width
          + [...before].length * spacing + (context.measureText(selected).width + Math.max(0, [...selected].length - 1) * spacing) / 2 - node.scrollLeft;
        const y = rect.top + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.lineHeight) || 20) / 2;
        return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom ? { x, y } : null;
      })()`);
      check(position, "selected text has no visible context-click point");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "right", buttons: 2, clickCount: 1 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "right", buttons: 0, clickCount: 1 });
    },
    keyPress: async (key) => {
      check(key === "Escape" || key === "ContextMenu", "unsupported fixture key");
      const code = key === "Escape" ? 27 : 93;
      for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    },
    capture,
  };
}

function checkedInvoke(client, command, args, timeoutMs) {
  check(COMMANDS.has(command), `qTox adapter rejected command ${command}`);
  return client.invoke(command, args, timeoutMs);
}

async function stopNative(client) {
  const child = client.child;
  await client.stop();
  check(!child || child.exitCode !== null || child.signalCode !== null, "owned Desktop process exit is unconfirmed");
}

async function captureMasked(driver, capture) {
  await driver.evaluate(`(() => {
    if (window.__qtoxCaptureMask) throw new Error('capture mask already installed');
    const masked = new Map();
    const mask = () => {
      for (const node of document.querySelectorAll(${JSON.stringify(FIXED_SCREENSHOT_MASKS.join(","))})) {
        if (!(node instanceof HTMLElement)) continue;
        if (!masked.has(node)) masked.set(node, node.getAttribute('style'));
        node.style.setProperty('visibility', 'hidden', 'important');
      }
    };
    mask();
    const observer = new MutationObserver(mask);
    observer.observe(document.body, { subtree: true, childList: true });
    window.__qtoxCaptureMask = { masked, observer };
  })()`);
  try { await capture(); }
  finally {
    check(await driver.evaluate(`(() => {
      const state = window.__qtoxCaptureMask;
      if (!state) return false;
      state.observer.disconnect();
      for (const [node, style] of state.masked) {
        if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
      }
      delete window.__qtoxCaptureMask;
      return true;
    })()`) === true, "screenshot mask restoration failed");
  }
}

// Construction is side-effect free. The session creates and marks the run root;
// start() is called explicitly afterwards by the real-app test orchestrator.
export function createDesktopQtoxAdapter({ runRoot, identity, executable, timeoutMs = 180_000 }) {
  let client, root, profileId, instanceToken;
  const adapter = {
    async start(plan) {
      check(!client, "Desktop adapter already started");
      root = await validateOwnedRoot(runRoot, "desktop");
      const input = await boundFile(executable, "Kaigen executable");
      check(identity?.artifactKind === "windows-portable" && input.sha256 === identity.artifactSha256,
        "executed Desktop artifact differs from the candidate receipt identity");
      const runtimeRoot = await ordinaryPath(plan.kaigenProfileRoot, root, "directory");
      client = new KaigenProcess({ label: "qtox-desktop", executable: input.path, root: runtimeRoot,
        port: await freeLoopbackPort(), startupTimeoutMs: timeoutMs });
      await client.start();
      instanceToken = randomBytes(16).toString("hex");
      const profiles = await client.invoke("create_profile", { name: "Synthetic qTox Desktop", password: null });
      const active = profiles?.filter((profile) => profile.active && profile.loaded);
      check(active?.length === 1, "synthetic Desktop profile did not activate");
      profileId = active[0].id;
    },
    invoke: (command, args = {}, timeout) => checkedInvoke(client, command, args, timeout),
    instanceToken: () => { check(client?.isRunning(), "Desktop instance is not running"); return instanceToken; },
    async restart() {
      await stopNative(client);
      const input = await boundFile(executable, "Kaigen executable at restart");
      check(input.sha256 === identity.artifactSha256, "Desktop artifact changed before restart");
      await client.start();
      instanceToken = randomBytes(16).toString("hex");
    },
    async sendFile({ friendNumber, filePath, fileName, mime, bytes }) {
      await ordinaryPath(filePath, path.join(root, "fixtures"), "file");
      check((await readFile(filePath)).equals(bytes) && path.basename(filePath) === fileName, "outbound fixture binding changed");
      return client.invoke("send_tox_file", { profileId, friendNumber, filename: fileName, mime, bytes: Array.from(bytes) });
    },
    async readReceivedFile({ message, expectedName }) {
      check(message?.attachment?.completed === true && message.mine === false, "received Desktop row is incomplete");
      const downloads = await ordinaryPath(path.join(client.root, "downloads"), client.root, "directory");
      return copyObservedDownload(downloads, message.attachment.path, expectedName, path.join(root, "kaigen-downloads"));
    },
    async close() { if (client) await stopNative(client); },
  };
  adapter.ui = uiAdapter(() => client, (method, params) => client.cdp.send(method, params), async (destination) => {
    check(within(path.join(root, "evidence"), path.resolve(destination)), "screenshot escaped evidence root");
    await captureMasked(client, () => client.captureScreenshot(destination));
  }, timeoutMs);
  return adapter;
}

export function createWebQtoxAdapter({ runRoot, identity, chromium, browserDriver, resolveHost, tlsSpki, timeoutMs = 180_000 }) {
  let root, page, web, workspace, ChromiumPage, chromiumBinding, instanceToken, generation = 0;
  const options = { origin: "https://kaigen.test", resolveHost, tlsSpki, timeoutMs };
  async function openBrowser() {
    generation++;
    page = await launchBrowser(options, { chromium: chromiumBinding }, path.join(root, `kaigen-browser-${generation}`), ChromiumPage);
    instanceToken = randomBytes(16).toString("hex");
    await page.browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: path.join(root, "kaigen-downloads"), eventsEnabled: true });
    web = new WebCommandClient(page, identity.buildId);
  }
  async function closeBrowser() {
    web?.close();
    const child = page?.process;
    if (page) await page.close();
    check(!child || child.exitCode !== null || child.signalCode !== null, "owned Chromium process exit is unconfirmed");
    page = null; web = null;
  }
  const adapter = {
    async start(plan) {
      check(!page && !root, "Web adapter already started");
      root = await validateOwnedRoot(runRoot, "web");
      check(await ordinaryPath(plan.kaigenReceiveRoot, root, "directory") === path.join(root, "kaigen-downloads"), "Web download root binding changed");
      check(isIP(resolveHost) === 4 && /^[A-Za-z0-9+/]{43}=$/u.test(tlsSpki), "local Web host/SPKI binding is invalid");
      chromiumBinding = await boundFile(chromium, "Chromium");
      const helper = await boundFile(browserDriver, "canonical Web browser helper");
      ({ ChromiumPage } = await import(pathToFileURL(helper.path).href));
      check(typeof ChromiumPage === "function", "canonical browser helper export is unavailable");
      await openBrowser();
      workspace = await createWorkspaceAndProfile(page, web, options, identity.buildId, (created) => { workspace = created; });
    },
    invoke: (command, args = {}, timeout) => checkedInvoke(web, command, args, timeout),
    instanceToken: () => { check(page?.process?.exitCode === null && page.process.signalCode === null, "Web browser is not running"); return instanceToken; },
    async restart() {
      await closeBrowser(); await openBrowser();
      await reopenWorkspace(page, web, workspace, timeoutMs);
      await readWebIdentity(page, identity.buildId);
    },
    async sendFile({ filePath, fileName, bytes }) {
      await ordinaryPath(filePath, path.join(root, "fixtures"), "file");
      check((await readFile(filePath)).equals(bytes) && path.basename(filePath) === fileName, "outbound Web fixture binding changed");
      await adapter.ui.ensureChat();
      await page.setFile(".conversation .file-picker", filePath);
      await page.waitFor('document.querySelector(".conversation .file-confirm-overlay .send-file-button:not(:disabled)")', "Web file confirmation", timeoutMs);
      await page.click(".conversation .file-confirm-overlay .send-file-button", ["Отправить", "Send"]);
      await page.waitFor('!document.querySelector(".conversation .file-confirm-overlay")', "Web file queued", timeoutMs);
    },
    async readReceivedFile({ message, expectedName }) {
      check(message?.attachment?.completed === true && message.mine === false, "received Web row is incomplete");
      const downloads = path.join(root, "kaigen-downloads"), file = path.join(downloads, expectedName);
      await waitUntil(async () => {
        try { const info = await lstat(file); return info.isFile() && info.size === 64 * 1024 ? true : undefined; }
        catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
      }, timeoutMs, "actual browser received-file download", 100);
      return copyObservedDownload(downloads, file, expectedName, downloads);
    },
    async close() {
      try {
        if (workspace && page) {
          await reopenWorkspace(page, web, workspace, timeoutMs, false);
          await page.click(".web-menu > button");
          await page.waitFor('document.querySelector(".web-menu nav[role=menu]")', "workspace cleanup menu", 10_000);
          await page.click('.web-menu nav[role=menu] button.danger', ["Уничтожить пространство", "Destroy workspace"]);
          await page.waitFor('document.querySelector(".web-close-modal")', "owned workspace cleanup", 10_000);
          await page.click(".web-close-modal button.danger");
          await page.waitFor('document.querySelector(".web-success") && !location.hash', "owned workspace destroyed", timeoutMs);
          workspace.password = ""; workspace.workspaceUrl = ""; workspace = null;
        }
      } finally { await closeBrowser(); }
    },
  };
  adapter.ui = uiAdapter(() => page, (method, params) => page.browser.send(method, params, page.sessionId), async (destination) => {
    check(within(path.join(root, "evidence"), path.resolve(destination)), "screenshot escaped evidence root");
    await captureMasked(page, () => page.screenshot(destination));
  }, timeoutMs);
  return adapter;
}

// Only the new, installer-bound cache is accepted. No installer, registry,
// default qTox settings directory or pre-existing profile is used here.
export function createQtoxPortableProcess({ runRoot, runtimeManifest, target }) {
  let root, plan, manifest, executableEntry, executable, child, instanceToken, prepared = false;
  const running = () => child && child.exitCode === null && child.signalCode === null;
  async function verifyProgram() {
    let original;
    for (const entry of manifest.files) {
      const file = await ordinaryPath(path.join(plan.qtoxProgramRoot, entry.relativePath), plan.qtoxProgramRoot, "file");
      const observed = { bytes: (await lstat(file)).size, sha256: await sha256File(file) };
      check(observed.bytes === entry.bytes && observed.sha256 === entry.sha256, "owned qTox program file changed");
      if (entry.relativePath === "qtox.exe") original = observed;
    }
    const alias = await ordinaryPath(executable, plan.qtoxProgramRoot, "file");
    assertQtoxLaunchBindings(executableEntry, original, { bytes: (await lstat(alias)).size, sha256: await sha256File(alias) });
    const portableIni = await ordinaryPath(plan.qtoxPortableIniPath, plan.qtoxProgramRoot, "file");
    check(await readFile(portableIni, "utf8") === PORTABLE_INI, "pre-CLI qTox portable sidecar changed");
  }
  return {
    async prepare(launchPlan) {
      check(!prepared, "qTox program already prepared");
      root = await validateOwnedRoot(runRoot, target);
      plan = launchPlan;
      for (const directory of [plan.qtoxProgramRoot, plan.qtoxProfileRoot, plan.qtoxDownloadRoot]) await ordinaryPath(directory, root, "directory");
      check((await readdir(plan.qtoxProgramRoot)).length === 0 && (await readdir(plan.qtoxProfileRoot)).length === 0,
        "qTox program/profile directory is not new and empty");
      check(plan.qtoxPortableIniPath === path.join(plan.qtoxProgramRoot, "qtox.ini") && plan.qtoxPortableIniBytes === PORTABLE_INI,
        "qTox pre-CLI portable sidecar contract changed");
      const binding = await boundFile(runtimeManifest, "qTox runtime manifest");
      check(binding.path === path.join(QTOX_CACHE, "runtime-manifest.json"), "runtime manifest is outside the new pinned qTox cache");
      manifest = JSON.parse(await readFile(binding.path, "utf8"));
      assert.deepEqual(Object.keys(manifest), ["schemaVersion", "name", "version", "installerSha256", "executable", "files"]);
      check(manifest.schemaVersion === 1 && manifest.name === "qTox" && manifest.version === "1.18.5"
        && manifest.installerSha256 === QTOX_INSTALLER_SHA256 && manifest.executable === "qtox.exe", "runtime manifest installer identity changed");
      check(Array.isArray(manifest.files) && manifest.files.length > 5 && manifest.files.length < 500, "qTox program manifest is incomplete");
      const sourceRoot = await ordinaryPath(path.join(QTOX_CACHE, "runtime"), QTOX_CACHE, "directory");
      const seen = new Set();
      for (const entry of manifest.files) {
        assert.deepEqual(Object.keys(entry), ["relativePath", "bytes", "sha256"]);
        check(safeManifestRelativePath(entry.relativePath), "qTox manifest path is unsafe");
        check(!seen.has(entry.relativePath.toLowerCase()) && !/(?:^|\/)qtox\.ini$|\.(?:tox|db|log)$/iu.test(entry.relativePath), "qTox manifest includes duplicate/private state");
        seen.add(entry.relativePath.toLowerCase());
        check(Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && /^[0-9A-F]{64}$/u.test(entry.sha256), "qTox program manifest entry is invalid");
        const source = await ordinaryPath(path.join(sourceRoot, entry.relativePath), sourceRoot, "file");
        check((await lstat(source)).size === entry.bytes && await sha256File(source) === entry.sha256, "cached qTox program file changed");
        const destination = path.join(plan.qtoxProgramRoot, entry.relativePath);
        check(within(plan.qtoxProgramRoot, destination), "qTox program copy escaped its run");
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination, constants.COPYFILE_EXCL);
      }
      check(seen.has("qtox.exe"), "qTox executable is absent from program manifest");
      check(!seen.has(QTOX_LAUNCH_ALIAS), "qTox manifest collides with the owned launch alias");
      executableEntry = manifest.files.find((entry) => entry.relativePath === "qtox.exe");
      check(executableEntry, "qTox executable manifest path changed");
      await copyFile(binding.path, path.join(plan.qtoxProgramRoot, "runtime-manifest.json"), constants.COPYFILE_EXCL);
      await writeFile(plan.qtoxPortableIniPath, PORTABLE_INI, { encoding: "utf8", flag: "wx" });
      const original = await ordinaryPath(path.join(plan.qtoxProgramRoot, "qtox.exe"), plan.qtoxProgramRoot, "file");
      check((await lstat(original)).size === executableEntry.bytes && await sha256File(original) === executableEntry.sha256,
        "owned qTox original executable changed before alias copy");
      // A distinct process basename keeps native window binding separate from
      // an installed qTox shortcut while executing the exact official bytes.
      executable = path.join(plan.qtoxProgramRoot, QTOX_LAUNCH_ALIAS);
      await copyFile(original, executable, constants.COPYFILE_EXCL);
      await verifyProgram();
      prepared = true;
      return { executablePath: executable, runtimeManifestPath: path.join(plan.qtoxProgramRoot, "runtime-manifest.json") };
    },
    async start() {
      check(prepared && !running(), "qTox start requires a prepared, stopped owned program");
      await verifyProgram();
      child = spawn(executable, ["--portable", plan.qtoxProfileRoot, "--login"], {
        cwd: plan.qtoxProgramRoot, stdio: "ignore",
      });
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      instanceToken = randomBytes(16).toString("hex");
      return { instanceToken, pid: child.pid, executablePath: executable,
        runtimeManifestPath: path.join(plan.qtoxProgramRoot, "runtime-manifest.json") };
    },
    instanceToken() { check(running(), "qTox process is not running"); return instanceToken; },
    async waitForExit(timeoutMs = 30_000) {
      await waitUntil(() => running() ? undefined : true, timeoutMs, "owned qTox process exit", 100);
    },
    async kill() {
      if (running()) check(child.kill("SIGKILL"), "owned qTox process could not terminate");
      await waitUntil(() => running() ? undefined : true, 15_000, "owned qTox forced exit", 100);
    },
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  check(process.argv.length === 3 && process.argv[2] === "--self-test", "Use this module's factories from the real qTox fixture orchestrator.");
  assert.equal(within(RUNS_ROOT, path.join(RUNS_ROOT, "x/desktop")), true);
  assert.equal(within(RUNS_ROOT, path.join(RUNS_ROOT, "../private")), false);
  assert.equal(safeManifestRelativePath("libstdc++-6.dll"), true);
  assert.equal(safeManifestRelativePath("platforms/qwindows.dll"), true);
  for (const unsafe of ["../qtox.exe", "/qtox.exe", "C:/qtox.exe", "qtox.exe:stream", "plugins\\qtox.exe", "plugins//qtox.exe"]) {
    assert.equal(safeManifestRelativePath(unsafe), false);
  }
  assert.equal(COMMANDS.has("skip_pq_auto"), false);
  assert.equal(COMMANDS.has("destroy_workspace"), false);
  const expectedExecutable = { relativePath: "qtox.exe", bytes: 12, sha256: "A".repeat(64) };
  const original = { bytes: expectedExecutable.bytes, sha256: expectedExecutable.sha256 };
  const alias = { ...original };
  assert.doesNotThrow(() => assertQtoxLaunchBindings(expectedExecutable, original, alias));
  for (const changed of [{ ...alias, bytes: alias.bytes + 1 }, { ...alias, sha256: "B".repeat(64) }, undefined]) {
    assert.throws(() => assertQtoxLaunchBindings(expectedExecutable, original, changed), /launch alias changed/u);
    assert.throws(() => assertQtoxLaunchBindings(expectedExecutable, changed, alias), /original executable changed/u);
  }
  assert.throws(() => assertQtoxLaunchBindings({ ...expectedExecutable, relativePath: QTOX_LAUNCH_ALIAS }, original, alias), /manifest binding/u);
  assert.throws(() => assertQtoxLaunchBindings({ ...expectedExecutable, bytes: 0 }, original, alias), /manifest binding/u);
  for (const factory of [createDesktopQtoxAdapter, createWebQtoxAdapter]) {
    const adapter = factory({ runRoot: "unused" });
    for (const name of ["start", "invoke", "restart", "sendFile", "readReceivedFile", "instanceToken", "close"]) assert.equal(typeof adapter[name], "function");
  }
  console.log("qTox adapters: side-effect-free construction, bounded command/path, and exact original/launch-alias binding self-test PASS");
}
