import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

// No acquisition, persistent browser profile, OS changes or existing Web Lab.
// Required artifacts are selected by the caller and recorded before execution.
const sourceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  assert(key?.startsWith("--") && process.argv[index + 1], "Expected --name value");
  assert(!options.has(key), "Duplicate argument: " + key);
  options.set(key, process.argv[index + 1]);
}
const required = ["--playwright-module", "--browser-cache", "--backend-artifact",
  "--openssl-executable", "--chromium-executable", "--evidence-root"];
assert([...options.keys()].every((key) => required.includes(key) || key === "--engines"), "Unknown argument");
for (const key of required) assert(options.has(key), "Missing prerequisite: " + key);
const evidenceRoot = path.resolve(options.get("--evidence-root"));
const engines = (options.get("--engines") ?? "firefox,webkit,chromium").split(",");
assert(engines.length && new Set(engines).size === engines.length
  && engines.every((name) => ["firefox", "webkit", "chromium"].includes(name)), "Invalid engines");
assert(!await fs.stat(evidenceRoot).catch(() => null), "Evidence directory must be fresh");
await fs.mkdir(evidenceRoot, { recursive: true });
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex").toUpperCase();
const identity = async (filename) => {
  const bytes = await fs.readFile(filename);
  return { path: path.resolve(filename), bytes: bytes.length, sha256: sha256(bytes) };
};
const report = { schema: 1, startedAt: new Date().toISOString(), status: "RUNNING",
  boundary: "Windows browser engines, disposable HTTPS edge, real local webd. Retained outgoing payload copy is not Tox peer receipt or macOS Safari proof.",
  artifacts: {}, engines: [], cleanup: {} };
let backend, front, backendExit, currentBrowser, stdoutFile, stderrFile;
const logWrites = [];
const sockets = new Set();
const faults = { holdUploads: false, holdSave: false, failLock: false, held: [] };
const traffic = [];
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(predicate, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await delay(40); } while (Date.now() < deadline);
  throw new Error("Timeout: " + description);
}
async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function run(executable, args, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: environment, windowsHide: true, shell: false });
    let stdout = "", stderr = "";
    child.stdout.on("data", (bytes) => { stdout += bytes; });
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || stdout || "Exit " + code)));
  });
}
const saveReport = () => fs.writeFile(path.join(evidenceRoot, "results.json"), JSON.stringify(report, null, 2) + "\n");
function releaseHeld() {
  const held = faults.held.splice(0);
  for (const item of held) if (!item.response.destroyed && !item.request.aborted) item.forward();
}
try {
  report.sources = [];
  for (const filename of ["scripts/test-browser-engines-runtime.mjs", "scripts/fixtures/browser-engines-runtime/index.html",
    "scripts/fixtures/browser-engines-runtime/entry.tsx", "src/web/session.ts", "src/web/WebRoot.tsx", "src/web/WebRoot.css",
    "src/platform/web.ts", "src/SpellcheckComposer.tsx", "src/spellcheck.worker.ts"]) {
    const identified = await identity(path.join(sourceRoot, filename));
    report.sources.push({ ...identified, path: filename });
  }
  for (const [key, label] of [["--playwright-module", "playwright"], ["--backend-artifact", "webd"],
    ["--openssl-executable", "openssl"], ["--chromium-executable", "chromium"]]) {
    report.artifacts[label] = await identity(options.get(key));
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.resolve(options.get("--browser-cache"));
  const playwright = await import(pathToFileURL(options.get("--playwright-module")).href);
  for (const name of engines) report.artifacts[name] = await identity(name === "chromium"
    ? options.get("--chromium-executable") : playwright[name].executablePath());
  const require = createRequire(path.join(sourceRoot, "package.json"));
  report.playwrightVersion = require(path.join(path.dirname(options.get("--playwright-module")), "package.json")).version;
  process.env.NODE_ENV = "production";
  const { build } = await import(pathToFileURL(require.resolve("vite")).href);
  const react = (await import(pathToFileURL(require.resolve("@vitejs/plugin-react")).href)).default;
  const dist = path.join(evidenceRoot, "dist");
  const buildId = "regression-audit-p12";
  await build({ configFile: false, root: sourceRoot, mode: "web", logLevel: "warn",
    plugins: [react()], publicDir: path.join(sourceRoot, "public"),
    resolve: { dedupe: ["react", "react-dom"], alias: {
      "@kaigen/platform": path.join(sourceRoot, "src/platform/web.ts"),
      "@kaigen/theme": path.join(sourceRoot, "src/theme.tsx"),
    } },
    define: { __KAIGEN_PRODUCT__: JSON.stringify("web"), __KAIGEN_WEB_BUILD_ID__: JSON.stringify(buildId) },
    build: { outDir: dist, emptyOutDir: false,
      rolldownOptions: { input: path.join(sourceRoot, "scripts/fixtures/browser-engines-runtime/index.html") } },
  });
  const keyFile = path.join(evidenceRoot, "tls-key.pem"), certFile = path.join(evidenceRoot, "tls-cert.pem");
  await run(options.get("--openssl-executable"), ["req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", keyFile, "-out", certFile]);
  const backendPort = await availablePort(), frontPort = await availablePort();
  const origin = "https://127.0.0.1:" + frontPort;
  const stateRoot = path.join(evidenceRoot, "disposable-state");
  report.ports = { backendPort, frontPort };
  const environment = { ...process.env, KAIGEN_WEB_BIND: "127.0.0.1:" + backendPort,
    KAIGEN_WEB_ORIGIN: origin, KAIGEN_WEB_DEPLOYMENT_MODE: "service",
    KAIGEN_WEB_DATA_ROOT: path.join(stateRoot, "disk"), KAIGEN_WEB_RAM_ROOT: path.join(stateRoot, "ram"),
    KAIGEN_WEB_ACTIVE_ROOT: path.join(stateRoot, "active"), KAIGEN_WEB_RESOURCE_ROOT: path.join(stateRoot, "resources"),
    KAIGEN_WEB_PROOF_DIFFICULTY: "12", KAIGEN_WEB_MAX_INSTANCES: "8" };
  backend = spawn(options.get("--backend-artifact"), [], { env: environment, windowsHide: true, shell: false });
  backendExit = new Promise((resolve) => { backend.once("error", (error) => resolve({ error: String(error) }));
    backend.once("exit", (code, signal) => resolve({ code, signal })); });
  report.backendPid = backend.pid;
  stdoutFile = await fs.open(path.join(evidenceRoot, "backend.stdout.log"), "w");
  stderrFile = await fs.open(path.join(evidenceRoot, "backend.stderr.log"), "w");
  backend.stdout.on("data", (bytes) => { logWrites.push(stdoutFile.write(bytes)); });
  backend.stderr.on("data", (bytes) => { logWrites.push(stderrFile.write(bytes)); });
  await waitFor(() => new Promise((resolve) => {
    const socket = net.connect(backendPort, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  }), "backend listening");
  const csp = "default-src 'none'; base-uri 'none'; connect-src 'self'; font-src 'self' data:; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' blob: data:; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; script-src 'self'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; worker-src 'self'; require-trusted-types-for 'script'; trusted-types kaigen-spellcheck-worker";
  const contentTypes = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
  front = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, async (request, response) => {
    const pathname = new URL(request.url, origin).pathname;
    if (pathname === "/api/v1/build-identity") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ status: "ok", buildId })); return;
    }
    if (pathname.startsWith("/api/")) {
      const item = { path: pathname, method: request.method,
        position: Number(request.headers["x-kaigen-transfer-position"] ?? -1) };
      traffic.push(item);
      const forward = () => {
        const upstream = http.request({ host: "127.0.0.1", port: backendPort, path: request.url,
          method: request.method, headers: request.headers }, (incoming) => {
          item.status = incoming.statusCode;
          response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
        });
        upstream.once("error", () => { if (!response.destroyed) { response.writeHead(502); response.end(); } });
        response.once("close", () => { if (!response.writableEnded) upstream.destroy(); });
        request.pipe(upstream);
      };
      if (faults.failLock && pathname === "/api/v1/workspaces/lock") {
        faults.failLock = false; item.injected = "lock-503"; item.status = 503;
        response.writeHead(503, { "Content-Type": "application/json" }); response.end('{"code":"FIXTURE_LOCK_FAILURE"}'); return;
      }
      if (faults.holdUploads && pathname === "/api/v1/transfers/upload" && item.position > 0
        || faults.holdSave && pathname === "/api/v1/commands/save_local_state") {
        item.held = true; faults.held.push({ request, response, forward, item }); return;
      }
      forward(); return;
    }
    try {
      const relative = pathname === "/" ? "scripts/fixtures/browser-engines-runtime/index.html" : decodeURIComponent(pathname).slice(1);
      const filename = path.resolve(dist, relative);
      assert(filename.startsWith(dist + path.sep), "Static path outside fixture");
      const bytes = await fs.readFile(filename);
      response.writeHead(200, { "Content-Type": contentTypes[path.extname(filename)] ?? "application/octet-stream",
        "Content-Security-Policy": csp, "Cache-Control": "no-store" });
      response.end(bytes);
    } catch { response.writeHead(404); response.end(); }
  });
  front.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  front.on("upgrade", (request, socket, head) => {
    const upstream = http.request({ host: "127.0.0.1", port: backendPort, path: request.url,
      headers: request.headers, method: "GET" });
    upstream.on("upgrade", (response, peer, peerHead) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n" + Object.entries(response.headers)
        .map(([name, value]) => name + ": " + value).join("\r\n") + "\r\n\r\n");
      if (peerHead.length) socket.write(peerHead);
      if (head.length) peer.write(head);
      peer.pipe(socket); socket.pipe(peer);
      socket.once("close", () => peer.destroy()); peer.once("close", () => socket.destroy());
    });
    upstream.once("error", () => socket.destroy()); upstream.end();
  });
  await new Promise((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
  for (const name of engines) {
    const trafficStart = traffic.length;
    const result = { engine: name, startedAt: new Date().toISOString(), status: "RUNNING", checks: [], pageErrors: [], cspViolations: [] };
    report.engines.push(result);
    const check = (label, condition, evidence) => {
      result.checks.push({ name: label, passed: Boolean(condition), evidence });
      assert(condition, name + ": " + label);
    };
    console.log("ENGINE_START " + name);
    currentBrowser = await playwright[name].launch({ headless: true, timeout: 20000,
      ...(name === "chromium" ? { executablePath: options.get("--chromium-executable") } : {}) });
    result.version = currentBrowser.version();
    const context = await currentBrowser.newContext({ ignoreHTTPSErrors: true, locale: "en-US", acceptDownloads: true });
    await context.exposeBinding("__engineCSP", (_source, violation) => result.cspViolations.push(violation));
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const external = [];
    result.failedRequests = [];
    result.downloadRanges = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) external.push(url.origin);
      if (url.pathname === "/api/v1/transfers/download") {
        const body = request.postDataJSON(); result.downloadRanges.push({ position: body.position, length: body.length });
      }
    });
    page.on("requestfailed", (request) => result.failedRequests.push({ path: new URL(request.url()).pathname,
      failure: request.failure()?.errorText }));
    page.on("pageerror", (error) => result.pageErrors.push(error.message));
    await page.addInitScript(() => {
      globalThis.__ENGINE_CSP__ = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        const violation = { directive: event.effectiveDirective, blocked: event.blockedURI.split("?")[0] };
        globalThis.__ENGINE_CSP__.push(violation); void globalThis.__engineCSP(violation);
      });
    });
    const evalSession = (fn, arg) => page.evaluate(fn, arg);
    await page.goto(origin);
    await page.getByRole("button", { name: "en", exact: true }).click();
    await page.getByRole("heading", { name: "New private workspace" }).waitFor();
    const password = "Fixture-" + randomBytes(12).toString("hex");
    await page.getByRole("button", { name: /^On disk/ }).click();
    await page.getByLabel("Workspace access password", { exact: true }).fill(password);
    await page.getByLabel("Repeat access password").fill(password);
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await page.locator(".web-shell").waitFor({ timeout: 180000 });
    const identifier = await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.getIdentifier());
    check("real initializer/password authentication", identifier.length >= 40
      && traffic.slice(trafficStart).some((item) => item.path === "/api/v1/auth/password" && item.status === 200));
    const keyState = await evalSession(async () => {
      const database = await new Promise((resolve, reject) => { const request = indexedDB.open("kaigen-browser-auth-v1", 1);
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const records = await new Promise((resolve, reject) => { const request = database.transaction("device-keys").objectStore("device-keys").getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      database.close();
      const record = records[0];
      const exported = record ? await crypto.subtle.exportKey("jwk", record.privateKey).then(() => true, () => false) : true;
      return { count: records.length, privateType: record?.privateKey.type, extractable: record?.privateKey.extractable,
        usages: record?.privateKey.usages, exported, algorithm: record?.privateKey.algorithm.name,
        storedSecrets: JSON.stringify([Object.values(localStorage), Object.values(sessionStorage)]) };
    });
    check("native IndexedDB nonextractable CryptoKey", keyState.count === 1 && keyState.privateType === "private"
      && keyState.algorithm === "ECDSA" && keyState.extractable === false && keyState.exported === false
      && keyState.usages.includes("sign") && !keyState.storedSecrets.includes(password), { ...keyState, storedSecrets: undefined });
    await page.reload();
    await page.locator(".web-shell").waitFor();
    check("reload signs real device challenge", await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.getIdentifier()) === identifier
      && traffic.slice(trafficStart).some((item) => item.path === "/api/v1/auth/device" && item.status === 200));
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.socket?.readyState === WebSocket.OPEN);
    check("real authenticated backend WebSocket opens", true);
    await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.showWorker());
    const editor = page.locator("#engine-worker-probe [contenteditable=true]");
    await editor.fill("🙂 engine mispelledd sample");
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.trace.workers.some((worker) =>
      worker.messages.some((message) => message.type === "checked" && message.results?.some((word) => !word.correct))));
    const workerState = await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.trace.workers.map((worker) => ({
      messages: worker.messages.map((message) => message.type), errors: worker.errors, url: new URL(worker.url, location.href).pathname,
      misspelled: worker.messages.flatMap((message) => message.type === "checked" ? message.results.filter((word) => !word.correct) : []),
    })));
    await editor.press("Enter");
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.trace.sent.length === 1);
    check("native Worker real Hunspell and UTF-16 composer send", await evalSession(() =>
      globalThis.__KAIGEN_ENGINE_FIXTURE__.trace.sent[0]) === "🙂 engine mispelledd sample"
      && workerState.some((worker) => worker.messages.includes("ready") && worker.messages.includes("checked") && worker.errors === 0), workerState);
    await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.hideWorker());
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.trace.workers.every((worker) => worker.terminated));
    check("Worker owner teardown terminates native process", true);
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    const clipboardOutcome = await page.locator(".web-lease-icon").last().getAttribute("aria-label");
    await waitFor(async () => ["Link copied", "Could not copy link"].includes(await page.locator(".web-lease-icon").last().getAttribute("aria-label")), "native clipboard outcome");
    check("native clipboard permission outcome is visible", true, { outcome: await page.locator(".web-lease-icon").last().getAttribute("aria-label"),
      initialOutcome: clipboardOutcome });
    if (name === "chromium") {
      await context.grantPermissions([], { origin });
      await page.locator(".web-lease-icon").last().click();
      await page.getByRole("button", { name: "Could not copy link", exact: true }).waitFor();
      check("native Chromium denied clipboard permission is handled", true);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
      await page.locator(".web-lease-icon").last().click();
      await page.getByRole("button", { name: "Link copied", exact: true }).waitFor();
      check("native Chromium granted clipboard preserves exact link", await evalSession(async () =>
        await navigator.clipboard.readText() === location.href));
      await context.clearPermissions();
    }
    await evalSession(() => { globalThis.__ENGINE_CLIPBOARD_DESCRIPTOR__ = Object.getOwnPropertyDescriptor(Navigator.prototype, "clipboard");
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined }); });
    await page.locator(".web-lease-icon").last().click();
    await page.getByRole("button", { name: "Could not copy link", exact: true }).waitFor();
    check("missing clipboard preserves active workspace", await evalSession(() =>
      globalThis.__KAIGEN_ENGINE_FIXTURE__.session.getWorkspace() !== null));
    await evalSession(() => { delete navigator.clipboard; });
    const profile = await evalSession(async () => {
      const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
      const first = await session.command("create_profile", { name: "Engine source", password: null });
      const a = first.profiles[0].id;
      await session.command("set_profile_user_status", { profileId: a, status: "offline" });
      const second = await session.command("create_profile", { name: "Engine recipient", password: null });
      const b = second.profiles.find((item) => item.id !== a).id;
      await session.command("set_profile_user_status", { profileId: b, status: "offline" });
      const toxId = await session.command("get_tox_id", { profileId: b });
      await session.command("switch_profile", { profileId: a });
      const friend = await session.command("add_tox_friend", { profileId: a, toxId, message: "Disposable engine fixture" });
      return { id: a, friendNumber: friend, toxId: await session.command("get_tox_id", { profileId: a }) };
    });
    const capability = await evalSession(async () => {
      if (!navigator.storage?.getDirectory) return { directory: false, asyncWriter: false };
      const root = await navigator.storage.getDirectory();
      const file = await root.getFileHandle("engine-capability", { create: true });
      const asyncWriter = typeof file.createWritable === "function";
      if (asyncWriter) { const writer = await file.createWritable(); await writer.write(new Uint8Array([17, 29, 41])); await writer.close(); }
      const bytes = Array.from(new Uint8Array(await (await file.getFile()).arrayBuffer()));
      await root.removeEntry("engine-capability");
      return { directory: true, asyncWriter, bytes };
    });
    result.storageCapability = capability;
    const size = 2 * 1024 * 1024 + 37;
    const payload = Buffer.from(Array.from({ length: size }, (_, index) => (index * 131 + 17) % 256));
    const payloadSha = sha256(payload);
    let transfer;
    const begins = traffic.filter((item) => item.path === "/api/v1/transfers/outgoing").length;
    if (capability.asyncWriter) {
      faults.holdUploads = true;
      const transferResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/v1/transfers/outgoing" && response.status() === 200);
      await evalSession(async ({ profile, size }) => {
        const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 131 + 17) % 256);
        await globalThis.__KAIGEN_ENGINE_FIXTURE__.session.sendBrowserFile(profile.id, profile.friendNumber,
          new File([bytes], "engine-retained.png", { type: "image/png" }));
      }, { profile, size });
      transfer = await (await transferResponse).json();
      await waitFor(() => faults.held.some((item) => item.item.path === "/api/v1/transfers/upload"), "nonzero committed upload checkpoint");
      const partial = await evalSession((id) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.transferStatus(id), transfer.id);
      check("OPFS source exists before real begin/upload", partial.uploadedBytes > 0 && partial.uploadedBytes < size
        && await evalSession(async (transfer) => {
          const stored = await globalThis.__KAIGEN_ENGINE_FIXTURE__.session.readTransferCache(transfer);
          return stored?.size === transfer.sizeBytes;
        }, partial), { uploadedBytes: partial.uploadedBytes, size });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".web-shell").waitFor();
      faults.holdUploads = false; releaseHeld();
      await waitFor(async () => (await evalSession((id) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.transferStatus(id), transfer.id)).payloadCommitted, "reload upload recovery", 30000);
      transfer = await evalSession((id) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.transferStatus(id), transfer.id);
      check("reload recovers exact native operation and OPFS bytes", transfer.uploadedBytes === size
        && transfer.payloadSha256 === Buffer.from(payloadSha, "hex").toString("base64url")
        && traffic.filter((item) => item.path === "/api/v1/transfers/outgoing").length === begins + 1,
        { uploadedBytes: transfer.uploadedBytes, sha256: payloadSha, preservedOperation: true });
      await evalSession(async ({ transfer, size }) => {
        const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
        const root = await session.transferCacheDirectory(true);
        const handle = await root.getFileHandle(session.transferCacheName(transfer.operationId), { create: true });
        const writer = await handle.createWritable();
        await writer.write(Uint8Array.from({ length: Math.floor(size / 3) }, (_, index) => (index * 131 + 17) % 256));
        await writer.close();
      }, { transfer, size });
    } else {
      const failedSource = await evalSession(async ({ profile, size }) => {
        const file = new File([Uint8Array.from({ length: size }, (_, index) => (index * 131 + 17) % 256)], "engine-retained.png", { type: "image/png" });
        const before = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer())));
        let error = ""; try { await globalThis.__KAIGEN_ENGINE_FIXTURE__.session.sendBrowserFile(profile.id, profile.friendNumber, file); }
        catch (value) { error = String(value); }
        return { error, preserved: before.join(",") === Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))).join(",") };
      }, { profile, size });
      check("unsupported outgoing storage preserves caller file before begin", failedSource.error.includes("TRANSFER_BROWSER_STORAGE_REQUIRED") && failedSource.preserved
        && traffic.filter((item) => item.path === "/api/v1/transfers/outgoing").length === begins, failedSource);
      // Prepare a retained native payload through real authenticated endpoints.
      // This bypasses only browser source staging, not webd or the copy under test.
      transfer = await evalSession(async ({ profile, size }) => {
        const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
        const bytes = Uint8Array.from({ length: size }, (_, index) => (index * 131 + 17) % 256);
        const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        const encode = (value) => btoa(String.fromCharCode(...value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const initial = await session.request("/api/v1/transfers/outgoing", { method: "POST", body: JSON.stringify({
          profileId: profile.id, friendNumber: profile.friendNumber, filename: "engine-retained.png",
          mime: "image/png", sizeBytes: size, operationId: encode(crypto.getRandomValues(new Uint8Array(24))), sha256: encode(digestBytes),
        }) }, true);
        return session.pumpOutgoingTransfer(initial, new Blob([bytes], { type: "image/png" }));
      }, { profile, size });
      check("real backend retained payload prepared for missing-writer fallback", transfer.payloadCommitted && transfer.uploadedBytes === size);
    }
    async function verifyDownload(label) {
      const downloadPromise = page.waitForEvent("download");
      void downloadPromise.catch(() => {});
      await evalSession((transfer) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.downloadTransfer(
        transfer.profileId, transfer.messageId, transfer.id), transfer);
      const download = await downloadPromise;
      const filename = path.join(evidenceRoot, name + "-" + label + ".payload");
      await download.saveAs(filename);
      const bytes = await fs.readFile(filename);
      check(label, bytes.length === size && sha256(bytes) === payloadSha, { bytes: bytes.length, sha256: sha256(bytes) });
    }
    await verifyDownload(capability.asyncWriter ? "native OPFS partial copy recovery" : "native missing-OPFS memory fallback");
    if (capability.asyncWriter) {
      check("native retained-copy resumes at exact OPFS prefix", result.downloadRanges[0]?.position === Math.floor(size / 3), result.downloadRanges[0]);
      const cached = await evalSession(async (transfer) => {
        const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
        const root = await session.transferCacheDirectory(true);
        const handle = await root.getFileHandle(session.transferCacheName(transfer.operationId));
        globalThis.__ENGINE_WRITER_PROTO__ = Object.getPrototypeOf(handle);
        globalThis.__ENGINE_WRITER_DESCRIPTOR__ = Object.getOwnPropertyDescriptor(globalThis.__ENGINE_WRITER_PROTO__, "createWritable");
        Object.defineProperty(globalThis.__ENGINE_WRITER_PROTO__, "createWritable", { configurable: true, value: undefined });
        return (await handle.getFile()).size;
      }, transfer);
      await verifyDownload("absent async writer memory fallback preserves bytes");
      check("missing writer preserves existing OPFS copy", cached === size && await evalSession(async (transfer) => {
        const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
        return (await session.readTransferCache(transfer))?.size === transfer.sizeBytes;
      }, transfer));
      await evalSession(() => Object.defineProperty(globalThis.__ENGINE_WRITER_PROTO__, "createWritable", globalThis.__ENGINE_WRITER_DESCRIPTOR__));
    }
    await evalSession(() => {
      if (navigator.storage) Object.defineProperty(navigator.storage, "getDirectory", { configurable: true, value: undefined });
    });
    await verifyDownload("absent OPFS memory fallback preserves bytes");
    const retained = await evalSession((id) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.transferStatus(id), transfer.id);
    check("fallback preserves native retained payload without receipt cleanup", retained.payloadCommitted && retained.downloadAvailable
      && retained.uploadedBytes === size && retained.payloadSha256 === transfer.payloadSha256);
    await evalSession(() => { if (navigator.storage) delete navigator.storage.getDirectory; });
    faults.failLock = true;
    await page.getByRole("button", { name: /^Session management/ }).click();
    await page.getByRole("menuitem", { name: "Lock session", exact: true }).click();
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.sessionLifecycle === "active");
    await waitFor(() => !faults.failLock, "lock fault consumed");
    check("failed native lock request keeps UI/auth/retained data", await page.locator(".web-shell").count() === 1
      && (await evalSession((id) => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.transferStatus(id), transfer.id)).payloadCommitted);
    faults.holdSave = true;
    await evalSession((profileId) => {
      globalThis.__ENGINE_SAVE__ = globalThis.__KAIGEN_ENGINE_FIXTURE__.session.command("save_local_state",
        { profileId, state: { engineFixture: true } }).then(() => ({ success: true }), (error) => ({ error: String(error) }));
    }, profile.id);
    await waitFor(() => faults.held.some((item) => item.item.path === "/api/v1/commands/save_local_state"), "pending persistence command");
    const locksBefore = traffic.filter((item) => item.path === "/api/v1/workspaces/lock").length;
    await page.getByRole("button", { name: /^Session management/ }).click();
    await page.getByRole("menuitem", { name: "Lock session", exact: true }).click();
    await page.waitForFunction(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.sessionLifecycle === "tearing-down");
    check("teardown drains admitted persistence before native revocation", traffic.filter((item) => item.path === "/api/v1/workspaces/lock").length === locksBefore
      && await page.locator(".web-app-window[inert]").count() === 1);
    faults.holdSave = false; releaseHeld();
    await page.getByRole("heading", { name: "Open Kaigen workspace" }).waitFor();
    const closed = await evalSession(async () => {
      const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
      let late = ""; try { await session.command("load_layout_state"); } catch (error) { late = String(error); }
      const database = await new Promise((resolve) => { const request = indexedDB.open("kaigen-browser-auth-v1", 1); request.onsuccess = () => resolve(request.result); });
      const count = await new Promise((resolve) => { const request = database.transaction("device-keys").objectStore("device-keys").count(); request.onsuccess = () => resolve(request.result); });
      database.close();
      return { lifecycle: session.sessionLifecycle, workspace: session.getWorkspace(), socket: session.socket,
        realtime: session.realtimeActive, keys: count, late, saved: await globalThis.__ENGINE_SAVE__, consumed: session.consumedTransfers.size,
        cachedFiles: await session.transferCacheDirectory(false).then(async (directory) => {
          let count = 0; for await (const _entry of directory.values()) count++; return count;
        }, () => 0) };
    });
    check("actual lock clears keys/realtime and rejects late work", closed.lifecycle === "closed" && closed.workspace === null
      && closed.socket === null && closed.realtime === false && closed.keys === 0 && closed.late.includes("SESSION_NOT_ACTIVE")
      && closed.saved.success && closed.consumed === 0 && closed.cachedFiles === 0, closed);
    await page.getByLabel("Workspace access password", { exact: true }).fill("Wrong-fixture-password");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.locator(".web-error").waitFor();
    check("wrong password rejected by real backend", await page.locator(".web-shell").count() === 0);
    await page.getByLabel("Workspace access password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.locator(".web-shell").waitFor();
    check("correct password reopens preserved native profile", (await evalSession(() =>
      globalThis.__KAIGEN_ENGINE_FIXTURE__.session.command("get_startup_state"))).profiles.some((item) => item.id === profile.id));
    const persisted = await evalSession(async (profile) => {
      const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session;
      await session.command("unlock_profile", { profileId: profile.id, password: "" });
      const toxId = await session.command("get_tox_id", { profileId: profile.id });
      const state = await session.command("load_local_state", { profileId: profile.id });
      return { sameToxId: toxId === profile.toxId, canary: (typeof state === "string" ? JSON.parse(state) : state)?.engineFixture === true };
    }, profile);
    check("native profile bytes and drained persistence survive reopen", persisted.sameToxId && persisted.canary, persisted);
    await evalSession(() => window.dispatchEvent(new Event("kaigen:web-close-request")));
    await page.getByRole("heading", { name: "Open Kaigen workspace" }).waitFor();
    check("actual close returns auth UI", await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.session.sessionLifecycle) === "closed");
    await page.getByLabel("Workspace access password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.locator(".web-shell").waitFor();
    await page.getByRole("button", { name: /^Session management/ }).click();
    await page.getByRole("menuitem", { name: "Destroy workspace", exact: true }).click();
    await page.locator(".web-close-modal").getByRole("button", { name: "Destroy workspace", exact: true }).click();
    await page.getByRole("heading", { name: "New private workspace" }).waitFor();
    check("actual destroy deletes native workspace and fragment", !new URL(page.url()).hash && await evalSession(async (identifier) => {
      const session = globalThis.__KAIGEN_ENGINE_FIXTURE__.session; session.setIdentifier(identifier);
      const lookup = await session.lookupWorkspace(); session.setIdentifier(""); return !lookup.exists;
    }, identifier));
    check("production CSP / page errors / external browser requests", result.cspViolations.length === 0 && result.pageErrors.length === 0
      && external.length === 0, { csp: result.cspViolations, errors: result.pageErrors, external });
    await evalSession(() => globalThis.__KAIGEN_ENGINE_FIXTURE__.unmount());
    await context.close(); await currentBrowser.close(); currentBrowser = null;
    result.status = "PASS"; result.finishedAt = new Date().toISOString();
    console.log("ENGINE_PASS " + name + " " + result.checks.length);
    await saveReport();
  }
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error);
  const current = report.engines.at(-1); if (current?.status === "RUNNING") { current.status = "FAIL"; current.error = report.error; }
  process.exitCode = 1; console.error(report.error);
} finally {
  faults.holdUploads = false; faults.holdSave = false; releaseHeld();
  if (currentBrowser) { await currentBrowser.close().catch(() => {}); currentBrowser = null; }
  report.cleanup.browserClosed = true;
  for (const socket of sockets) socket.destroy();
  if (front) { await new Promise((resolve) => front.close(resolve)); report.cleanup.httpsClosed = true; }
  if (backend && backend.exitCode === null) backend.kill();
  if (backendExit) report.cleanup.backendExit = await backendExit;
  await Promise.all(logWrites);
  await stdoutFile?.close(); await stderrFile?.close();
  if (report.ports) {
    report.cleanup.portsReleased = await Promise.all(Object.values(report.ports).map((port) =>
      new Promise((resolve) => { const server = net.createServer(); server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true))); })));
  }
  // Delete only canonical disposable-state under this newly created evidence directory.
  const stateRoot = path.join(evidenceRoot, "disposable-state");
  const realEvidence = await fs.realpath(evidenceRoot), realState = await fs.realpath(stateRoot).catch(() => null);
  if (realState) { assert(realState === path.join(realEvidence, "disposable-state"), "Unexpected disposable root");
    await fs.rm(realState, { recursive: true, force: true }); }
  report.cleanup.disposableStateRemoved = !await fs.stat(stateRoot).catch(() => null);
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(evidenceRoot, "traffic.json"), JSON.stringify(traffic, null, 2) + "\n");
  await saveReport();
  console.log("BROWSER_ENGINES_" + report.status);
}
