import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync, inflateSync } from "node:zlib";

const repository = path.resolve(import.meta.dirname, "..");
const taskRoot = path.resolve(repository, "..", "context.local", "work", "20260908-pq-forward-secrecy");
const runsRoot = path.join(taskRoot, "two-instance-runs");
const EXPECTED_PQ_PROTOCOL_VERSION = 2;
const PQ_FAULT_FEATURE = "pq-fault-tests";
const PQ_FAULT_SCHEMA_VERSION = 2;
const PQ_FAULT_STAGES = Object.freeze([
  "offer",
  "accept",
  "finish",
  "ready",
  "commit",
  "done",
  "data",
  "ack",
  "close",
  "close_ready",
  "close_commit",
  "close_ack",
]);
const PQ_ROTATION_FAULT_STAGES = Object.freeze([
  "refresh", "offer", "accept", "finish", "ready", "commit", "done", "data", "ack", "retire",
]);
const HANDSHAKE_FAULT_TARGET = Object.freeze({
  offer: "alpha",
  accept: "beta",
  finish: "alpha",
  ready: "beta",
  commit: "alpha",
  done: "beta",
});
function rotationFaultRoles(stage, coordinatorLabel) {
  check(PQ_ROTATION_FAULT_STAGES.includes(stage), "unknown in-place rotation stage");
  check(["alpha", "beta"].includes(coordinatorLabel), "invalid rotation coordinator label");
  const receiverLabel = coordinatorLabel === "alpha" ? "beta" : "alpha";
  return {
    coordinatorLabel,
    senderLabel: coordinatorLabel,
    receiverLabel,
    targetLabel: ["offer", "finish", "commit", "data", "retire"].includes(stage) ? coordinatorLabel : receiverLabel,
  };
}

const RETRYABLE_SEND_ERRORS = new Set([
  "PQ_AUTO_ALREADY_NEGOTIATING",
  "PQ_OUTBOX_BACKPRESSURE",
  "PQ_SESSION_WAIT",
]);
const PROTECTED_STATES = new Set(["active", "closing", "closing_commit", "closing_ack", "closing_final"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PQ_USER_DECISION_COMMANDS = new Set([
  "request_pq_session", "accept_pq_session", "withdraw_pq_session",
  "reject_pq_session", "request_pq_shutdown", "skip_pq_auto",
]);

function requireAutomaticPqCommand(command) {
  check(!PQ_USER_DECISION_COMMANDS.has(command), "unilateral first-send proof forbids manual PQ decisions");
}

function syntheticPeerFirstPng() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = y * 65 + 1 + x * 4;
      pixels.set((x + y) % 2 ? [40, 170, 190, 255] : [20, 45, 60, 255], offset);
    }
  }
  const chunk = (kind, contents) => {
    const result = Buffer.alloc(contents.length + 12);
    result.writeUInt32BE(contents.length, 0);
    result.write(kind, 4, 4, "ascii");
    contents.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, 8 + contents.length)), 8 + contents.length);
    return result;
  };
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class HarnessInvariantError extends Error {}

class NativeCommandError extends Error {
  constructor(command, code) {
    super(`${command} failed: ${code}`);
    this.name = "NativeCommandError";
    this.command = command;
    this.code = code;
  }
}

function usage() {
  return `Usage:
  node scripts/test-pq-two-instances.mjs --artifact-root <fresh-portable-dir> [--exe <Kaigen.exe>] [options]

Options:
  --run-root <new-dir>          Exact new run directory below ${runsRoot}
  --timeout-ms <ms>            Per network/recovery gate, 30000..600000 (default 180000)
  --startup-timeout-ms <ms>    Per process startup gate, 10000..180000 (default 60000)
  --debug-ports <alpha,beta>   Fixed loopback CDP ports; otherwise two free ports are selected
  --fault-stages               Require pq-fault-tests: 12 session/queue cuts plus 10 in-place rotation cuts
  --fault-total-timeout-ms <ms> Overall exact-stage matrix budget, 300000..3600000 (default 1800000)
  --offline-first-ordinary     Verify first offline ordinary queues, process restart and no late automatic PQ
  --offline-peer-first <kind>  Only beta first sends offline text|image; alpha's first online reply must activate PQ
  --keep-profiles              Keep disposable profile roots after the run for a local retry
  --self-test                  Validate harness safety/helpers without launching Kaigen
  --help                       Show this text

The artifact is read only. Synthetic profiles, receipts and screenshots are created only
inside the unique run root. By default profile/key material is removed after both processes exit;
the sanitized receipt and redacted screenshots remain.`;
}

function parseInteger(value, minimum, maximum, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = {
    artifactRoot: "",
    exe: "",
    runRoot: "",
    timeoutMs: 180_000,
    startupTimeoutMs: 60_000,
    debugPorts: null,
    faultStages: false,
    faultTotalTimeoutMs: 1_800_000,
    offlineFirstOrdinary: false,
    offlinePeerFirst: null,
    keepProfiles: false,
    selfTest: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const take = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };
    if (argument === "--artifact-root") options.artifactRoot = take();
    else if (argument === "--exe") options.exe = take();
    else if (argument === "--run-root") options.runRoot = take();
    else if (argument === "--timeout-ms") options.timeoutMs = parseInteger(take(), 30_000, 600_000, argument);
    else if (argument === "--startup-timeout-ms") options.startupTimeoutMs = parseInteger(take(), 10_000, 180_000, argument);
    else if (argument === "--debug-ports") {
      const ports = take().split(",").map((value) => parseInteger(value, 1_024, 65_535, argument));
      if (ports.length !== 2 || ports[0] === ports[1]) throw new Error(`${argument} requires two different ports`);
      options.debugPorts = ports;
    } else if (argument === "--keep-profiles") options.keepProfiles = true;
    else if (argument === "--fault-stages") options.faultStages = true;
    else if (argument === "--fault-total-timeout-ms") options.faultTotalTimeoutMs = parseInteger(take(), 300_000, 3_600_000, argument);
    else if (argument === "--offline-first-ordinary") options.offlineFirstOrdinary = true;
    else if (argument === "--offline-peer-first") {
      const kind = take();
      if (!["text", "image"].includes(kind)) throw new Error(`${argument} requires text or image`);
      if (options.offlinePeerFirst !== null) throw new Error(`${argument} may only be selected once`);
      options.offlinePeerFirst = kind;
    }
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.offlineFirstOrdinary && options.faultStages) throw new Error("Offline first-send and exact PQ fault stages require separate fresh runs");
  if (options.offlinePeerFirst && (options.offlineFirstOrdinary || options.faultStages)) {
    throw new Error("Unilateral offline first-send, bilateral ordinary first-send and exact fault stages require separate fresh runs");
  }
  return options;
}

function isWithin(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function requireWithin(parent, candidate, label) {
  if (!isWithin(parent, candidate)) throw new Error(`${label} must stay inside the dedicated PQ two-instance runs directory`);
}

function sanitizeDiagnostic(value, replacements = []) {
  let text = String(value ?? "unknown error");
  for (const [raw, replacement] of replacements) {
    if (!raw) continue;
    text = text.split(String(raw)).join(replacement);
  }
  return text
    .replace(/\b[0-9a-f]{64,76}\b/giu, "[redacted-id]")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu, "[redacted-operation]")
    .slice(0, 1_000);
}

function check(condition, message) {
  if (!condition) throw new HarnessInvariantError(message);
}

async function waitUntil(read, timeoutMs, label, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) {
      if (error instanceof HarnessInvariantError) throw error;
      lastError = sanitizeDiagnostic(error?.message ?? error);
    }
    await delay(intervalMs);
  }
  throw new Error(`${label} timed out${lastError ? `; last=${lastError}` : ""}`);
}

async function within(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function sha256File(file) {
  const digest = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return digest.digest("hex").toUpperCase();
}

async function readJsonIfPresent(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function validateFaultSupport(support, nonce, label) {
  check(support?.schemaVersion === PQ_FAULT_SCHEMA_VERSION, `${label} PQ fault hook schema was not supported`);
  check(support?.nonce === nonce, `${label} PQ fault hook nonce did not match this disposable run`);
  check(support?.supported === true && support?.feature === PQ_FAULT_FEATURE, `${label} artifact was not built with --features ${PQ_FAULT_FEATURE}`);
  check(Array.isArray(support?.stages), `${label} PQ fault hook did not publish its supported stages`);
  check(
    JSON.stringify(support.stages) === JSON.stringify(PQ_FAULT_STAGES),
    `${label} PQ fault hook stage contract did not exactly match the harness`,
  );
  check(JSON.stringify(support.rotationStages) === JSON.stringify(PQ_ROTATION_FAULT_STAGES),
    `${label} PQ in-place rotation hook contract did not exactly match the harness`);
  return {
    schemaVersion: support.schemaVersion,
    supported: true,
    feature: support.feature,
    stages: [...support.stages],
  };
}

async function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function fetchJson(url, timeoutMs = 1_000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`loopback DevTools returned HTTP ${response.status}`);
  return response.json();
}

async function connectCdp(url, timeoutMs = 5_000) {
  const endpoint = new URL(url);
  check(["127.0.0.1", "localhost", "[::1]", "::1"].includes(endpoint.hostname), "DevTools websocket escaped loopback");
  if (endpoint.hostname === "localhost") endpoint.hostname = "127.0.0.1";
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("DevTools websocket connection timed out"));
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      socket.close();
      reject(new Error("DevTools websocket connection failed"));
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
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      if (!intentionalClose) request.reject(new Error(`DevTools closed during ${request.method}`));
    }
    pending.clear();
  });

  return {
    close() {
      intentionalClose = true;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
    },
    send(method, params = {}, requestTimeoutMs = 10_000) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("DevTools websocket is not open"));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method} timed out`));
        }, requestTimeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

function requireWebViewPathBudget(portableRoot, platform = process.platform) {
  if (platform !== "win32") return;
  const userDataRoot = path.win32.resolve(portableRoot, "data", "webview2");
  // Reserve the WebView2 profile directories within the Win32 directory limit (MAX_PATH - 12).
  // This is a conservative harness budget, independent of machine-wide long-path settings.
  const profileDirectory = path.win32.join(userDataRoot, "EBWebView", "Default", "Local Storage", "leveldb");
  check(profileDirectory.length <= 248,
    `Windows WebView2 path budget exceeded: UDF ${userDataRoot.length} UTF-16 code units (maximum 208); shorten the disposable run root before launching Kaigen`);
}

class KaigenProcess {
  constructor({ label, executable, root, port, startupTimeoutMs, faultTest = null, automaticPqOnly = false }) {
    this.label = label;
    this.executable = executable;
    this.root = root;
    this.port = port;
    this.startupTimeoutMs = startupTimeoutMs;
    this.faultTest = faultTest;
    this.automaticPqOnly = automaticPqOnly;
    this.child = null;
    this.cdp = null;
    this.spawnError = null;
  }

  isRunning() {
    return this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start(startupTimeoutMs = this.startupTimeoutMs) {
    check(!this.isRunning(), `${this.label} was already running`);
    requireWebViewPathBudget(this.root);
    await mkdir(this.root, { recursive: true });
    this.spawnError = null;
    const browserArguments = [
      "--remote-debugging-address=127.0.0.1",
      `--remote-debugging-port=${this.port}`,
      "--remote-allow-origins=*",
    ].join(" ");
    const environment = {
      ...process.env,
      KAIGEN_PORTABLE_ROOT: this.root,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArguments,
    };
    if (this.faultTest) {
      environment.KAIGEN_PQ_TEST_ROOT = this.faultTest.root;
      environment.KAIGEN_PQ_TEST_NONCE = this.faultTest.nonce;
    }
    this.child = spawn(this.executable, [], {
      cwd: this.root,
      env: environment,
      detached: false,
      stdio: "ignore",
      windowsHide: true,
    });
    this.child.once("error", (error) => { this.spawnError = error; });

    const target = await waitUntil(async () => {
      if (this.spawnError) throw this.spawnError;
      if (!this.isRunning()) throw new Error(`${this.label} exited before DevTools was ready`);
      const targets = await fetchJson(`http://127.0.0.1:${this.port}/json/list`, 750);
      return targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl) ?? undefined;
    }, startupTimeoutMs, `${this.label} process/DevTools startup`, 100);
    this.cdp = await connectCdp(target.webSocketDebuggerUrl);
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Page.enable");
    await waitUntil(async () => {
      const result = await this.evaluate("typeof globalThis.__TAURI_INTERNALS__?.invoke === 'function'");
      return result === true ? true : undefined;
    }, startupTimeoutMs, `${this.label} Tauri command bridge`, 100);
  }

  async evaluate(expression, requestTimeoutMs = 15_000) {
    check(this.cdp, `${this.label} has no DevTools session`);
    const response = await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }, requestTimeoutMs);
    if (response.exceptionDetails) {
      const description = response.exceptionDetails.exception?.description
        ?? response.exceptionDetails.text
        ?? "evaluation failed";
      throw new Error(`${this.label} evaluation failed: ${sanitizeDiagnostic(description)}`);
    }
    return response.result?.value;
  }

  async invoke(command, args = {}, requestTimeoutMs = 30_000) {
    if (this.automaticPqOnly) requireAutomaticPqCommand(command);
    const expression = `(async () => {
      try {
        const value = await globalThis.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)});
        return { ok: true, value };
      } catch (error) {
        const code = typeof error === "string" ? error
          : typeof error?.code === "string" ? error.code
          : typeof error?.message === "string" ? error.message
          : "NATIVE_COMMAND_FAILED";
        return { ok: false, code };
      }
    })()`;
    const envelope = await this.evaluate(expression, requestTimeoutMs);
    if (!envelope?.ok) throw new NativeCommandError(command, String(envelope?.code ?? "NATIVE_COMMAND_FAILED"));
    return envelope.value;
  }

  async captureScreenshot(destination, { waitForChat = true } = {}) {
    if (waitForChat) {
      await this.cdp.send("Page.bringToFront");
      await waitUntil(async () => {
        const ready = await this.evaluate(`(() => {
        const splash = document.querySelector(".splash-screen");
        if (splash && splash.getBoundingClientRect().width > 0) return false;
        const area = document.querySelector("[data-kaigen-composer-editor]");
        if (area instanceof HTMLElement && area.isContentEditable) {
          const bounds = area.getBoundingClientRect();
          if (bounds.width > 0 && bounds.height > 0) return true;
        }
        const contacts = document.querySelectorAll(".chat-item");
        if (contacts.length === 1 && contacts[0] instanceof HTMLButtonElement) contacts[0].click();
        return false;
        })()`);
        return ready === true ? true : undefined;
      }, this.startupTimeoutMs, `${this.label} visible chat for native screenshot`);
    }
    await this.evaluate(`(() => {
      const masked = new Map();
      const mask = () => {
        for (const element of document.querySelectorAll(".pq-history-fingerprints code,.own-tox-id code,.tox-id,.incoming-request code")) {
          const original = element.textContent ?? "";
          if (!/[0-9a-f]/i.test(original)) continue;
          const replacement = original.replace(/[0-9a-f]/gi, "•");
          masked.set(element, { original, replacement });
          element.textContent = replacement;
        }
      };
      mask();
      const observer = new MutationObserver(mask);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
      globalThis.__kaigenPqCaptureRedaction = { masked, observer };
      return true;
    })()`);
    try {
      const result = await this.cdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      }, 15_000);
      const bytes = Buffer.from(String(result.data ?? ""), "base64");
      check(bytes.length > 1_000 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${this.label} screenshot was not a valid PNG`);
      await writeFile(destination, bytes, { flag: "wx" });
    } finally {
      await this.evaluate(`(() => {
        const state = globalThis.__kaigenPqCaptureRedaction;
        if (!state) return;
        state.observer.disconnect();
        for (const [element, { original, replacement }] of state.masked) {
          if (element.isConnected && element.textContent === replacement) element.textContent = original;
        }
        delete globalThis.__kaigenPqCaptureRedaction;
      })()`);
    }
  }

  async waitForExit(timeoutMs) {
    if (!this.child || !this.isRunning()) return;
    await within(new Promise((resolve) => this.child.once("exit", resolve)), timeoutMs, `${this.label} process exit`);
  }

  async hardKill() {
    this.cdp?.close();
    this.cdp = null;
    if (this.isRunning()) {
      const stopped = this.child.kill("SIGKILL");
      check(stopped, `${this.label} exact process could not be terminated`);
      await this.waitForExit(15_000);
    }
    this.child = null;
    await waitUntil(async () => {
      try {
        await fetchJson(`http://127.0.0.1:${this.port}/json/version`, 250);
        return undefined;
      } catch {
        return true;
      }
    }, 15_000, `${this.label} DevTools endpoint shutdown`, 100);
  }

  async stop() {
    if (this.cdp && this.isRunning()) {
      await within(this.invoke("exit_application", {}, 5_000), 6_000, `${this.label} graceful exit command`).catch(() => {});
    }
    this.cdp?.close();
    this.cdp = null;
    if (this.isRunning()) {
      await this.waitForExit(8_000).catch(() => {});
    }
    if (this.isRunning()) {
      const stopped = this.child.kill("SIGKILL");
      if (stopped) await this.waitForExit(10_000).catch(() => {});
    }
    this.child = null;
  }
}

async function prepareFaultTestConfig(instancesRoot, instanceRoot) {
  requireWithin(instancesRoot, instanceRoot, "fault-test instance root");
  await mkdir(instanceRoot, { recursive: true });
  const faultRoot = path.join(instanceRoot, "pq-fault-test");
  await mkdir(faultRoot, { recursive: false });
  const canonicalRoot = await realpath(faultRoot);
  requireWithin(instanceRoot, canonicalRoot, "fault-test root");
  const nonce = randomUUID();
  await writeFile(path.join(canonicalRoot, "marker.json"), `${JSON.stringify({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce,
  }, null, 2)}\n`, { flag: "wx" });
  return { root: canonicalRoot, nonce };
}

function faultTestFile(client, name) {
  check(client.faultTest, `${client.label} has no PQ fault-test configuration`);
  const file = path.join(client.faultTest.root, name);
  requireWithin(client.root, file, `${client.label} PQ fault-test file`);
  return file;
}

async function waitFaultTestSupport(client, timeoutMs) {
  const support = await waitUntil(
    () => readJsonIfPresent(faultTestFile(client, "support.json")),
    timeoutMs,
    `${client.label} compiled PQ fault-test support marker`,
    50,
  );
  return validateFaultSupport(support, client.faultTest.nonce, client.label);
}

async function clearFaultTestArm(client) {
  await Promise.all([
    rm(faultTestFile(client, "arm.json"), { force: true }),
    rm(faultTestFile(client, "status.json"), { force: true }),
  ]);
}

async function armFaultTest(client, friendNumber, stage, rotationParentSha256 = null) {
  check((rotationParentSha256 ? PQ_ROTATION_FAULT_STAGES : PQ_FAULT_STAGES).includes(stage), `unknown PQ fault-test stage: ${stage}`);
  check(rotationParentSha256 === null || /^[0-9A-F]{64}$/u.test(rotationParentSha256), "invalid rotation parent digest");
  check(Number.isInteger(friendNumber) && friendNumber >= 0, `${client.label} fault arm received an invalid friend number`);
  await clearFaultTestArm(client);
  await writeJsonAtomic(faultTestFile(client, "arm.json"), {
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce: client.faultTest.nonce,
    friendNumber,
    stage,
    rotationParentSha256,
  });
}

async function waitFaultTestTriggered(client, stage, timeoutMs, rotationParentSha256 = null) {
  const status = await waitUntil(
    () => readJsonIfPresent(faultTestFile(client, "status.json")),
    timeoutMs,
    `${client.label} exact ${stage} suppression barrier`,
    20,
  );
  check(status?.schemaVersion === PQ_FAULT_SCHEMA_VERSION, `${client.label} exact ${stage} barrier schema was invalid`);
  check(status?.nonce === client.faultTest.nonce, `${client.label} exact ${stage} barrier nonce did not match this run`);
  check(status?.triggered === true && status?.stage === stage, `${client.label} exact ${stage} barrier did not match the armed stage`);
  check(status?.suppressedBeforeTransport === true, `${client.label} exact ${stage} record was not proven suppressed before transport`);
  check(status?.blocksPeerV2UntilProcessExit === true, `${client.label} exact ${stage} barrier did not remain closed until process exit`);
  check((status.rotationParentSha256 ?? null) === rotationParentSha256, `${client.label} ${stage} barrier was bound to a different rotation`);
  if (rotationParentSha256) validateFaultSnapshot(status.snapshot, `${client.label} ${stage} native barrier`);
  return {
    stage,
    triggered: true,
    suppressedBeforeTransport: true,
    blocksPeerV2UntilProcessExit: true,
    ...(rotationParentSha256 ? { rotationParentMatched: true, nativeSnapshot: status.snapshot } : {}),
  };
}

function validateFaultSnapshot(snapshot, label) {
  const hash = (value) => typeof value === "string" && /^[0-9A-F]{64}$/u.test(value);
  check(snapshot && ["online", "capabilityValidated", "refreshRequested", "closing"].every((key) => typeof snapshot[key] === "boolean"), `${label}: invalid native state booleans`);
  check(["currentEpochSha256", "handshakeParentSha256", "handshakeEpochSha256"].every((key) => snapshot[key] === null || hash(snapshot[key])), `${label}: invalid native epoch digest`);
  check(snapshot.handshakePhase === null || ["offered", "incoming", "accept_pending", "accepting", "prepared", "activating", "done"].includes(snapshot.handshakePhase), `${label}: invalid native handshake phase`);
  check(Number.isInteger(snapshot.retiredCount) && snapshot.retiredCount >= 0 && snapshot.retiredCount <= 4096, `${label}: invalid native retirement count`);
  check(Array.isArray(snapshot.epochs) && snapshot.epochs.length <= 2, `${label}: invalid retained epoch count`);
  const hashes = new Set();
  for (const epoch of snapshot.epochs) {
    check(hash(epoch.sha256) && !hashes.has(epoch.sha256), `${label}: invalid or duplicate native epoch digest`);
    hashes.add(epoch.sha256);
    check(typeof epoch.current === "boolean" && typeof epoch.sendSealed === "boolean", `${label}: invalid native epoch flags`);
    check(Number.isInteger(epoch.unacknowledged) && epoch.unacknowledged >= 0 && epoch.unacknowledged <= 128, `${label}: invalid pending ciphertext count`);
    check(epoch.unacknowledged > 0 ? hash(epoch.pendingCiphertextSha256) : epoch.pendingCiphertextSha256 === null, `${label}: pending ciphertext digest/count mismatch`);
    check(epoch.current === (epoch.sha256 === snapshot.currentEpochSha256), `${label}: current epoch flags disagree`);
  }
  check(snapshot.currentEpochSha256 === null || hashes.has(snapshot.currentEpochSha256), `${label}: current epoch key material is missing`);
  return snapshot;
}

function safeFaultSnapshot(snapshot, label) {
  const value = validateFaultSnapshot(snapshot, label);
  return {
    online: value.online, capabilityValidated: value.capabilityValidated,
    refreshRequested: value.refreshRequested, closing: value.closing,
    currentEpochSha256: value.currentEpochSha256, handshakeParentSha256: value.handshakeParentSha256,
    handshakeEpochSha256: value.handshakeEpochSha256, handshakePhase: value.handshakePhase,
    retiredCount: value.retiredCount,
    epochs: value.epochs.map((epoch) => ({
      sha256: epoch.sha256, current: epoch.current, sendSealed: epoch.sendSealed,
      unacknowledged: epoch.unacknowledged, pendingCiphertextSha256: epoch.pendingCiphertextSha256,
    })),
  };
}

function isSettledRotationEpoch(current, retiredOld = null) {
  const epoch = current.alpha.currentEpochSha256;
  return Boolean(epoch && epoch === current.beta.currentEpochSha256
    && Object.values(current).every((state) => state.online && state.capabilityValidated && !state.closing
      && !state.refreshRequested && state.epochs.length === 1 && state.epochs[0].unacknowledged === 0
      && (state.handshakePhase === null || state.handshakePhase === "done")
      && (!retiredOld || state.currentEpochSha256 !== retiredOld
        && state.epochs.every((item) => item.sha256 !== retiredOld) && state.retiredCount > 0)));
}

async function readFaultSnapshot(client, friendNumber, timeoutMs) {
  const requestId = randomUUID();
  await writeJsonAtomic(faultTestFile(client, "observe.json"), {
    schemaVersion: PQ_FAULT_SCHEMA_VERSION, nonce: client.faultTest.nonce, friendNumber, requestId,
  });
  await client.invoke("get_pq_status", { friendNumber });
  return waitUntil(async () => {
    const state = await readJsonIfPresent(faultTestFile(client, "state.json"));
    if (!state || state.requestId !== requestId) return undefined;
    check(state.schemaVersion === PQ_FAULT_SCHEMA_VERSION && state.nonce === client.faultTest.nonce, `${client.label}: stale or foreign native state observation`);
    return validateFaultSnapshot(state.snapshot, client.label);
  }, timeoutMs, `${client.label} nonce-bound native epoch observation`, 20);
}

async function holdOldEpochData(client, friendNumber, epochSha256) {
  check(/^[0-9A-F]{64}$/u.test(epochSha256), "invalid old epoch hold digest");
  await writeJsonAtomic(faultTestFile(client, "hold.json"), {
    schemaVersion: PQ_FAULT_SCHEMA_VERSION, nonce: client.faultTest.nonce, friendNumber, epochSha256,
  });
}

async function releaseOldEpochData(client) {
  await rm(faultTestFile(client, "hold.json"), { force: true });
}

function publicKeyFromToxId(toxId, label) {
  check(typeof toxId === "string" && /^[0-9A-F]{76}$/u.test(toxId), `${label} returned an invalid synthetic Tox ID`);
  return toxId.slice(0, 64);
}

async function getFriend(client, peerPublicKey) {
  const friends = await client.invoke("get_tox_friends");
  check(Array.isArray(friends), `${client.label} returned an invalid friend list`);
  return friends.find((friend) => friend.public_key === peerPublicKey);
}

async function waitPairOnline(alpha, beta, alphaPeerKey, betaPeerKey, timeoutMs) {
  return waitUntil(async () => {
    const [alphaFriend, betaFriend] = await Promise.all([
      getFriend(alpha, betaPeerKey),
      getFriend(beta, alphaPeerKey),
    ]);
    if (!alphaFriend || !betaFriend) return undefined;
    if (!alphaFriend.authorized || !betaFriend.authorized) return undefined;
    if (alphaFriend.connection !== "online" || betaFriend.connection !== "online") return undefined;
    return { alphaFriendNumber: alphaFriend.number, betaFriendNumber: betaFriend.number };
  }, timeoutMs, "both synthetic friends online", 200);
}

function safePqStatus(status) {
  return {
    state: status?.state ?? "missing",
    supported: status?.supported === true,
    autoPending: status?.auto_pending === true,
    identityWaiting: status?.identity_waiting === true,
    identityNeedsEntropy: status?.identity_needs_entropy === true,
    protocolVersion: Number(status?.protocol_version ?? 0),
    fingerprintChanged: status?.fingerprint_changed === true,
    error: status?.error ? sanitizeDiagnostic(status.error) : null,
  };
}

function requirePqV2Pair(statuses, label) {
  for (const [peer, status] of Object.entries(statuses)) {
    check(status?.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, `${label}: ${peer} selected legacy/non-v2 PQ`);
  }
  return { alpha: safePqStatus(statuses.alpha), beta: safePqStatus(statuses.beta) };
}

async function pairPqStatus(alpha, beta, friendNumbers) {
  const [alphaStatus, betaStatus] = await Promise.all([
    alpha.invoke("get_pq_status", { friendNumber: friendNumbers.alphaFriendNumber }),
    beta.invoke("get_pq_status", { friendNumber: friendNumbers.betaFriendNumber }),
  ]);
  return { alpha: alphaStatus, beta: betaStatus };
}

async function waitPairPqCapable(alpha, beta, friendNumbers, timeoutMs) {
  return waitUntil(async () => {
    const statuses = await pairPqStatus(alpha, beta, friendNumbers);
    return statuses.alpha.supported === true && statuses.beta.supported === true
      && statuses.alpha.protocol_version === 2 && statuses.beta.protocol_version === 2
      ? statuses : undefined;
  }, timeoutMs, "bilateral observed PQv2 capabilities before lifetime-first send", 100);
}

async function waitPairPqActive(alpha, beta, friendNumbers, timeoutMs) {
  const statuses = await waitUntil(async () => {
    const current = await pairPqStatus(alpha, beta, friendNumbers);
    return current.alpha.state === "active" && current.beta.state === "active" ? current : undefined;
  }, timeoutMs, "PQv2 active on both clients", 100);
  for (const [label, status] of Object.entries(statuses)) {
    check(status.supported === true, `${label} did not confirm PQ support`);
    check(status.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, `${label} negotiated legacy/non-v2 PQ`);
    check(status.auto_pending === false, `${label} kept the automatic gate pending after activation`);
    check(status.fingerprint_changed !== true, `${label} reported a changed PQ identity`);
    check(!status.error, `${label} reported a PQ error after activation`);
  }
  return { alpha: safePqStatus(statuses.alpha), beta: safePqStatus(statuses.beta) };
}

async function waitPairPqActiveWithManualAcceptance(alpha, beta, friendNumbers, timeoutMs) {
  const statuses = await waitUntil(async () => {
    const current = await pairPqStatus(alpha, beta, friendNumbers);
    requirePqV2Pair(current, "manual PQ recovery");
    if (current.alpha.state === "incoming_offer") {
      await alpha.invoke("accept_pq_session", { friendNumber: friendNumbers.alphaFriendNumber });
      return undefined;
    }
    if (current.beta.state === "incoming_offer") {
      await beta.invoke("accept_pq_session", { friendNumber: friendNumbers.betaFriendNumber });
      return undefined;
    }
    return current.alpha.state === "active" && current.beta.state === "active" ? current : undefined;
  }, timeoutMs, "manual PQv2 recovery active on both clients", 50);
  for (const [label, status] of Object.entries(statuses)) {
    check(status.supported === true, `${label} did not retain modern PQ support during manual recovery`);
    check(status.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, `${label} selected legacy/non-v2 PQ during manual recovery`);
    check(status.auto_pending === false, `${label} reopened the one-time automatic gate during manual recovery`);
    check(status.fingerprint_changed !== true, `${label} reported a changed identity during manual recovery`);
    check(!status.error, `${label} reported a PQ error after manual recovery`);
  }
  return { alpha: safePqStatus(statuses.alpha), beta: safePqStatus(statuses.beta) };
}

async function waitPairPqStopped(alpha, beta, friendNumbers, timeoutMs) {
  const statuses = await waitUntil(async () => {
    const current = await pairPqStatus(alpha, beta, friendNumbers);
    const stopped = !PROTECTED_STATES.has(current.alpha.state) && !PROTECTED_STATES.has(current.beta.state);
    const freshV2 = current.alpha.supported === true && current.beta.supported === true
      && current.alpha.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION
      && current.beta.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION;
    return stopped && freshV2 ? current : undefined;
  }, timeoutMs, "bilateral PQ shutdown after old-epoch drain", 100);
  for (const [label, status] of Object.entries(statuses)) {
    check(status.supported === true, `${label} lost modern PQ capability after shutdown`);
    check(status.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, `${label} fell back from PQv2 after shutdown`);
    check(status.auto_pending === false, `${label} incorrectly queued automatic PQ after manual shutdown`);
    check(!status.error, `${label} reported a PQ shutdown error`);
  }
  return { alpha: safePqStatus(statuses.alpha), beta: safePqStatus(statuses.beta) };
}

async function messagesFor(client, friendNumber) {
  const messages = await client.invoke("get_tox_messages", { profileId: null, friendNumber, limit: 1_000 });
  check(Array.isArray(messages), `${client.label} returned invalid message history`);
  return messages;
}

function matchingTextRows(messages, text) {
  return messages.filter((message) => !message.event && message.text === text);
}

async function assertQueuedProtected(client, friendNumber, text, label) {
  const rows = matchingTextRows(await messagesFor(client, friendNumber), text);
  check(rows.length === 1, `${label}: durable sender history count was not exactly one before reconnect`);
  const row = rows[0];
  check(row.mine === true, `${label}: queued sender row had the wrong direction`);
  check(row.pq_protected === true, `${label}: first/pending row was not reserved for PQ protection`);
  check(row.delivery !== "failed", `${label}: queued sender row became terminally failed`);
  return { label, senderCount: 1, pqProtected: true, delivery: row.delivery };
}

async function waitMessageExact({ sender, receiver, senderFriendNumber, receiverFriendNumber, text, label, pqProtected, timeoutMs }) {
  const result = await waitUntil(async () => {
    const [senderHistory, receiverHistory] = await Promise.all([
      messagesFor(sender, senderFriendNumber),
      messagesFor(receiver, receiverFriendNumber),
    ]);
    const senderRows = matchingTextRows(senderHistory, text);
    const receiverRows = matchingTextRows(receiverHistory, text);
    if (senderRows.length > 1 || receiverRows.length > 1) {
      throw new HarnessInvariantError(`${label}: duplicate plaintext appeared in durable history`);
    }
    if (senderRows.length !== 1 || receiverRows.length !== 1) return undefined;
    const senderRow = senderRows[0];
    const receiverRow = receiverRows[0];
    if (senderRow.delivery !== "delivered") return undefined;
    if (senderRow.pq_protected !== pqProtected || receiverRow.pq_protected !== pqProtected) return undefined;
    return { senderRow, receiverRow };
  }, timeoutMs, `${label} exact plaintext delivery`, 150);

  check(result.senderRow.mine === true && result.receiverRow.mine === false, `${label}: final history directions were wrong`);
  check(result.senderRow.pq_protected === pqProtected, `${label}: sender protection marker was wrong`);
  check(result.receiverRow.pq_protected === pqProtected, `${label}: receiver protection marker was wrong`);
  return {
    label,
    senderCount: 1,
    receiverCount: 1,
    senderDelivery: "delivered",
    pqProtected,
  };
}

function requireStableMessageIds(senderRow, receiverRow, expected = {}) {
  check(typeof senderRow?.id === "string" && senderRow.id.length > 0, "outgoing message has no durable identity");
  check(typeof receiverRow?.id === "string" && receiverRow.id.length > 0, "incoming message has no durable identity");
  if (expected.sender) check(senderRow.id === expected.sender, "outgoing message identity changed after queueing");
  if (expected.receiver) check(receiverRow.id === expected.receiver, "incoming message identity changed after delivery");
  return { sender: senderRow.id, receiver: receiverRow.id };
}

function safeMessageIds(ids) {
  return Object.fromEntries(Object.entries(ids).map(([side, value]) => [
    `${side}MessageIdSha256`, createHash("sha256").update(value).digest("hex").toUpperCase(),
  ]));
}

async function textMessageIds({ sender, receiver, senderFriendNumber, receiverFriendNumber, text, expected }) {
  const [senderHistory, receiverHistory] = await Promise.all([
    messagesFor(sender, senderFriendNumber), messagesFor(receiver, receiverFriendNumber),
  ]);
  const senderRows = matchingTextRows(senderHistory, text);
  const receiverRows = matchingTextRows(receiverHistory, text);
  check(senderRows.length === 1 && receiverRows.length === 1, "exact text identity requires one row on each peer");
  return requireStableMessageIds(senderRows[0], receiverRows[0], expected);
}

function requirePeerFirstImageMarkers(row, side) {
  check(side === "sender" || side === "receiver", "image marker check requires an exact peer side");
  check(row.pq_protected === false, "the first image must retain its ordinary Tox E2EE protection marker");
  check(row.attachment?.image === true, "the first PNG must retain its image marker");
  // Native Tox file offers carry a filename, not the sender's concrete MIME.
  const expectedMime = side === "sender" ? "image/png" : "image/*";
  check(row.attachment.mime === expectedMime, "the first image MIME must match its native send/receive contract");
}

async function waitPeerFirstImageExact({ sender, receiver, senderFriendNumber, receiverFriendNumber, image, timeoutMs }) {
  const rows = await waitUntil(async () => {
    const [senderHistory, receiverHistory] = await Promise.all([
      messagesFor(sender, senderFriendNumber), messagesFor(receiver, receiverFriendNumber),
    ]);
    const senderRows = senderHistory.filter((row) => row.attachment?.name === image.filename);
    const receiverRows = receiverHistory.filter((row) => row.attachment?.name === image.filename);
    check(senderRows.length <= 1 && receiverRows.length <= 1, "peer-first image was duplicated in durable history");
    if (senderRows.length !== 1 || receiverRows.length !== 1) return undefined;
    for (const row of [...senderRows, ...receiverRows]) {
      check(!["failed", "cancelled"].includes(row.attachment.transfer_state), "peer-first image transfer ended without delivery");
    }
    if (senderRows[0].delivery !== "delivered"
      || !senderRows[0].attachment.completed || !receiverRows[0].attachment.completed
      || senderRows[0].attachment.transfer_state !== "complete" || receiverRows[0].attachment.transfer_state !== "complete") return undefined;
    return { sender: senderRows[0], receiver: receiverRows[0] };
  }, timeoutMs, "unilateral offline first image exact transfer", 150);
  const ids = requireStableMessageIds(rows.sender, rows.receiver, image.ids);
  check(rows.sender.mine === true && rows.receiver.mine === false, "peer-first image directions changed");
  for (const [side, row] of [["sender", rows.sender], ["receiver", rows.receiver]]) {
    requirePeerFirstImageMarkers(row, side);
    check(row.attachment.size === image.bytes.length, "peer-first image declared byte count changed");
  }
  const downloadsRoot = path.join(receiver.root, "downloads");
  check(typeof rows.receiver.attachment.path === "string", "peer-first image has no received file path");
  const declared = path.resolve(rows.receiver.attachment.path);
  check(isWithin(downloadsRoot, declared), "peer-first image escaped the disposable downloads directory");
  const [resolvedRoot, resolvedFile, info] = await Promise.all([realpath(downloadsRoot), realpath(declared), lstat(declared)]);
  check(isWithin(resolvedRoot, resolvedFile) && info.isFile() && !info.isSymbolicLink(), "peer-first image used a redirected or invalid path");
  check(path.basename(resolvedFile) === image.filename, "peer-first image filename changed");
  check((await readFile(resolvedFile)).equals(image.bytes), "received image bytes differ from the synthetic PNG");
  return { ids, evidence: {
    kind: "image", senderCount: 1, receiverCount: 1, senderDelivery: "delivered", transferState: "complete",
    pqProtected: false, bytes: image.bytes.length, sha256: createHash("sha256").update(image.bytes).digest("hex").toUpperCase(),
    ...safeMessageIds(ids),
  } };
}

function observeHistoryRows({ expected, alphaHistory, betaHistory }) {
  return expected.map(([label, senderLabel, pqProtected, text]) => {
    const senderHistory = senderLabel === "alpha" ? alphaHistory : betaHistory;
    const receiverHistory = senderLabel === "alpha" ? betaHistory : alphaHistory;
    const senderRows = senderHistory ? matchingTextRows(senderHistory, text) : null;
    const receiverRows = receiverHistory ? matchingTextRows(receiverHistory, text) : null;
    return {
      label,
      senderCount: senderRows?.length ?? null,
      receiverCount: receiverRows?.length ?? null,
      expectedPqProtected: pqProtected,
      senderDelivery: senderRows?.[0]?.delivery ?? null,
      senderPqProtected: senderRows?.[0]?.pq_protected ?? null,
      receiverPqProtected: receiverRows?.[0]?.pq_protected ?? null,
    };
  });
}

function assertFinalHistoryRows({ expected, alphaHistory, betaHistory }) {
  const verified = [];
  for (const [label, senderLabel, pqProtected, text] of expected) {
    const senderHistory = senderLabel === "alpha" ? alphaHistory : betaHistory;
    const receiverHistory = senderLabel === "alpha" ? betaHistory : alphaHistory;
    const senderRows = matchingTextRows(senderHistory, text);
    const receiverRows = matchingTextRows(receiverHistory, text);
    check(senderRows.length === 1, `${label}: final sender history count was not exactly one`);
    check(receiverRows.length === 1, `${label}: final receiver history count was not exactly one`);
    check(senderRows[0].mine === true && receiverRows[0].mine === false, `${label}: final history directions were wrong`);
    check(senderRows[0].delivery === "delivered", `${label}: final sender receipt was ${senderRows[0].delivery}, expected delivered`);
    check(senderRows[0].pq_protected === pqProtected, `${label}: final sender protection marker was wrong`);
    check(receiverRows[0].pq_protected === pqProtected, `${label}: final receiver protection marker was wrong`);
    verified.push({ label, senderCount: 1, receiverCount: 1, senderDelivery: "delivered", pqProtected });
  }
  return verified;
}

async function sendDurably(client, friendNumber, text, timeoutMs) {
  const operationId = randomUUID();
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  while (true) {
    try {
      const result = await client.invoke("send_tox_message", {
        profileId: null,
        friendNumber,
        text,
        operationId,
        quote: null,
        formatting: [],
      });
      check(result && typeof result.messageId === "string", `${client.label} returned an invalid send result`);
      check(result.delivery !== "failed", `${client.label} returned a terminal send failure`);
      return result;
    } catch (error) {
      if (!(error instanceof NativeCommandError) || !RETRYABLE_SEND_ERRORS.has(error.code) || Date.now() >= deadline) throw error;
      await delay(150);
    }
  }
}

async function setUserStatus(client, status) {
  const result = await client.invoke("set_tox_user_status", { status });
  check(result === status, `${client.label} did not apply ${status} status`);
}

async function selectFastInitialConnectionPreset(client, timeoutMs) {
  const startup = await client.invoke("get_startup_state");
  if (startup?.initialConnectionPresetRequired !== true) return false;

  await client.cdp.send("Page.bringToFront");
  await waitUntil(async () => {
    const selected = await client.evaluate(`(() => {
      const button = document.querySelector('[data-kaigen-ui-id="kaigen.startup.first-run-preset.element.fast-choice"]');
      if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
      const bounds = button.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return false;
      button.click();
      return true;
    })()`);
    return selected === true ? true : undefined;
  }, timeoutMs, `${client.label} Fast initial connection preset`, 50);

  const settled = await waitUntil(async () => {
    const [state, overlayVisible] = await Promise.all([
      client.invoke("get_startup_state"),
      client.evaluate(`(() => {
        const overlay = document.querySelector('[data-kaigen-ui-id="kaigen.startup.first-run-preset.group.overlay"]');
        if (!(overlay instanceof HTMLElement)) return false;
        const bounds = overlay.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })()`),
    ]);
    if (state?.initialConnectionPresetRequired === true || overlayVisible === true) return undefined;
    return state;
  }, timeoutMs, `${client.label} applied Fast initial connection preset`, 50);
  const active = settled?.profiles?.find((profile) => profile.active && profile.loaded);
  check(active?.connection === "offline" && active?.userStatus === "offline",
    `${client.label} initial connection preset unexpectedly connected the fresh profile`);
  return true;
}

async function startUiResponsivenessProbe(client, timeoutMs) {
  await client.cdp.send("Page.bringToFront");
  await waitUntil(async () => {
    const ready = await client.evaluate(`(() => {
      const area = document.querySelector("[data-kaigen-composer-editor]");
      if (area instanceof HTMLElement && area.isContentEditable) {
        const bounds = area.getBoundingClientRect();
        if (area.isConnected && area.getAttribute("aria-disabled") !== "true" && bounds.width > 0 && bounds.height > 0) return true;
      }
      const onlyContact = document.querySelector(".chat-item");
      if (onlyContact instanceof HTMLButtonElement) onlyContact.click();
      return false;
    })()`);
    return ready === true ? true : undefined;
  }, timeoutMs, `${client.label} chat composer for responsiveness probe`, 100);
  await waitUntil(async () => {
    const foreground = await client.evaluate(`(() => {
      window.focus();
      return document.visibilityState === "visible" && document.hasFocus();
    })()`);
    return foreground === true ? true : undefined;
  }, timeoutMs, `${client.label} foreground visibility for responsiveness probe`, 50);
  const started = await client.evaluate(`(() => {
    const key = "__kaigenPqRafProbe";
    if (globalThis[key]?.active) return false;
    const state = {
      active: true,
      startedAt: performance.now(),
      startVisibility: document.visibilityState,
      startFocused: document.hasFocus(),
      previous: null,
      previousForeground: false,
      foregroundIntervals: [],
      frameCount: 0,
      foregroundFrameCount: 0,
      hiddenFrameCount: 0,
      unfocusedFrameCount: 0,
      backgroundTransitions: 0,
      raf: 0,
    };
    state.markBackground = () => {
      state.previousForeground = false;
      state.backgroundTransitions += 1;
    };
    document.addEventListener("visibilitychange", state.markBackground);
    window.addEventListener("blur", state.markBackground);
    const sample = (now) => {
      if (!state.active) return;
      state.frameCount += 1;
      const visible = document.visibilityState === "visible";
      const focused = document.hasFocus();
      const foreground = visible && focused;
      if (foreground) state.foregroundFrameCount += 1;
      if (!visible) state.hiddenFrameCount += 1;
      else if (!focused) state.unfocusedFrameCount += 1;
      if (state.previous !== null && state.previousForeground && foreground) {
        state.foregroundIntervals.push(now - state.previous);
      }
      state.previous = now;
      state.previousForeground = foreground;
      state.raf = requestAnimationFrame(sample);
    };
    state.raf = requestAnimationFrame(sample);
    globalThis[key] = state;
    return true;
  })()`);
  check(started === true, `${client.label} could not start the requestAnimationFrame responsiveness probe`);
}

async function typeIntoComposerProbe(client, characterCount = 18) {
  const focused = await client.evaluate(`(() => {
    const area = document.querySelector("[data-kaigen-composer-editor]");
    if (!(area instanceof HTMLElement) || !area.isContentEditable) return { focused: false, composerPresent: false, visibility: document.visibilityState };
    area.focus({ preventScroll: true });
    const selection = document.getSelection();
    if (!selection) return { focused: false, composerPresent: true, selectionAvailable: false };
    const range = document.createRange();
    range.selectNodeContents(area);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const bounds = area.getBoundingClientRect();
    return {
      focused: document.activeElement === area,
      composerPresent: true,
      connected: area.isConnected,
      disabled: area.getAttribute("aria-disabled") === "true",
      readOnly: !area.isContentEditable,
      width: bounds.width,
      height: bounds.height,
      display: getComputedStyle(area).display,
      visibility: document.visibilityState,
      documentFocused: document.hasFocus(),
      activeTag: document.activeElement?.tagName ?? null,
    };
  })()`);
  check(focused?.focused === true, `${client.label} could not focus the real chat composer: ${JSON.stringify(focused)}`);
  for (let index = 0; index < characterCount; index += 1) {
    await client.cdp.send("Input.insertText", { text: index % 2 === 0 ? "k" : "a" });
    await delay(12);
  }
  const typedLength = await client.evaluate("document.querySelector('[data-kaigen-composer-editor]')?.textContent?.length ?? -1");
  check(typedLength >= characterCount, `${client.label} composer did not retain the synthetic typing probe`);
  const cleared = await client.evaluate(`(() => {
    const area = document.querySelector("[data-kaigen-composer-editor]");
    if (!(area instanceof HTMLElement) || !area.isContentEditable) return false;
    area.focus({ preventScroll: true });
    const selection = document.getSelection();
    if (!selection) return false;
    const range = document.createRange();
    range.selectNodeContents(area);
    selection.removeAllRanges();
    selection.addRange(range);
    // Native editing emits the normal input event consumed by the composer.
    if (!document.execCommand("delete")) return false;
    return (area.textContent ?? "") === "";
  })()`);
  check(cleared === true, `${client.label} could not clear the disposable typing probe`);
  return { inputEvents: characterCount, typedCharacters: characterCount, composerCleared: true };
}

async function finishUiResponsivenessProbe(client) {
  await client.cdp.send("Page.bringToFront");
  await client.evaluate("window.focus(); document.visibilityState === 'visible' && document.hasFocus()");
  await delay(120);
  const result = await client.evaluate(`(() => {
    const key = "__kaigenPqRafProbe";
    const state = globalThis[key];
    if (!state) return null;
    state.active = false;
    cancelAnimationFrame(state.raf);
    document.removeEventListener("visibilitychange", state.markBackground);
    window.removeEventListener("blur", state.markBackground);
    const sorted = [...state.foregroundIntervals].sort((left, right) => left - right);
    const p95Index = sorted.length ? Math.max(0, Math.ceil(sorted.length * 0.95) - 1) : -1;
    const summary = {
      durationMs: Math.round((performance.now() - state.startedAt) * 10) / 10,
      frameCount: state.frameCount,
      foregroundFrameCount: state.foregroundFrameCount,
      foregroundIntervalSamples: sorted.length,
      hiddenFrameCount: state.hiddenFrameCount,
      unfocusedFrameCount: state.unfocusedFrameCount,
      backgroundTransitions: state.backgroundTransitions,
      startVisibility: state.startVisibility,
      startFocused: state.startFocused,
      endVisibility: document.visibilityState,
      endFocused: document.hasFocus(),
      p95ForegroundIntervalMs: p95Index >= 0 ? Math.round(sorted[p95Index] * 10) / 10 : null,
      maxForegroundIntervalMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : null,
    };
    delete globalThis[key];
    return summary;
  })()`);
  check(result && result.frameCount >= 2 && result.foregroundIntervalSamples >= 1, `${client.label} responsiveness probe did not observe foreground animation frames`);
  check(
    result.startVisibility === "visible" && result.startFocused === true
      && Number.isFinite(result.durationMs)
      && Number.isFinite(result.p95ForegroundIntervalMs)
      && Number.isFinite(result.maxForegroundIntervalMs),
    `${client.label} responsiveness probe returned invalid timing aggregates`,
  );
  return result;
}

async function writeReceipt(receiptPath, receipt) {
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function resolveRunIdentity(requestedRoot) {
  const generatedRunId = `pq-two-instances-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const requestedRunRoot = requestedRoot ? path.resolve(requestedRoot) : path.join(runsRoot, generatedRunId);
  requireWithin(runsRoot, requestedRunRoot, "run root");
  const runId = path.basename(requestedRunRoot);
  check(/^pq-two-instances-[A-Za-z0-9][A-Za-z0-9-]*$/u.test(runId), "run root basename must start with pq-two-instances- and contain only ASCII letters, digits and hyphens");
  return { runId, requestedRunRoot };
}

async function preparePaths(options) {
  await mkdir(runsRoot, { recursive: true });
  const { runId, requestedRunRoot } = resolveRunIdentity(options.runRoot);
  check(!existsSync(requestedRunRoot), "run root already exists; refusing to reuse or overwrite it");

  const requestedArtifactRoot = options.artifactRoot
    ? path.resolve(options.artifactRoot)
    : options.exe ? path.dirname(path.resolve(options.exe)) : "";
  check(requestedArtifactRoot, "--artifact-root or --exe is required");
  const artifactRoot = await realpath(requestedArtifactRoot);
  check((await stat(artifactRoot)).isDirectory(), "artifact root is not a directory");
  const requestedExecutable = options.exe ? path.resolve(options.exe) : path.join(artifactRoot, "Kaigen.exe");
  const executable = await realpath(requestedExecutable);
  check(isWithin(artifactRoot, executable), "Kaigen executable must be inside the declared artifact root");
  const executableStat = await stat(executable);
  check(executableStat.isFile() && path.extname(executable).toLowerCase() === ".exe", "the selected artifact is not a Kaigen executable");
  check(!isWithin(artifactRoot, requestedRunRoot) && !isWithin(requestedRunRoot, artifactRoot), "artifact and synthetic run roots must not overlap");

  await mkdir(requestedRunRoot, { recursive: false });
  const instancesRoot = path.join(requestedRunRoot, "instances");
  const evidenceRoot = path.join(requestedRunRoot, "evidence");
  await Promise.all([mkdir(instancesRoot), mkdir(evidenceRoot)]);
  await writeFile(path.join(requestedRunRoot, "RUN-MARKER.json"), `${JSON.stringify({ schemaVersion: 1, runId }, null, 2)}\n`, { flag: "wx" });
  return { runId, runRoot: requestedRunRoot, instancesRoot, evidenceRoot, artifactRoot, executable, executableStat };
}

async function removeDisposableProfiles(paths, runId) {
  requireWithin(paths.runRoot, paths.instancesRoot, "instances root");
  const marker = JSON.parse(await readFile(path.join(paths.runRoot, "RUN-MARKER.json"), "utf8"));
  check(marker?.schemaVersion === 1 && marker.runId === runId, "run marker mismatch; refusing recursive profile cleanup");
  const resolvedRun = path.resolve(paths.runRoot);
  const resolvedInstances = path.resolve(paths.instancesRoot);
  check(isWithin(resolvedRun, resolvedInstances), "resolved instance cleanup target escaped the exact run root");
  await rm(resolvedInstances, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
}

async function selfTest() {
  const base = path.join(taskRoot, "two-instance-runs");
  const child = path.join(base, "pq-two-instances-self-test");
  assert.equal(isWithin(base, child), true);
  assert.equal(isWithin(base, base), false);
  assert.equal(isWithin(base, path.resolve(base, "..", "escape")), false);
  for (const stage of ["normal", "offline-first", "entropy", "formatting", "about", "fault"]) {
    const runId = `pq-two-instances-prerelease-${stage}-0123456789abcdef0123456789abcdef`;
    const requestedRunRoot = path.join(base, runId);
    assert.deepEqual(resolveRunIdentity(requestedRunRoot), { runId, requestedRunRoot });
    assert.match(`fmt-${runId.slice(-8).toLowerCase()}`, /^[a-z0-9-]{4,40}$/u);
  }
  const maxWindowsRoot = "C:\\" + "a".repeat(191);
  assert.equal(path.win32.join(maxWindowsRoot, "data", "webview2").length, 208);
  assert.doesNotThrow(() => requireWebViewPathBudget(maxWindowsRoot, "win32"));
  assert.doesNotThrow(() => requireWebViewPathBudget(maxWindowsRoot + "\\", "win32"));
  assert.throws(() => requireWebViewPathBudget(maxWindowsRoot + "a", "win32"), /WebView2 path budget/u);
  assert.doesNotThrow(() => requireWebViewPathBudget("C:\\" + "\u044f".repeat(191), "win32"));
  const unicodeWindowsRoot = "C:\\" + "\u{1f600}".repeat(95) + "a";
  assert.equal(unicodeWindowsRoot.length, 194);
  assert.doesNotThrow(() => requireWebViewPathBudget(unicodeWindowsRoot, "win32"));
  assert.throws(() => requireWebViewPathBudget(unicodeWindowsRoot + "a", "win32"), /WebView2 path budget/u);
  for (const platform of ["linux", "darwin"]) {
    assert.doesNotThrow(() => requireWebViewPathBudget("/" + "a".repeat(1000), platform));
  }
  const generated = resolveRunIdentity("");
  assert.match(generated.runId, /^pq-two-instances-[0-9]{14}-[0-9a-f]{8}$/u);
  assert.equal(generated.requestedRunRoot, path.join(base, generated.runId));
  for (const escaped of [base, path.resolve(base, "..", "pq-two-instances-escape"), `${base}-other/pq-two-instances-escape`]) {
    assert.throws(() => resolveRunIdentity(escaped), /must stay inside/u);
  }
  for (const unsafe of ["other-run", "pq-two-instances-", "pq-two-instances-space suffix", "pq-two-instances-tail.", "pq-two-instances-colon:stream", "pq-two-instances-under_score", "pq-two-instances-кириллица"]) {
    assert.throws(() => resolveRunIdentity(path.join(base, unsafe)), /run root basename/u);
  }
  assert.equal(sanitizeDiagnostic(`${"A".repeat(64)} ${randomUUID()}`).includes("[redacted-id]"), true);
  assert.equal(sanitizeDiagnostic(`${"A".repeat(64)} ${randomUUID()}`).includes("[redacted-operation]"), true);
  assert.equal(parseArguments(["--timeout-ms", "30000", "--debug-ports", "9201,9202"]).debugPorts.length, 2);
  const faultOptions = parseArguments(["--fault-stages", "--fault-total-timeout-ms", "300000"]);
  assert.equal(faultOptions.faultStages, true);
  assert.equal(faultOptions.faultTotalTimeoutMs, 300_000);
  assert.equal(parseArguments(["--offline-first-ordinary"]).offlineFirstOrdinary, true);
  assert.throws(() => parseArguments(["--offline-first-ordinary", "--fault-stages"]));
  for (const kind of ["text", "image"]) {
    assert.equal(parseArguments(["--offline-peer-first", kind]).offlinePeerFirst, kind);
    assert.throws(() => parseArguments(["--offline-peer-first", kind, "--offline-first-ordinary"]));
    assert.throws(() => parseArguments(["--offline-peer-first", kind, "--fault-stages"]));
  }
  assert.throws(() => parseArguments(["--offline-peer-first"]));
  assert.throws(() => parseArguments(["--offline-peer-first", "file"]));
  assert.throws(() => parseArguments(["--offline-peer-first", "text", "--offline-peer-first", "image"]));
  for (const command of PQ_USER_DECISION_COMMANDS) assert.throws(() => requireAutomaticPqCommand(command));
  for (const command of ["send_tox_message", "send_tox_file", "get_pq_status"]) requireAutomaticPqCommand(command);
  assert.throws(() => requireStableMessageIds({ id: "changed" }, { id: "received" }, { sender: "queued" }));
  assert.throws(() => requireStableMessageIds({ id: "queued" }, { id: "changed" }, { receiver: "received" }));
  const senderImage = { pq_protected: false, attachment: { image: true, mime: "image/png" } };
  const receiverImage = { pq_protected: false, attachment: { image: true, mime: "image/*" } };
  assert.doesNotThrow(() => requirePeerFirstImageMarkers(senderImage, "sender"));
  assert.doesNotThrow(() => requirePeerFirstImageMarkers(receiverImage, "receiver"));
  assert.throws(() => requirePeerFirstImageMarkers({ ...senderImage, pq_protected: true }, "sender"));
  assert.throws(() => requirePeerFirstImageMarkers({ ...receiverImage, attachment: { image: false, mime: "image/*" } }, "receiver"));
  assert.throws(() => requirePeerFirstImageMarkers(receiverImage, "sender"));
  assert.throws(() => requirePeerFirstImageMarkers({ ...receiverImage, attachment: { image: true, mime: "application/octet-stream" } }, "receiver"));
  assert.throws(() => requirePeerFirstImageMarkers(receiverImage, "unknown"));
  const png = syntheticPeerFirstPng();
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE));
  let decodedPixels = null;
  for (let offset = 8; offset < png.length;) {
    const size = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    assert.equal(png.readUInt32BE(offset + 8 + size), crc32(png.subarray(offset + 4, offset + 8 + size)));
    if (kind === "IDAT") decodedPixels = inflateSync(png.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  assert.equal(decodedPixels?.length, 16 * 65, "the synthetic PNG must decode into real RGBA pixels");
  const nonce = randomUUID();
  assert.equal(validateFaultSupport({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce,
    supported: true,
    feature: PQ_FAULT_FEATURE,
    stages: [...PQ_FAULT_STAGES],
    rotationStages: [...PQ_ROTATION_FAULT_STAGES],
  }, nonce, "self-test").stages.length, PQ_FAULT_STAGES.length);
  assert.throws(() => validateFaultSupport({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce,
    supported: true,
    feature: PQ_FAULT_FEATURE,
    stages: [...PQ_FAULT_STAGES].reverse(),
  }, nonce, "self-test"));
  assert.throws(() => parseArguments(["--debug-ports", "9201,9201"]));
  let betaStatusReads = 0;
  const stoppedStatus = (protocolVersion) => ({
    state: "available",
    supported: true,
    auto_pending: false,
    protocol_version: protocolVersion,
    error: null,
  });
  const stopped = await waitPairPqStopped(
    { invoke: async () => stoppedStatus(EXPECTED_PQ_PROTOCOL_VERSION) },
    { invoke: async () => stoppedStatus(++betaStatusReads === 1 ? 1 : EXPECTED_PQ_PROTOCOL_VERSION) },
    { alphaFriendNumber: 1, betaFriendNumber: 2 },
    1_000,
  );
  assert.equal(betaStatusReads, 2);
  assert.equal(stopped.beta.protocolVersion, EXPECTED_PQ_PROTOCOL_VERSION);
  for (const coordinator of ["alpha", "beta"]) {
    const peer = coordinator === "alpha" ? "beta" : "alpha";
    const expectedTargets = [peer, coordinator, peer, coordinator, peer, coordinator, peer, coordinator, peer, coordinator];
    for (const [index, stage] of PQ_ROTATION_FAULT_STAGES.entries()) {
      assert.deepEqual(rotationFaultRoles(stage, coordinator), {
        coordinatorLabel: coordinator, senderLabel: coordinator, receiverLabel: peer, targetLabel: expectedTargets[index],
      });
    }
  }
  assert.throws(() => rotationFaultRoles("close", "alpha"), /rotation stage/u);
  assert.throws(() => rotationFaultRoles("refresh", "unknown"), /coordinator/u);
  const validSnapshot = {
    online: true, capabilityValidated: true, refreshRequested: false, closing: false,
    currentEpochSha256: "A".repeat(64), handshakeParentSha256: null, handshakeEpochSha256: null,
    handshakePhase: null, retiredCount: 0,
    epochs: [{ sha256: "A".repeat(64), current: true, sendSealed: false, unacknowledged: 1, pendingCiphertextSha256: "B".repeat(64) }],
  };
  assert.equal(validateFaultSnapshot(validSnapshot, "self-test"), validSnapshot);
  const drained = structuredClone(validSnapshot);
  drained.epochs[0].unacknowledged = 0;
  drained.epochs[0].pendingCiphertextSha256 = null;
  const settled = { alpha: structuredClone(drained), beta: structuredClone(drained) };
  assert.equal(isSettledRotationEpoch(settled), true);
  for (const peer of ["alpha", "beta"]) {
    const pendingRefresh = structuredClone(settled);
    pendingRefresh[peer].refreshRequested = true;
    assert.equal(isSettledRotationEpoch(pendingRefresh), false, `${peer} pending refresh is not settled`);
    for (const [key, value] of [["online", false], ["capabilityValidated", false], ["closing", true], ["handshakePhase", "offered"]]) {
      const unsettled = structuredClone(settled);
      unsettled[peer][key] = value;
      assert.equal(isSettledRotationEpoch(unsettled), false);
    }
  }
  assert.equal(isSettledRotationEpoch({ alpha: validSnapshot, beta: drained }), false);
  assert.equal(isSettledRotationEpoch(settled, "A".repeat(64)), false);
  assert.equal(isSettledRotationEpoch(settled, "C".repeat(64)), false);
  const retired = structuredClone(settled);
  retired.alpha.retiredCount = retired.beta.retiredCount = 1;
  assert.equal(isSettledRotationEpoch(retired, "C".repeat(64)), true);
  const extra = { ...validSnapshot, privateKey: "must-not-be-retained", epochs: [{ ...validSnapshot.epochs[0], plaintext: "must-not-be-retained" }] };
  assert.deepEqual(safeFaultSnapshot(extra, "safe-projection"), validSnapshot);
  const safeCopy = safeFaultSnapshot(extra, "independent-copy");
  extra.epochs[0].unacknowledged = 2;
  assert.equal(safeCopy.epochs[0].unacknowledged, 1);
  assert.throws(() => validateFaultSnapshot({ ...validSnapshot, currentEpochSha256: "C".repeat(64) }, "foreign-current"));
  assert.throws(() => validateFaultSnapshot({ ...validSnapshot, epochs: [{ ...validSnapshot.epochs[0], pendingCiphertextSha256: null }] }, "lost-ciphertext-proof"));
  assert.throws(() => validateFaultSnapshot({ ...validSnapshot, epochs: [...validSnapshot.epochs, ...validSnapshot.epochs] }, "duplicate-epoch"));
  assert.throws(() => validateFaultSupport({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION, nonce, supported: true, feature: PQ_FAULT_FEATURE,
    stages: [...PQ_FAULT_STAGES], rotationStages: [...PQ_ROTATION_FAULT_STAGES].reverse(),
  }, nonce, "wrong-rotation-stage-order"));
  console.log("PQ two-instance harness self-test passed (path boundary, redaction, CLI, unilateral text/image safety, exact fault-hook contract).");
}

async function runHarness(options) {
  if (process.platform !== "win32") throw new Error("The full-process PQ fault harness currently requires a Windows portable Kaigen build");
  if (typeof WebSocket !== "function") throw new Error("This Node runtime does not expose WebSocket; use the pinned project Node runtime");

  const paths = await preparePaths(options);
  const ports = options.debugPorts ?? [await freeLoopbackPort(), await freeLoopbackPort()];
  check(ports[0] !== ports[1], "selected DevTools ports collided");
  const receiptPath = path.join(paths.evidenceRoot, "receipt.json");
  const artifactSha256 = await sha256File(paths.executable);
  const receipt = {
    schemaVersion: 1,
    runId: paths.runId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    artifact: {
      executable: path.basename(paths.executable),
      bytes: paths.executableStat.size,
      sha256: artifactSha256,
    },
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    expectedPqProtocolVersion: EXPECTED_PQ_PROTOCOL_VERSION,
    firstSendMode: options.offlinePeerFirst ? `unilateral-offline-${options.offlinePeerFirst}`
      : options.offlineFirstOrdinary ? "offline-ordinary" : "online-automatic-pq",
    faultStages: {
      requested: options.faultStages,
      feature: options.faultStages ? PQ_FAULT_FEATURE : null,
      exactBarrierContract: options.faultStages,
      supportedStages: options.faultStages ? [...PQ_FAULT_STAGES] : [],
      totalTimeoutMs: options.faultStages ? options.faultTotalTimeoutMs : null,
    },
    rotationFaults: {
      requested: options.faultStages, inPlace: true,
      supportedStages: options.faultStages ? [...PQ_ROTATION_FAULT_STAGES] : [], completedStages: [],
    },
    scenarios: [],
    screenshots: [],
    profilesDisposed: false,
    failure: null,
  };
  await writeReceipt(receiptPath, receipt);

  const alphaRoot = path.join(paths.instancesRoot, "alpha");
  const betaRoot = path.join(paths.instancesRoot, "beta");
  const [alphaFaultTest, betaFaultTest] = options.faultStages
    ? await Promise.all([
        prepareFaultTestConfig(paths.instancesRoot, alphaRoot),
        prepareFaultTestConfig(paths.instancesRoot, betaRoot),
      ])
    : [null, null];
  const alpha = new KaigenProcess({
    label: "alpha",
    executable: paths.executable,
    root: alphaRoot,
    port: ports[0],
    startupTimeoutMs: options.startupTimeoutMs,
    faultTest: alphaFaultTest,
    automaticPqOnly: !!options.offlinePeerFirst,
  });
  const beta = new KaigenProcess({
    label: "beta",
    executable: paths.executable,
    root: betaRoot,
    port: ports[1],
    startupTimeoutMs: options.startupTimeoutMs,
    faultTest: betaFaultTest,
    automaticPqOnly: !!options.offlinePeerFirst,
  });
  const replacements = [[paths.runRoot, "$RUN_ROOT"], [paths.artifactRoot, "$ARTIFACT_ROOT"], [paths.executable, "$KAIGEN_EXE"]];
  const expectedRows = [];
  const labelText = (label, sender = "alpha", pqProtected = true) => {
    const value = `KAIGEN PQ E2E ${paths.runId.slice(-8)} ${label}`;
    expectedRows.push([label, sender, pqProtected, value]);
    return value;
  };
  let alphaPublicKey = "";
  let betaPublicKey = "";
  let friendNumbers = null;
  let activeProfileIds = null;
  let peerFirstProof = null;
  let failure = null;
  let rotationFailureEvidence = null;

  const scenario = async (name, action) => {
    const started = Date.now();
    console.log(`[pq-two-instances] ${name}`);
    try {
      const details = await action();
      const observedMessages = friendNumbers && expectedRows.length
        ? observeHistoryRows({
            expected: expectedRows,
            alphaHistory: await messagesFor(alpha, friendNumbers.alphaFriendNumber),
            betaHistory: await messagesFor(beta, friendNumbers.betaFriendNumber),
          })
        : [];
      receipt.scenarios.push({ name, status: "pass", durationMs: Date.now() - started, ...details, observedMessages });
      await writeReceipt(receiptPath, receipt);
      return details;
    } catch (error) {
      receipt.scenarios.push({ name, status: "fail", durationMs: Date.now() - started });
      throw error;
    }
  };

  const screenshot = async (client, fileName) => {
    const destination = path.join(paths.evidenceRoot, fileName);
    await client.captureScreenshot(destination, { waitForChat: !fileName.startsWith("failure-") });
    receipt.screenshots.push(fileName);
  };

  let faultDeadline = null;
  const remainingFaultTimeout = (label) => {
    check(faultDeadline !== null, `${label}: exact fault-stage deadline was not initialized`);
    const remaining = faultDeadline - Date.now();
    check(remaining > 0, `${label}: exact fault-stage matrix exceeded its ${options.faultTotalTimeoutMs} ms budget`);
    return Math.min(options.timeoutMs, remaining);
  };
  const clientByLabel = (label) => label === "alpha" ? alpha : beta;
  const friendNumberFor = (label) => label === "alpha" ? friendNumbers.alphaFriendNumber : friendNumbers.betaFriendNumber;
  const peerPublicKeyFor = (label) => label === "alpha" ? betaPublicKey : alphaPublicKey;

  const restoreFaultedClient = async (client, stage) => {
    await client.hardKill();
    await clearFaultTestArm(client);
    await client.start(Math.min(options.startupTimeoutMs, remainingFaultTimeout(`${stage} restart`)));
    const restoredFriend = await waitUntil(
      () => getFriend(client, peerPublicKeyFor(client.label)).then((friend) => friend ?? undefined),
      remainingFaultTimeout(`${stage} durable friend restore`),
      `${client.label} durable friend after exact ${stage} cut`,
      50,
    );
    if (client.label === "alpha") friendNumbers.alphaFriendNumber = restoredFriend.number;
    else friendNumbers.betaFriendNumber = restoredFriend.number;
    await setUserStatus(client, "online");
    friendNumbers = await waitPairOnline(
      alpha,
      beta,
      alphaPublicKey,
      betaPublicKey,
      remainingFaultTimeout(`${stage} reconnect`),
    );
    return {
      armedProcess: client.label,
      exactArmedPidExited: true,
      remotePresenceWaitBeforeRestart: false,
      presenceEvidence: "triggered barrier suppressed the selected record until exact armed process exit",
    };
  };

  const establishManualPq = async (label) => {
    const current = await pairPqStatus(alpha, beta, friendNumbers);
    requirePqV2Pair(current, `${label} precondition`);
    if (current.alpha.state === "active" && current.beta.state === "active") {
      return waitPairPqActive(alpha, beta, friendNumbers, remainingFaultTimeout(`${label} active precondition`));
    }
    if (PROTECTED_STATES.has(current.alpha.state) || PROTECTED_STATES.has(current.beta.state)) {
      await waitPairPqStopped(alpha, beta, friendNumbers, remainingFaultTimeout(`${label} prior close`));
    }
    await alpha.invoke("request_pq_session", { friendNumber: friendNumbers.alphaFriendNumber });
    return waitPairPqActiveWithManualAcceptance(
      alpha,
      beta,
      friendNumbers,
      remainingFaultTimeout(`${label} manual activation`),
    );
  };

  const stopPqBeforeHandshakeFault = async (stage) => {
    const current = await pairPqStatus(alpha, beta, friendNumbers);
    requirePqV2Pair(current, `${stage} clean-start precondition`);
    if (!PROTECTED_STATES.has(current.alpha.state) && !PROTECTED_STATES.has(current.beta.state)) {
      return waitPairPqStopped(alpha, beta, friendNumbers, remainingFaultTimeout(`${stage} stopped precondition`));
    }
    if (current.alpha.state === "active") {
      await alpha.invoke("request_pq_shutdown", { friendNumber: friendNumbers.alphaFriendNumber });
    } else if (current.beta.state === "active") {
      await beta.invoke("request_pq_shutdown", { friendNumber: friendNumbers.betaFriendNumber });
    }
    return waitPairPqStopped(alpha, beta, friendNumbers, remainingFaultTimeout(`${stage} clean shutdown`));
  };

  const runHandshakeFaultStage = async (stage) => {
    await stopPqBeforeHandshakeFault(stage);
    const target = clientByLabel(HANDSHAKE_FAULT_TARGET[stage]);
    await armFaultTest(target, friendNumberFor(target.label), stage);
    await alpha.invoke("request_pq_session", { friendNumber: friendNumbers.alphaFriendNumber });
    if (stage !== "offer") {
      await waitUntil(async () => {
        const status = await beta.invoke("get_pq_status", { friendNumber: friendNumbers.betaFriendNumber });
        check(status.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, `${stage}: beta selected legacy/non-v2 PQ before acceptance`);
        return status.state === "incoming_offer" ? true : undefined;
      }, remainingFaultTimeout(`${stage} incoming offer`), `${stage} incoming manual offer`, 25);
      await beta.invoke("accept_pq_session", { friendNumber: friendNumbers.betaFriendNumber });
    }
    const barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} barrier`));
    const messageLabel = `fault-${stage}`;
    const text = labelText(messageLabel);
    await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, remainingFaultTimeout(`${stage} durable message enqueue`));
    const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, messageLabel);
    check(queued.delivery !== "delivered", `${stage}: message crossed an intentionally blocked handshake stage`);
    const processCut = await restoreFaultedClient(target, stage);
    const pq = await waitPairPqActiveWithManualAcceptance(
      alpha,
      beta,
      friendNumbers,
      remainingFaultTimeout(`${stage} PQ recovery`),
    );
    const delivered = await waitMessageExact({
      sender: alpha,
      receiver: beta,
      senderFriendNumber: friendNumbers.alphaFriendNumber,
      receiverFriendNumber: friendNumbers.betaFriendNumber,
      text,
      label: messageLabel,
      pqProtected: true,
      timeoutMs: remainingFaultTimeout(`${stage} message recovery`),
    });
    return { stage, barrier, processCut, queued, pq, delivered };
  };

  const runDataFaultStage = async () => {
    const stage = "data";
    const target = alpha;
    await establishManualPq(stage);
    await armFaultTest(target, friendNumbers.alphaFriendNumber, stage);
    const messageLabel = `fault-${stage}`;
    const text = labelText(messageLabel);
    await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, remainingFaultTimeout(`${stage} durable message enqueue`));
    const barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} barrier`));
    const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, messageLabel);
    check(queued.delivery !== "delivered", "data: sender received a receipt while its exact DATA record was suppressed");
    const processCut = await restoreFaultedClient(target, stage);
    const pq = await waitPairPqActive(alpha, beta, friendNumbers, remainingFaultTimeout(`${stage} PQ recovery`));
    const delivered = await waitMessageExact({
      sender: alpha,
      receiver: beta,
      senderFriendNumber: friendNumbers.alphaFriendNumber,
      receiverFriendNumber: friendNumbers.betaFriendNumber,
      text,
      label: messageLabel,
      pqProtected: true,
      timeoutMs: remainingFaultTimeout(`${stage} message recovery`),
    });
    return { stage, barrier, processCut, queued, pq, delivered };
  };

  const runAckFaultStage = async () => {
    const stage = "ack";
    const target = beta;
    await establishManualPq(stage);
    await armFaultTest(target, friendNumbers.betaFriendNumber, stage);
    const messageLabel = `fault-${stage}`;
    const text = labelText(messageLabel);
    await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, remainingFaultTimeout(`${stage} durable message enqueue`));
    const barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} barrier`));
    const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, messageLabel);
    check(queued.delivery !== "delivered", "ack: sender was marked delivered while the exact ACK was suppressed");
    const receivedBeforeCut = await waitUntil(async () => {
      const rows = matchingTextRows(await messagesFor(beta, friendNumbers.betaFriendNumber), text);
      if (rows.length > 1) throw new HarnessInvariantError("ack: receiver stored duplicate plaintext before the cut");
      if (rows.length !== 1) return undefined;
      const row = rows[0];
      check(row.mine === false && row.pq_protected === true, "ack: receiver pre-cut durable row was not protected incoming plaintext");
      return { receiverCount: 1, pqProtected: true };
    }, remainingFaultTimeout(`${stage} receiver durable row`), "ACK-stage receiver durable plaintext before process cut", 25);
    const processCut = await restoreFaultedClient(target, stage);
    const pq = await waitPairPqActive(alpha, beta, friendNumbers, remainingFaultTimeout(`${stage} PQ recovery`));
    const delivered = await waitMessageExact({
      sender: alpha,
      receiver: beta,
      senderFriendNumber: friendNumbers.alphaFriendNumber,
      receiverFriendNumber: friendNumbers.betaFriendNumber,
      text,
      label: messageLabel,
      pqProtected: true,
      timeoutMs: remainingFaultTimeout(`${stage} message recovery`),
    });
    return { stage, barrier, processCut, queued, receivedBeforeCut, pq, delivered };
  };

  const runCloseFaultStage = async (stage) => {
    await establishManualPq(stage);
    const coordinator = alphaPublicKey < betaPublicKey ? "alpha" : "beta";
    const targetLabel = stage === "close" || stage === "close_ready"
      ? "alpha"
      : stage === "close_commit" ? coordinator : coordinator === "alpha" ? "beta" : "alpha";
    const target = clientByLabel(targetLabel);
    await armFaultTest(target, friendNumberFor(targetLabel), stage);
    const messageLabel = `fault-${stage}`;
    const text = labelText(messageLabel);
    await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, remainingFaultTimeout(`${stage} durable message enqueue`));
    const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, messageLabel);
    await alpha.invoke("request_pq_shutdown", { friendNumber: friendNumbers.alphaFriendNumber });
    const barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} barrier`));
    const processCut = await restoreFaultedClient(target, stage);
    const delivered = await waitMessageExact({
      sender: alpha,
      receiver: beta,
      senderFriendNumber: friendNumbers.alphaFriendNumber,
      receiverFriendNumber: friendNumbers.betaFriendNumber,
      text,
      label: messageLabel,
      pqProtected: true,
      timeoutMs: remainingFaultTimeout(`${stage} message readback`),
    });
    const stopped = await waitPairPqStopped(alpha, beta, friendNumbers, remainingFaultTimeout(`${stage} close recovery`));
    return { stage, barrier, processCut, queued, delivered, stopped };
  };

  const rememberRotationSnapshot = async (client, friendNumber, timeoutMs, label = "single-peer native checkpoint") => {
    const snapshot = await readFaultSnapshot(client, friendNumber, timeoutMs);
    if (rotationFailureEvidence) rotationFailureEvidence.latest[client.label] = {
      label, observedAt: new Date().toISOString(), snapshot: safeFaultSnapshot(snapshot, label),
    };
    return snapshot;
  };
  const rotationSnapshots = async (label) => {
    const snapshots = await Promise.all([alpha, beta].map((client) =>
      rememberRotationSnapshot(client, friendNumberFor(client.label), remainingFaultTimeout(label), label)));
    return { alpha: snapshots[0], beta: snapshots[1] };
  };

  const waitSettledRotationEpoch = async (label, retiredOld = null) => waitUntil(async () => {
    if (rotationFailureEvidence) rotationFailureEvidence.lastSettledPollLabel = label;
    const current = await rotationSnapshots(label);
    return isSettledRotationEpoch(current, retiredOld) ? current : undefined;
  }, remainingFaultTimeout(label), label, 100);

  const runRotationFaultStage = async (stage) => {
    rotationFailureEvidence = { stage, before: null, latest: { alpha: null, beta: null }, latestOnlineQueued: null, lastSettledPollLabel: null };
    const before = await waitSettledRotationEpoch(`rotation ${stage} settled active precondition`);
    rotationFailureEvidence.before = Object.fromEntries(Object.entries(before).map(([peer, state]) =>
      [peer, safeFaultSnapshot(state, `${stage} before ${peer}`)]));
    const oldEpoch = before.alpha.currentEpochSha256;
    const { coordinatorLabel, senderLabel, receiverLabel, targetLabel } = rotationFaultRoles(stage,
      alphaPublicKey < betaPublicKey ? "alpha" : "beta");
    const sender = clientByLabel(senderLabel);
    const receiver = clientByLabel(receiverLabel);
    const target = clientByLabel(targetLabel);
    const oldLabel = `rotation-${stage}-old-ciphertext`;
    const oldText = labelText(oldLabel, senderLabel);
    await holdOldEpochData(sender, friendNumberFor(senderLabel), oldEpoch);
    // Encryption runs only with the transport ready. Prove an actual durable
    // wire ciphertext while online before creating the offline refresh trigger.
    await sendDurably(sender, friendNumberFor(senderLabel), oldText, remainingFaultTimeout(`${stage} old enqueue`));
    const onlineQueued = await waitUntil(async () => {
      const states = await rotationSnapshots(`${stage} online queued ciphertext proof`);
      rotationFailureEvidence.latestOnlineQueued = {
        observedAt: new Date().toISOString(),
        snapshots: Object.fromEntries(Object.entries(states).map(([peer, state]) => [peer, safeFaultSnapshot(state, `${stage} queued ${peer}`)])),
        failedClauses: Object.fromEntries(Object.entries(states).map(([peer, state]) => [peer, {
          epochChanged: state.currentEpochSha256 !== oldEpoch, closing: state.closing, refreshRequested: state.refreshRequested,
        }])),
      };
      check(Object.values(states).every((state) => state.currentEpochSha256 === oldEpoch && !state.closing
        && !state.refreshRequested), `${stage}: old ciphertext enqueue unexpectedly started a rotation or shutdown`);
      const old = states[senderLabel].epochs.find((epoch) => epoch.sha256 === oldEpoch);
      check(old && old.unacknowledged <= 1, `${stage}: online old ciphertext queue was missing or not isolated`);
      return Object.values(states).every((state) => state.online && state.capabilityValidated)
        && old.unacknowledged === 1 ? states : undefined;
    }, remainingFaultTimeout(`${stage} online ciphertext`), `${stage} real old ciphertext while both online`, 50);
    const queued = await assertQueuedProtected(sender, friendNumberFor(senderLabel), oldText, oldLabel);
    check(queued.delivery !== "delivered", `${stage}: held old ciphertext was already delivered`);
    const ciphertextDigest = onlineQueued[senderLabel].epochs.find((epoch) => epoch.sha256 === oldEpoch).pendingCiphertextSha256;
    const assertOldCiphertext = (state, label) => {
      const epoch = state.epochs.find((item) => item.sha256 === oldEpoch);
      check(epoch?.unacknowledged === 1 && epoch.pendingCiphertextSha256 === ciphertextDigest,
        `${label}: original old-epoch durable ciphertext changed or disappeared before ACK`);
      return epoch;
    };
    await Promise.all([setUserStatus(alpha, "offline"), setUserStatus(beta, "offline")]);
    // The opposite sender requests REFRESH without adding a second record to
    // the held sender's exact one-ciphertext queue or changing its digest.
    const triggerLabel = `rotation-${stage}-refresh-trigger`;
    const triggerText = labelText(triggerLabel, receiverLabel);
    await sendDurably(receiver, friendNumberFor(receiverLabel), triggerText, remainingFaultTimeout(`${stage} offline refresh trigger`));
    const triggerQueued = await assertQueuedProtected(receiver, friendNumberFor(receiverLabel), triggerText, triggerLabel);
    check(triggerQueued.delivery === "pending", `${stage}: offline refresh trigger was not pending`);
    const offline = await rotationSnapshots(`${stage} offline refresh precondition`);
    check(Object.values(offline).every((state) => !state.online && state.currentEpochSha256 === oldEpoch && !state.closing)
      && offline[receiverLabel].refreshRequested && !offline[senderLabel].refreshRequested,
      `${stage}: offline trigger did not request refresh exclusively on the noncoordinator`);
    assertOldCiphertext(offline[senderLabel], `${stage} offline interval`);
    const lateCut = ["data", "ack", "retire"].includes(stage);
    if (!lateCut) await armFaultTest(target, friendNumberFor(targetLabel), stage, oldEpoch);
    await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
    friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, remainingFaultTimeout(`${stage} both online`));
    let barrier = null;
    let processCut = null;
    if (!lateCut) {
      barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} rotation barrier`), oldEpoch);
      assertOldCiphertext(await rememberRotationSnapshot(sender, friendNumberFor(senderLabel), remainingFaultTimeout(`${stage} held old ciphertext`)), stage);
      processCut = await restoreFaultedClient(target, `rotation-${stage}`);
      assertOldCiphertext(await rememberRotationSnapshot(sender, friendNumberFor(senderLabel), remainingFaultTimeout(`${stage} restored old ciphertext`)), `${stage} restart`);
    }
    const activated = await waitUntil(async () => {
      const states = await rotationSnapshots(`${stage} in-place activation`);
      assertOldCiphertext(states[senderLabel], `${stage} activation`);
      const newEpoch = states.alpha.currentEpochSha256;
      const ready = newEpoch && newEpoch !== oldEpoch && newEpoch === states.beta.currentEpochSha256
        && Object.values(states).every((state) => state.online && state.capabilityValidated && !state.closing
          && state.handshakePhase === "done" && state.epochs.length === 2
          && state.epochs.some((epoch) => epoch.sha256 === oldEpoch && !epoch.current && epoch.sendSealed));
      return ready ? states : undefined;
    }, remainingFaultTimeout(`${stage} bilateral new epoch`), `${stage} new epoch with old ciphertext retained`, 100);
    const triggerDelivered = await waitMessageExact({
      sender: receiver, receiver: sender, senderFriendNumber: friendNumberFor(receiverLabel), receiverFriendNumber: friendNumberFor(senderLabel),
      text: triggerText, label: triggerLabel, pqProtected: true, timeoutMs: remainingFaultTimeout(`${stage} refresh trigger delivery and ACK`),
    });
    assertOldCiphertext(await rememberRotationSnapshot(sender, friendNumberFor(senderLabel), remainingFaultTimeout(`${stage} pre-release old ciphertext`)), `${stage} trigger drained`);
    const absent = matchingTextRows(await messagesFor(receiver, friendNumberFor(receiverLabel)), oldText);
    check(absent.length === 0, `${stage}: held old ciphertext reached the receiver before release`);

    if (lateCut) await armFaultTest(target, friendNumberFor(targetLabel), stage, oldEpoch);
    await releaseOldEpochData(sender);
    let receivedBeforeAckCut = false;
    if (lateCut) {
      barrier = await waitFaultTestTriggered(target, stage, remainingFaultTimeout(`${stage} rotated old-epoch barrier`), oldEpoch);
      if (stage === "data" || stage === "ack") {
        assertOldCiphertext(await rememberRotationSnapshot(sender, friendNumberFor(senderLabel), remainingFaultTimeout(`${stage} unacknowledged proof`)), stage);
      }
      if (stage === "ack") {
        const rows = matchingTextRows(await messagesFor(receiver, friendNumberFor(receiverLabel)), oldText);
        check(rows.length === 1 && rows[0].mine === false && rows[0].pq_protected === true,
          "rotation ACK cut did not follow durable incoming plaintext commit");
        receivedBeforeAckCut = true;
      }
      if (stage === "retire") {
        const peerState = await rememberRotationSnapshot(receiver, friendNumberFor(receiverLabel), remainingFaultTimeout("retire peer retention"));
        check(peerState.epochs.some((epoch) => epoch.sha256 === oldEpoch && !epoch.current),
          "rotation RETIRE peer erased its old epoch before receiving the suppressed retirement boundary");
      }
      processCut = await restoreFaultedClient(target, `rotation-${stage}`);
    }
    const delivered = [await waitMessageExact({
      sender, receiver, senderFriendNumber: friendNumberFor(senderLabel), receiverFriendNumber: friendNumberFor(receiverLabel),
      text: oldText, label: oldLabel, pqProtected: true, timeoutMs: remainingFaultTimeout(`${stage} old ciphertext replay delivery`),
    }), triggerDelivered];
    await waitSettledRotationEpoch(`${stage} bilateral old epoch retirement after ACK`, oldEpoch);
    for (const client of [alpha, beta]) {
      const peerClient = client === alpha ? beta : alpha;
      const label = `rotation-${stage}-new-${client.label}`;
      const text = labelText(label, client.label);
      await sendDurably(client, friendNumberFor(client.label), text, remainingFaultTimeout(label));
      delivered.push(await waitMessageExact({
        sender: client, receiver: peerClient, senderFriendNumber: friendNumberFor(client.label),
        receiverFriendNumber: friendNumberFor(peerClient.label), text, label, pqProtected: true,
        timeoutMs: remainingFaultTimeout(label),
      }));
    }
    await waitSettledRotationEpoch(`${stage} final live ratchets and retirement`);
    return {
      stage, inPlace: true, manualStartInvoked: false, oldEpochRetained: true,
      oldCiphertextUnchanged: true, newEpochActivated: true, bothPeersOnlineAtActivation: true,
      oldEpochRetired: true, oldCiphertextDelivered: true, receivedBeforeAckCut,
      oldCiphertextQueuedWhileOnline: true, oldCiphertextSha256: ciphertextDigest,
      coordinator: coordinatorLabel, oldCiphertextSender: senderLabel, oldCiphertextReceiver: receiverLabel,
      refreshTrigger: { label: triggerLabel, sender: receiverLabel, receiver: senderLabel,
        bothPeersOffline: true, requestedOnNonCoordinator: true, deliveredBeforeOldRelease: true,
        queued: triggerQueued, delivered: triggerDelivered },
      activationRetainedEpochs: { alpha: activated.alpha.epochs.length, beta: activated.beta.epochs.length },
      barrier, processCut, queued, delivered,
    };
  };

  const runExactFaultStageMatrix = async () => {
    const started = Date.now();
    faultDeadline = Date.now() + options.faultTotalTimeoutMs;
    for (const stage of ["offer", "accept", "finish", "ready", "commit", "done"]) {
      await scenario(`exact-v2-${stage}-suppression-process-restart`, () => runHandshakeFaultStage(stage));
    }
    await scenario("exact-v2-data-suppression-process-restart", runDataFaultStage);
    await scenario("exact-v2-ack-after-receive-suppression-process-restart", runAckFaultStage);
    for (const stage of ["close", "close_ready", "close_commit", "close_ack"]) {
      await scenario(`exact-v2-${stage}-suppression-process-restart`, () => runCloseFaultStage(stage));
    }
    await establishManualPq("post exact-stage matrix");
    const rotationStarted = Date.now();
    for (const stage of PQ_ROTATION_FAULT_STAGES) {
      await scenario(`exact-v2-rotation-${stage}-suppression-process-restart`, () => runRotationFaultStage(stage));
    }
    receipt.rotationFaults.completedStages = [...PQ_ROTATION_FAULT_STAGES];
    receipt.rotationFaults.durationMs = Date.now() - rotationStarted;
    await screenshot(alpha, "07-exact-stage-matrix-recovered-alpha.png");
    receipt.faultStages.completedStages = [...PQ_FAULT_STAGES];
    receipt.faultStages.durationMs = Date.now() - started;
  };

  try {
    await scenario("two-isolated-full-processes-and-friendship", async () => {
      await Promise.all([alpha.start(), beta.start()]);
      const [alphaNetwork, betaNetwork] = await Promise.all([
        alpha.invoke("get_network_settings"),
        beta.invoke("get_network_settings"),
      ]);
      check(alphaNetwork?.udpEnabled === true && alphaNetwork?.localDiscoveryEnabled === true, "alpha LAN discovery was not enabled in the disposable root");
      check(betaNetwork?.udpEnabled === true && betaNetwork?.localDiscoveryEnabled === true, "beta LAN discovery was not enabled in the disposable root");

      const [alphaCreated, betaCreated] = await Promise.all([
        alpha.invoke("create_profile", { name: "PQ Fault Alpha", password: null }),
        beta.invoke("create_profile", { name: "PQ Fault Beta", password: null }),
      ]);
      const alphaProfiles = alphaCreated?.profiles;
      const betaProfiles = betaCreated?.profiles;
      check(alphaProfiles?.some((profile) => profile.active && profile.loaded), "alpha synthetic profile was not active and loaded");
      check(betaProfiles?.some((profile) => profile.active && profile.loaded), "beta synthetic profile was not active and loaded");
      activeProfileIds = {
        alpha: alphaProfiles.find((profile) => profile.active && profile.loaded).id,
        beta: betaProfiles.find((profile) => profile.active && profile.loaded).id,
      };
      await Promise.all([
        selectFastInitialConnectionPreset(alpha, options.startupTimeoutMs),
        selectFastInitialConnectionPreset(beta, options.startupTimeoutMs),
      ]);
      const faultSupport = options.faultStages
        ? await Promise.all([
            waitFaultTestSupport(alpha, options.startupTimeoutMs),
            waitFaultTestSupport(beta, options.startupTimeoutMs),
          ])
        : [];

      const [alphaToxId, betaToxId] = await Promise.all([
        alpha.invoke("get_tox_id"),
        beta.invoke("get_tox_id"),
      ]);
      alphaPublicKey = publicKeyFromToxId(alphaToxId, "alpha");
      betaPublicKey = publicKeyFromToxId(betaToxId, "beta");
      check(alphaPublicKey !== betaPublicKey, "synthetic clients unexpectedly shared one Tox identity");

      const [alphaFriendNumber, betaFriendNumber] = await Promise.all([
        alpha.invoke("add_tox_friend", { toxId: betaToxId, message: "PQ two-instance synthetic authorization" }),
        beta.invoke("add_tox_friend", { toxId: alphaToxId, message: "PQ two-instance synthetic authorization" }),
      ]);
      check(Number.isInteger(alphaFriendNumber) && Number.isInteger(betaFriendNumber), "reciprocal friend creation did not return friend numbers");
      await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      await waitPairPqCapable(alpha, beta, friendNumbers, options.timeoutMs);
      return {
        checks: ["distinct portable roots", "distinct Tox identities", "reciprocal friends authorized", "both friend entries online", "LAN discovery enabled"],
        faultSupport,
      };
    });

    if (options.offlineFirstOrdinary) {
      await scenario("offline-first-ordinary-queues-survive-restart-and-late-capability", async () => {
        const peers = [
          { sender: alpha, receiver: beta, senderLabel: "alpha", receiverLabel: "beta", text: labelText("offline-first-alpha", "alpha", false), label: "offline-first-alpha" },
          { sender: beta, receiver: alpha, senderLabel: "beta", receiverLabel: "alpha", text: labelText("offline-first-beta", "beta", false), label: "offline-first-beta" },
        ];
        const waitBothOffline = () => waitUntil(async () => {
          const [a, b] = await Promise.all([getFriend(alpha, betaPublicKey), getFriend(beta, alphaPublicKey)]);
          if (a?.connection !== "offline" || b?.connection !== "offline") return undefined;
          friendNumbers = { alphaFriendNumber: a.number, betaFriendNumber: b.number };
          return true;
        }, options.timeoutMs, "both peers observed offline before ordinary first send", 100);
        const assertNoAutomaticPq = async (checkpoint, expectedSupported) => {
          const statuses = await pairPqStatus(alpha, beta, friendNumbers);
          for (const [label, status] of Object.entries(statuses)) {
            check(status.supported === expectedSupported, `${checkpoint}: ${label} retained a stale capability or missed the fresh marker`);
            check(status.auto_pending === false && status.identity_waiting === false, `${checkpoint}: ${label} opened automatic PQ or entropy`);
            check(status.identity_needs_entropy === true, `${checkpoint}: ${label} unexpectedly generated a long-term PQ identity`);
            check(["available", "unavailable"].includes(status.state) && !status.error, `${checkpoint}: ${label} entered PQ negotiation or error`);
          }
          return requirePqV2Pair(statuses, checkpoint);
        };
        const assertOrdinaryPending = async (checkpoint) => Promise.all(peers.map(async (entry) => {
          const rows = matchingTextRows(await messagesFor(entry.sender, friendNumberFor(entry.senderLabel)), entry.text);
          check(rows.length === 1, `${checkpoint}: ${entry.label} sender row was missing or duplicated`);
          const row = rows[0];
          check(row.mine === true && row.pq_protected === false, `${checkpoint}: ${entry.label} was not ordinary outgoing text`);
          check(row.protocol_version == null && (row.formatting ?? []).length === 0, `${checkpoint}: ${entry.label} retained unsupported metadata`);
          check(row.delivery !== "delivered" && row.delivery !== "failed", `${checkpoint}: ${entry.label} was not pending for the offline peer`);
          return { label: entry.label, senderCount: 1, pqProtected: false, delivery: row.delivery };
        }));
        await Promise.all([setUserStatus(alpha, "offline"), setUserStatus(beta, "offline")]);
        await waitBothOffline();
        const firstSends = await Promise.all(peers.map(async (entry) => {
          const started = performance.now();
          const result = await entry.sender.invoke("send_tox_message", {
            profileId: null, friendNumber: friendNumberFor(entry.senderLabel), text: entry.text,
            operationId: randomUUID(), quote: null, formatting: [],
          });
          const durationMs = Math.ceil(performance.now() - started);
          check(durationMs <= 5_000, `${entry.label}: ordinary first send waited longer than five seconds`);
          check(typeof result?.messageId === "string" && result.messageId.length > 0 && result.delivery !== "failed", `${entry.label}: ordinary first send was not durably accepted`);
          return { label: entry.label, durationMs, sendInvocations: 1 };
        }));
        const queuedBeforeRestart = await assertOrdinaryPending("before restart");
        const beforeRestart = await assertNoAutomaticPq("offline first send", false);
        await screenshot(alpha, "01-offline-first-ordinary-alpha.png");
        const originalProcesses = [alpha.child, beta.child];
        await Promise.all([alpha.hardKill(), beta.hardKill()]);
        check(originalProcesses.every((child) => child && (child.exitCode !== null || child.signalCode !== null)), "an exact original process remained alive after the offline cut");
        await Promise.all([alpha.start(), beta.start()]);
        await waitBothOffline();
        const queuedAfterRestart = await assertOrdinaryPending("after offline restart");
        const afterRestart = await assertNoAutomaticPq("after offline restart", false);
        await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
        friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
        await waitPairPqCapable(alpha, beta, friendNumbers, options.timeoutMs);
        const delivered = await Promise.all(peers.map((entry) => waitMessageExact({
          sender: entry.sender, receiver: entry.receiver,
          senderFriendNumber: friendNumberFor(entry.senderLabel), receiverFriendNumber: friendNumberFor(entry.receiverLabel),
          text: entry.text, label: entry.label, pqProtected: false, timeoutMs: options.timeoutMs,
        })));
        for (const entry of peers) {
          const label = `after-late-capability-${entry.senderLabel}`;
          const text = labelText(label, entry.senderLabel, false);
          await sendDurably(entry.sender, friendNumberFor(entry.senderLabel), text, options.timeoutMs);
          delivered.push(await waitMessageExact({
            sender: entry.sender, receiver: entry.receiver,
            senderFriendNumber: friendNumberFor(entry.senderLabel), receiverFriendNumber: friendNumberFor(entry.receiverLabel),
            text, label, pqProtected: false, timeoutMs: options.timeoutMs,
          }));
        }
        await delay(2_000);
        const afterLateCapability = await assertNoAutomaticPq("after late capability and subsequent sends", true);
        await screenshot(beta, "02-ordinary-after-late-marker-beta.png");
        return {
          firstSends, queuedBeforeRestart, beforeRestart, exactOriginalProcessesExited: true,
          queuedAfterRestart, afterRestart, freshBilateralCapabilityAfterReconnect: true,
          afterLateCapability, delivered, manualStartInvoked: false,
        };
      });
    } else if (options.offlinePeerFirst) {
      await scenario(`unilateral-offline-${options.offlinePeerFirst}-then-peer-first-auto-pq`, async () => {
        const firstLabel = `offline-peer-first-${options.offlinePeerFirst}`;
        const firstText = options.offlinePeerFirst === "text" ? labelText(firstLabel, "beta", false) : null;
        const image = options.offlinePeerFirst === "image"
          ? { filename: `pq-peer-first-${paths.runId.slice(-8)}.png`, bytes: syntheticPeerFirstPng(), ids: null } : null;
        const beforeHistories = await Promise.all([
          messagesFor(alpha, friendNumbers.alphaFriendNumber), messagesFor(beta, friendNumbers.betaFriendNumber),
        ]);
        check(beforeHistories.every((history) => history.every((row) => row.event)), "unilateral mode requires two fresh peers with no user messages");
        if (image) {
          const settings = await alpha.invoke("get_file_receive_settings", { profileId: activeProfileIds.alpha });
          await alpha.invoke("set_file_receive_settings", { profileId: activeProfileIds.alpha,
            settings: { ...settings, denyAll: false, autoAcceptImages: true, showImages: true, maxAutoBytes: Math.max(settings.maxAutoBytes, image.bytes.length) },
          });
        }
        await Promise.all([setUserStatus(alpha, "offline"), setUserStatus(beta, "offline")]);
        await waitUntil(async () => {
          const [a, b] = await Promise.all([getFriend(alpha, betaPublicKey), getFriend(beta, alphaPublicKey)]);
          if (a?.connection !== "offline" || b?.connection !== "offline") return undefined;
          friendNumbers = { alphaFriendNumber: a.number, betaFriendNumber: b.number };
          return true;
        }, options.timeoutMs, "both peers offline before unilateral beta first send", 100);
        const firstStarted = performance.now();
        const firstResult = image
          ? await beta.invoke("send_tox_file", { profileId: activeProfileIds.beta, friendNumber: friendNumbers.betaFriendNumber,
              filename: image.filename, mime: "image/png", bytes: Array.from(image.bytes) })
          : await beta.invoke("send_tox_message", { profileId: activeProfileIds.beta, friendNumber: friendNumbers.betaFriendNumber,
              text: firstText, operationId: randomUUID(), quote: null, formatting: [] });
        const firstSendDurationMs = Math.ceil(performance.now() - firstStarted);
        check(firstSendDurationMs <= 5_000, "unilateral offline first send waited longer than five seconds");
        if (image) check(Number.isInteger(firstResult), "synthetic image queue returned an invalid result");
        else check(typeof firstResult?.messageId === "string" && firstResult.delivery !== "failed", "unilateral first text was not accepted durably");
        const betaHistory = await messagesFor(beta, friendNumbers.betaFriendNumber);
        const queuedRows = image ? betaHistory.filter((row) => row.attachment?.name === image.filename) : matchingTextRows(betaHistory, firstText);
        check(queuedRows.length === 1 && queuedRows[0].mine === true && queuedRows[0].pq_protected === false,
          "unilateral first send did not create exactly one ordinary outgoing row");
        const queuedRow = queuedRows[0];
        check(typeof queuedRow.id === "string" && queuedRow.id.length > 0 && !["delivered", "failed"].includes(queuedRow.delivery),
          "unilateral offline first row was not durable and pending");
        if (image) {
          check(queuedRow.attachment.image === true && queuedRow.attachment.transfer_state === "queued"
            && queuedRow.attachment.size === image.bytes.length, "offline image did not remain a queued PNG");
          image.ids = { sender: queuedRow.id };
        } else check(queuedRow.id === firstResult.messageId, "ordinary first text changed identity after queueing");
        const alphaBeforeReply = await messagesFor(alpha, friendNumbers.alphaFriendNumber);
        check(alphaBeforeReply.every((row) => row.event), "alpha sent or received a user message before offline beta queueing completed");
        const offlineStatuses = await pairPqStatus(alpha, beta, friendNumbers);
        for (const [label, status] of Object.entries(offlineStatuses)) {
          check(!status.supported && !status.auto_pending && !status.identity_waiting && status.identity_needs_entropy
            && status.state === "unavailable" && !status.error, `${label} opened PQ while only beta queued an offline first item`);
        }
        await screenshot(beta, `01-unilateral-offline-${options.offlinePeerFirst}-beta.png`);
        await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
        friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
        await waitPairPqCapable(alpha, beta, friendNumbers, options.timeoutMs);
        let firstDelivery;
        let firstIds;
        if (image) {
          const delivered = await waitPeerFirstImageExact({ sender: beta, receiver: alpha,
            senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber, image, timeoutMs: options.timeoutMs });
          image.ids = delivered.ids;
          firstIds = delivered.ids;
          firstDelivery = delivered.evidence;
        } else {
          firstDelivery = await waitMessageExact({ sender: beta, receiver: alpha,
            senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber,
            text: firstText, label: firstLabel, pqProtected: false, timeoutMs: options.timeoutMs });
          firstIds = await textMessageIds({ sender: beta, receiver: alpha,
            senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber,
            text: firstText, expected: { sender: queuedRow.id } });
        }
        const beforeReply = await pairPqStatus(alpha, beta, friendNumbers);
        for (const [label, status] of Object.entries(beforeReply)) {
          check(status.supported && !status.auto_pending && !status.identity_waiting && status.identity_needs_entropy
            && status.state === "available" && !status.error, `${label} started late automatic PQ before alpha's first reply`);
        }
        const replyLabel = "online-first-reply-alpha";
        const replyText = labelText(replyLabel);
        const replyResult = await sendDurably(alpha, friendNumbers.alphaFriendNumber, replyText, options.timeoutMs);
        await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, replyText, replyLabel);
        await waitUntil(async () => {
          const statuses = await pairPqStatus(alpha, beta, friendNumbers);
          for (const [label, status] of Object.entries(statuses)) {
            check(!status.error, `${label} failed unilateral automatic PQ: ${sanitizeDiagnostic(status.error)}`);
          }
          return statuses.alpha.state === "active" && statuses.beta.state === "active" ? true : undefined;
        }, options.timeoutMs, "alpha first reply automatically activates PQ without beta cancelling", 100);
        const active = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
        const replyDelivery = await waitMessageExact({ sender: alpha, receiver: beta,
          senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber,
          text: replyText, label: replyLabel, pqProtected: true, timeoutMs: options.timeoutMs });
        const replyIds = await textMessageIds({ sender: alpha, receiver: beta,
          senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber,
          text: replyText, expected: { sender: replyResult.messageId } });
        peerFirstProof = { image, firstText, firstIds, replyText, replyIds };
        let imageRendered = null;
        if (image) {
          await alpha.cdp.send("Page.bringToFront");
          await waitUntil(() => alpha.evaluate(`(() => {
            const contacts = document.querySelectorAll('.chat-item');
            if (contacts.length !== 1 || !(contacts[0] instanceof HTMLButtonElement)) return undefined;
            contacts[0].click();
            return true;
          })()`), options.startupTimeoutMs, "open the synthetic image recipient chat");
          imageRendered = await waitUntil(() => alpha.evaluate(`(() => {
            const row = Array.from(document.querySelectorAll('[data-message-key]')).find((node) => node.dataset.messageKey === ${JSON.stringify(image.ids.receiver)});
            const image = row?.querySelector('img');
            const bounds = image?.getBoundingClientRect();
            return image?.complete && image.naturalWidth === 16 && image.naturalHeight === 16 && bounds?.width > 0 && bounds.height > 0
              ? { width: image.naturalWidth, height: image.naturalHeight } : undefined;
          })()`), options.startupTimeoutMs, "the received synthetic PNG decodes in the real chat");
        }
        await screenshot(alpha, `02-unilateral-${options.offlinePeerFirst}-auto-pq-alpha.png`);
        return { firstSendDurationMs, offline: requirePqV2Pair(offlineStatuses, "unilateral offline queue"),
          firstDelivery: { ...firstDelivery, ...safeMessageIds(firstIds) }, beforeReply: requirePqV2Pair(beforeReply, "before alpha first reply"),
          pq: active, replyDelivery: { ...replyDelivery, ...safeMessageIds(replyIds) }, imageRendered,
          firstSender: "beta", automaticInitiator: "alpha", manualStartInvoked: false, cancelCommandInvoked: false,
          pqUserDecisionCommandsForbidden: true };
      });
    } else {
    await scenario("online-crossed-first-send-auto-pq-and-ui-responsiveness", async () => {
      await startUiResponsivenessProbe(alpha, options.startupTimeoutMs);
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      await waitPairPqCapable(alpha, beta, friendNumbers, options.timeoutMs);
      const alphaFirst = labelText("cross-first-alpha");
      const betaFirst = labelText("cross-first-beta", "beta");
      const burst = Array.from({ length: 4 }, (_, index) => ({
        label: `queued-burst-alpha-${index + 1}`,
        text: labelText(`queued-burst-alpha-${index + 1}`),
      }));
      const queueTyping = typeIntoComposerProbe(alpha);
      await Promise.all([
        sendDurably(alpha, friendNumbers.alphaFriendNumber, alphaFirst, options.timeoutMs),
        sendDurably(beta, friendNumbers.betaFriendNumber, betaFirst, options.timeoutMs),
        ...burst.map(({ text }) => sendDurably(alpha, friendNumbers.alphaFriendNumber, text, options.timeoutMs)),
        queueTyping,
      ]);
      const queueTypingResult = await queueTyping;
      const queued = await Promise.all([
        assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, alphaFirst, "cross-first-alpha"),
        assertQueuedProtected(beta, friendNumbers.betaFriendNumber, betaFirst, "cross-first-beta"),
        ...burst.map(({ label, text }) => assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, label)),
      ]);
      const held = await pairPqStatus(alpha, beta, friendNumbers);
      check(
        Object.values(held).every((status) => status.auto_pending === true || PROTECTED_STATES.has(status.state)),
        "online crossed first sends neither entered automatic PQ nor activated a protected session",
      );
      const heldV2 = requirePqV2Pair(held, "online automatic first-send gate");
      const handshakeTyping = typeIntoComposerProbe(alpha);
      const active = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
      const delivered = await Promise.all([
        waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text: alphaFirst, label: "cross-first-alpha", pqProtected: true, timeoutMs: options.timeoutMs }),
        waitMessageExact({ sender: beta, receiver: alpha, senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber, text: betaFirst, label: "cross-first-beta", pqProtected: true, timeoutMs: options.timeoutMs }),
        ...burst.map(({ label, text }) => waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label, pqProtected: true, timeoutMs: options.timeoutMs })),
      ]);
      const typing = await handshakeTyping;
      const responsiveness = await finishUiResponsivenessProbe(alpha);
      await screenshot(alpha, "01-online-auto-pq-alpha.png");
      return {
        queued,
        held: heldV2,
        bothPeersOnlineBeforeFirstSend: true,
        freshBilateralCapabilitiesBeforeFirstSend: true,
        manualStartInvoked: false,
        pq: active,
        delivered,
        uiResponsiveness: {
          ...responsiveness,
          queueInputEvents: queueTypingResult.inputEvents,
          handshakeInputEvents: typing.inputEvents,
          typedCharacters: queueTypingResult.typedCharacters + typing.typedCharacters,
          composerCleared: queueTypingResult.composerCleared && typing.composerCleared,
          interpretation: "measured only; no hardware-independent latency threshold or performance claim",
        },
      };
    });

    await scenario("active-pq-bidirectional-message-ratchets", async () => {
      const activeBefore = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
      const alphaText = labelText("active-alpha");
      const betaText = labelText("active-beta", "beta");
      await Promise.all([
        sendDurably(alpha, friendNumbers.alphaFriendNumber, alphaText, options.timeoutMs),
        sendDurably(beta, friendNumbers.betaFriendNumber, betaText, options.timeoutMs),
      ]);
      const delivered = await Promise.all([
        waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text: alphaText, label: "active-alpha", pqProtected: true, timeoutMs: options.timeoutMs }),
        waitMessageExact({ sender: beta, receiver: alpha, senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber, text: betaText, label: "active-beta", pqProtected: true, timeoutMs: options.timeoutMs }),
      ]);
      await screenshot(beta, "02-active-bidirectional-beta.png");
      return { pq: activeBefore, delivered };
    });

    await scenario("sender-hard-restart-with-pending-pq-ciphertext", async () => {
      await setUserStatus(beta, "offline");
      await delay(750);
      const text = labelText("sender-restart-pending");
      await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, options.timeoutMs);
      const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, "sender-restart-pending");
      check(queued.delivery !== "delivered", "sender restart checkpoint already had a delivery receipt");
      await alpha.hardKill();
      await alpha.start();
      await setUserStatus(alpha, "online");
      const alphaFriend = await getFriend(alpha, betaPublicKey);
      check(alphaFriend, "alpha did not restore the durable friend after restart");
      friendNumbers.alphaFriendNumber = alphaFriend.number;
      await setUserStatus(beta, "online");
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      const active = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
      const delivered = await waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label: "sender-restart-pending", pqProtected: true, timeoutMs: options.timeoutMs });
      await screenshot(alpha, "03-sender-restart-recovered-alpha.png");
      return { cut: "exact alpha PID after durable enqueue and before receipt", pq: active, delivered };
    });

    await scenario("receiver-process-absent-while-pq-ciphertext-pending", async () => {
      await setUserStatus(beta, "offline");
      await delay(750);
      const text = labelText("receiver-absent-pending");
      await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, options.timeoutMs);
      const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, "receiver-absent-pending");
      check(queued.delivery !== "delivered", "receiver-absent checkpoint unexpectedly had an acknowledgement");
      await beta.hardKill();
      await beta.start();
      const betaFriend = await getFriend(beta, alphaPublicKey);
      check(betaFriend, "beta did not restore the durable friend after restart");
      friendNumbers.betaFriendNumber = betaFriend.number;
      await setUserStatus(beta, "online");
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      const active = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
      const delivered = await waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label: "receiver-absent-pending", pqProtected: true, timeoutMs: options.timeoutMs });
      await screenshot(beta, "04-recipient-restart-recovered-beta.png");
      return { cut: "exact beta PID while it was offline and alpha retained protected ciphertext without acknowledgement", pq: active, delivered };
    });

    if (options.faultStages) {
      await runExactFaultStageMatrix();
    }

    await scenario("old-epoch-backlog-drains-before-bilateral-shutdown", async () => {
      await setUserStatus(beta, "offline");
      await delay(750);
      const text = labelText("old-epoch-backlog");
      await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, options.timeoutMs);
      const queued = await assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, text, "old-epoch-backlog");
      check(queued.delivery !== "delivered", "old-epoch checkpoint unexpectedly drained while peer was offline");
      const closing = await alpha.invoke("request_pq_shutdown", { friendNumber: friendNumbers.alphaFriendNumber });
      check(PROTECTED_STATES.has(closing.state) && closing.state !== "active", "manual PQ shutdown did not retain the protected epoch while backlog existed");
      check(closing.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, "shutdown checkpoint fell back from PQv2");

      await setUserStatus(beta, "online");
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      const delivered = await waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label: "old-epoch-backlog", pqProtected: true, timeoutMs: options.timeoutMs });
      const stopped = await waitPairPqStopped(alpha, beta, friendNumbers, options.timeoutMs);
      await screenshot(alpha, "05-old-epoch-drained-alpha.png");
      return { queued, closing: safePqStatus(closing), delivered, stopped };
    });

    await scenario("manual-shutdown-survives-restart-without-auto-pq", async () => {
      await Promise.all([alpha.hardKill(), beta.hardKill()]);
      await Promise.all([alpha.start(), beta.start()]);
      await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      const beforeSend = await waitPairPqStopped(alpha, beta, friendNumbers, options.timeoutMs);
      const text = labelText("manual-only-plain", "alpha", false);
      await sendDurably(alpha, friendNumbers.alphaFriendNumber, text, options.timeoutMs);
      const delivered = await waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label: "manual-only-plain", pqProtected: false, timeoutMs: options.timeoutMs });
      await delay(2_000);
      const afterSendRaw = await pairPqStatus(alpha, beta, friendNumbers);
      const afterSend = requirePqV2Pair(afterSendRaw, "manual-only restart/send");
      check(!PROTECTED_STATES.has(afterSendRaw.alpha.state) && !PROTECTED_STATES.has(afterSendRaw.beta.state), "manual-only contact automatically re-established PQ after restart");
      check(afterSendRaw.alpha.auto_pending === false && afterSendRaw.beta.auto_pending === false, "manual-only contact reopened the automatic gate");
      await screenshot(alpha, "06-manual-only-after-restart-alpha.png");
      return { beforeSend, afterSend, delivered };
    });

    }

    await scenario("final-no-loss-no-duplicates-readback", async () => {
      await delay(2_000);
      const expected = [...expectedRows];
      const [alphaHistory, betaHistory] = await Promise.all([
        messagesFor(alpha, friendNumbers.alphaFriendNumber),
        messagesFor(beta, friendNumbers.betaFriendNumber),
      ]);
      const finalPq = requirePqV2Pair(await pairPqStatus(alpha, beta, friendNumbers), "final readback");
      receipt.finalHistoryReadback = observeHistoryRows({ expected, alphaHistory, betaHistory });
      const delivered = assertFinalHistoryRows({ expected, alphaHistory, betaHistory });
      let unilateralFirstSend = null;
      if (peerFirstProof) {
        check(finalPq.alpha.state === "active" && finalPq.beta.state === "active", "unilateral first-send PQ did not remain active");
        const replyIds = requireStableMessageIds(matchingTextRows(alphaHistory, peerFirstProof.replyText)[0],
          matchingTextRows(betaHistory, peerFirstProof.replyText)[0], peerFirstProof.replyIds);
        const first = peerFirstProof.image
          ? (await waitPeerFirstImageExact({ sender: beta, receiver: alpha,
              senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber,
              image: peerFirstProof.image, timeoutMs: options.timeoutMs })).evidence
          : safeMessageIds(requireStableMessageIds(matchingTextRows(betaHistory, peerFirstProof.firstText)[0],
              matchingTextRows(alphaHistory, peerFirstProof.firstText)[0], peerFirstProof.firstIds));
        unilateralFirstSend = { first, reply: safeMessageIds(replyIds), stableMessageIds: true };
      }
      return { expectedMessages: expected.length, exactSenderRows: expected.length, exactReceiverRows: expected.length, pq: finalPq, delivered,
        ...(unilateralFirstSend ? { unilateralFirstSend } : {}) };
    });

    receipt.status = "pass";
  } catch (error) {
    failure = error;
    receipt.status = "fail";
    receipt.failure = {
      type: error?.name ?? "Error",
      message: sanitizeDiagnostic(error?.message ?? error, replacements),
    };
    if (rotationFailureEvidence && receipt.scenarios.at(-1)?.name
      === `exact-v2-rotation-${rotationFailureEvidence.stage}-suppression-process-restart`) {
      receipt.rotationFailure = structuredClone(rotationFailureEvidence);
    }
    if (friendNumbers) {
      try {
        const snapshots = await Promise.all([alpha, beta].map(async (client) => {
          if (!client.isRunning() || !client.cdp) return { pq: null, history: null };
          const friendNumber = friendNumbers[`${client.label}FriendNumber`];
          const [status, history] = await Promise.allSettled([
            client.invoke("get_pq_status", { friendNumber }),
            messagesFor(client, friendNumber),
          ]);
          return {
            pq: status.status === "fulfilled" ? safePqStatus(status.value) : null,
            history: history.status === "fulfilled" ? history.value : null,
          };
        }));
        receipt.failureSnapshot = {
          pq: { alpha: snapshots[0].pq, beta: snapshots[1].pq },
          historyAvailable: { alpha: snapshots[0].history !== null, beta: snapshots[1].history !== null },
          messages: observeHistoryRows({
            expected: expectedRows,
            alphaHistory: snapshots[0].history,
            betaHistory: snapshots[1].history,
          }),
        };
      } catch { /* Keep the original failure if a stopped native bridge cannot be read. */ }
    }
    for (const client of [alpha, beta]) {
      if (client.isRunning() && client.cdp) {
        try { await screenshot(client, `failure-${client.label}.png`); } catch { /* Preserve the original failed gate. */ }
      }
    }
  } finally {
    const ownedChildren = [alpha.child, beta.child];
    const stopResults = await Promise.allSettled([alpha.stop(), beta.stop()]);
    const liveChildren = ownedChildren.filter((child) => child && child.exitCode === null && child.signalCode === null);
    const stopFailures = stopResults.filter((result) => result.status === "rejected");
    receipt.processCleanup = { capturedOwnedProcesses: ownedChildren.filter(Boolean).length, allExited: liveChildren.length === 0, stopFailures: stopFailures.length };
    if (liveChildren.length || stopFailures.length) {
      const cleanupError = new HarnessInvariantError(
        liveChildren.length ? "An exact owned Kaigen process did not confirm exit; disposable profiles retained" : "An owned Kaigen process reported a shutdown failure",
      );
      const message = sanitizeDiagnostic(cleanupError.message, replacements);
      receipt.status = "fail";
      if (!failure) {
        failure = cleanupError;
        receipt.failure = { type: cleanupError.name, message };
      } else {
        receipt.cleanupFailure = message;
      }
    }
    if (!options.keepProfiles && liveChildren.length === 0) {
      try {
        await removeDisposableProfiles(paths, paths.runId);
        receipt.profilesDisposed = true;
      } catch (cleanupError) {
        const message = sanitizeDiagnostic(cleanupError?.message ?? cleanupError, replacements);
        if (!failure) {
          failure = cleanupError;
          receipt.status = "fail";
          receipt.failure = { type: cleanupError?.name ?? "Error", message };
        } else {
          receipt.cleanupFailure = message;
        }
      }
    }
    receipt.completedAt = new Date().toISOString();
    await writeReceipt(receiptPath, receipt);
  }

  if (failure) {
    console.error(`[pq-two-instances] FAIL: ${receipt.failure?.message ?? "see sanitized receipt"}`);
    console.error(`[pq-two-instances] receipt: ${receiptPath}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[pq-two-instances] PASS: ${expectedRows.length} exact plaintext deliveries${peerFirstProof?.image ? ", 1 exact image transfer" : ""}, PQ protocol ${EXPECTED_PQ_PROTOCOL_VERSION}, no duplicates`);
  console.log(`[pq-two-instances] receipt: ${receiptPath}`);
}

export {
  runsRoot as nativeRunsRoot, resolveRunIdentity,
  PQ_FAULT_STAGES, PQ_ROTATION_FAULT_STAGES,
  KaigenProcess, NativeCommandError, parseArguments, preparePaths, freeLoopbackPort, check, waitUntil,
  publicKeyFromToxId, waitPairOnline, waitPairPqCapable, sendDurably, waitPairPqActive, waitMessageExact,
  messagesFor, safePqStatus, sha256File, sanitizeDiagnostic, removeDisposableProfiles,
  writeReceipt, setUserStatus, selectFastInitialConnectionPreset, requireWebViewPathBudget,
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else if (options.selfTest) {
    await selfTest();
  } else {
    await runHarness(options);
  }
}
