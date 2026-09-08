import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const repository = path.resolve(import.meta.dirname, "..");
const taskRoot = path.resolve(repository, "..", "context.local", "work", "20260908-pq-forward-secrecy");
const runsRoot = path.join(taskRoot, "two-instance-runs");
const EXPECTED_PQ_PROTOCOL_VERSION = 2;
const PQ_FAULT_FEATURE = "pq-fault-tests";
const PQ_FAULT_SCHEMA_VERSION = 1;
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
const HANDSHAKE_FAULT_TARGET = Object.freeze({
  offer: "alpha",
  accept: "beta",
  finish: "alpha",
  ready: "beta",
  commit: "alpha",
  done: "beta",
});
const RETRYABLE_SEND_ERRORS = new Set([
  "PQ_AUTO_ALREADY_NEGOTIATING",
  "PQ_OUTBOX_BACKPRESSURE",
  "PQ_SESSION_WAIT",
]);
const PROTECTED_STATES = new Set(["active", "closing", "closing_commit", "closing_ack", "closing_final"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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
  --fault-stages               Require a dedicated --features pq-fault-tests artifact and run every exact v2 cut
  --fault-total-timeout-ms <ms> Overall exact-stage matrix budget, 300000..3600000 (default 1800000)
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
    else if (argument === "--self-test") options.selfTest = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
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

class KaigenProcess {
  constructor({ label, executable, root, port, startupTimeoutMs, faultTest = null }) {
    this.label = label;
    this.executable = executable;
    this.root = root;
    this.port = port;
    this.startupTimeoutMs = startupTimeoutMs;
    this.faultTest = faultTest;
    this.child = null;
    this.cdp = null;
    this.spawnError = null;
  }

  isRunning() {
    return this.child && this.child.exitCode === null && this.child.signalCode === null;
  }

  async start(startupTimeoutMs = this.startupTimeoutMs) {
    check(!this.isRunning(), `${this.label} was already running`);
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

  async captureScreenshot(destination) {
    await this.evaluate(`(() => {
      let style = document.getElementById("kaigen-pq-e2e-redaction");
      if (!style) {
        style = document.createElement("style");
        style.id = "kaigen-pq-e2e-redaction";
        style.textContent = ".pq-history-fingerprints code,.own-tox-id code,.tox-id{visibility:hidden!important}";
        document.head.appendChild(style);
      }
      return true;
    })()`);
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1024,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const result = await this.cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    }, 15_000);
    const bytes = Buffer.from(String(result.data ?? ""), "base64");
    check(bytes.length > 1_000 && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE), `${this.label} screenshot was not a valid PNG`);
    await writeFile(destination, bytes, { flag: "wx" });
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

async function armFaultTest(client, friendNumber, stage) {
  check(PQ_FAULT_STAGES.includes(stage), `unknown PQ fault-test stage: ${stage}`);
  check(Number.isInteger(friendNumber) && friendNumber >= 0, `${client.label} fault arm received an invalid friend number`);
  await clearFaultTestArm(client);
  await writeJsonAtomic(faultTestFile(client, "arm.json"), {
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce: client.faultTest.nonce,
    friendNumber,
    stage,
  });
}

async function waitFaultTestTriggered(client, stage, timeoutMs) {
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
  return {
    stage,
    triggered: true,
    suppressedBeforeTransport: true,
    blocksPeerV2UntilProcessExit: true,
  };
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
    return stopped ? current : undefined;
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
    check(senderRows[0].delivery === "delivered", `${label}: final sender receipt was not delivered`);
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

async function startUiResponsivenessProbe(client, timeoutMs) {
  await client.cdp.send("Page.bringToFront");
  await waitUntil(async () => {
    const ready = await client.evaluate(`(() => {
      if (document.querySelector(".compose-row textarea")) return true;
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
    const area = document.querySelector(".compose-row textarea");
    if (!(area instanceof HTMLTextAreaElement)) return false;
    area.focus();
    return document.activeElement === area;
  })()`);
  check(focused === true, `${client.label} could not focus the real chat composer`);
  for (let index = 0; index < characterCount; index += 1) {
    await client.cdp.send("Input.insertText", { text: index % 2 === 0 ? "k" : "a" });
    await delay(12);
  }
  const typedLength = await client.evaluate("document.querySelector('.compose-row textarea')?.value.length ?? -1");
  check(typedLength >= characterCount, `${client.label} composer did not retain the synthetic typing probe`);
  const cleared = await client.evaluate(`(() => {
    const area = document.querySelector(".compose-row textarea");
    if (!(area instanceof HTMLTextAreaElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    if (!setter) return false;
    setter.call(area, "");
    area.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    return area.value === "";
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

async function preparePaths(options) {
  await mkdir(runsRoot, { recursive: true });
  const runId = `pq-two-instances-${new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
  const requestedRunRoot = options.runRoot ? path.resolve(options.runRoot) : path.join(runsRoot, runId);
  requireWithin(runsRoot, requestedRunRoot, "run root");
  check(path.basename(requestedRunRoot).startsWith("pq-two-instances-"), "run root basename must start with pq-two-instances-");
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
  assert.equal(sanitizeDiagnostic(`${"A".repeat(64)} ${randomUUID()}`).includes("[redacted-id]"), true);
  assert.equal(sanitizeDiagnostic(`${"A".repeat(64)} ${randomUUID()}`).includes("[redacted-operation]"), true);
  assert.equal(parseArguments(["--timeout-ms", "30000", "--debug-ports", "9201,9202"]).debugPorts.length, 2);
  const faultOptions = parseArguments(["--fault-stages", "--fault-total-timeout-ms", "300000"]);
  assert.equal(faultOptions.faultStages, true);
  assert.equal(faultOptions.faultTotalTimeoutMs, 300_000);
  const nonce = randomUUID();
  assert.equal(validateFaultSupport({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce,
    supported: true,
    feature: PQ_FAULT_FEATURE,
    stages: [...PQ_FAULT_STAGES],
  }, nonce, "self-test").stages.length, PQ_FAULT_STAGES.length);
  assert.throws(() => validateFaultSupport({
    schemaVersion: PQ_FAULT_SCHEMA_VERSION,
    nonce,
    supported: true,
    feature: PQ_FAULT_FEATURE,
    stages: [...PQ_FAULT_STAGES].reverse(),
  }, nonce, "self-test"));
  assert.throws(() => parseArguments(["--debug-ports", "9201,9201"]));
  console.log("PQ two-instance harness self-test passed (path boundary, redaction, CLI, exact fault-hook contract).");
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
    faultStages: {
      requested: options.faultStages,
      feature: options.faultStages ? PQ_FAULT_FEATURE : null,
      exactBarrierContract: options.faultStages,
      supportedStages: options.faultStages ? [...PQ_FAULT_STAGES] : [],
      totalTimeoutMs: options.faultStages ? options.faultTotalTimeoutMs : null,
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
  });
  const beta = new KaigenProcess({
    label: "beta",
    executable: paths.executable,
    root: betaRoot,
    port: ports[1],
    startupTimeoutMs: options.startupTimeoutMs,
    faultTest: betaFaultTest,
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
  let failure = null;

  const scenario = async (name, action) => {
    const started = Date.now();
    console.log(`[pq-two-instances] ${name}`);
    try {
      const details = await action();
      receipt.scenarios.push({ name, status: "pass", durationMs: Date.now() - started, ...details });
      await writeReceipt(receiptPath, receipt);
      return details;
    } catch (error) {
      receipt.scenarios.push({ name, status: "fail", durationMs: Date.now() - started });
      throw error;
    }
  };

  const screenshot = async (client, fileName) => {
    const destination = path.join(paths.evidenceRoot, fileName);
    await client.captureScreenshot(destination);
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

      const [alphaProfiles, betaProfiles] = await Promise.all([
        alpha.invoke("create_profile", { name: "PQ Fault Alpha", password: null }),
        beta.invoke("create_profile", { name: "PQ Fault Beta", password: null }),
      ]);
      check(alphaProfiles?.some((profile) => profile.active && profile.loaded), "alpha synthetic profile was not active and loaded");
      check(betaProfiles?.some((profile) => profile.active && profile.loaded), "beta synthetic profile was not active and loaded");
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
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      return {
        checks: ["distinct portable roots", "distinct Tox identities", "reciprocal friends authorized", "both friend entries online", "LAN discovery enabled"],
        faultSupport,
      };
    });

    await scenario("offline-crossed-first-send-auto-pq-and-negotiation-cut", async () => {
      await startUiResponsivenessProbe(alpha, options.startupTimeoutMs);
      await Promise.all([setUserStatus(alpha, "offline"), setUserStatus(beta, "offline")]);
      await delay(500);
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
      check(held.alpha.auto_pending === true && held.beta.auto_pending === true, "crossed first sends were not held by both automatic PQ gates");
      const heldV2 = requirePqV2Pair(held, "automatic first-send gate");

      await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);
      const handshakeTyping = typeIntoComposerProbe(alpha);
      const connectionCheckpoint = await waitUntil(async () => {
        const [alphaFriend, betaFriend] = await Promise.all([
          getFriend(alpha, betaPublicKey),
          getFriend(beta, alphaPublicKey),
        ]);
        return alphaFriend?.connection === "online" || betaFriend?.connection === "online"
          ? { alphaOnline: alphaFriend?.connection === "online", betaOnline: betaFriend?.connection === "online" }
          : undefined;
      }, options.timeoutMs, "first automatic PQ link checkpoint", 20);
      const beforeCut = await pairPqStatus(alpha, beta, friendNumbers);
      const beforeCutV2 = requirePqV2Pair(beforeCut, "connected automatic PQ checkpoint");
      check(
        beforeCut.alpha.state !== "active" || beforeCut.beta.state !== "active",
        "automatic PQ negotiation completed on both clients before the process cut checkpoint",
      );
      const beforeCutRows = await Promise.all([
        assertQueuedProtected(alpha, friendNumbers.alphaFriendNumber, alphaFirst, "cross-first-alpha"),
        assertQueuedProtected(beta, friendNumbers.betaFriendNumber, betaFirst, "cross-first-beta"),
      ]);
      check(beforeCutRows.some((row) => row.delivery !== "delivered"), "both first messages drained before the connected cut checkpoint was observable");
      await beta.hardKill();
      await waitUntil(async () => {
        const alphaFriend = await getFriend(alpha, betaPublicKey);
        return alphaFriend?.connection === "offline" ? true : undefined;
      }, options.timeoutMs, "alpha observing the killed beta transport as offline", 100);
      await beta.start();
      const restoredBetaFriend = await getFriend(beta, alphaPublicKey);
      check(restoredBetaFriend, "beta did not restore its durable friend after the negotiation cut");
      friendNumbers.betaFriendNumber = restoredBetaFriend.number;
      await setUserStatus(beta, "online");
      friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
      const active = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
      const delivered = await Promise.all([
        waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text: alphaFirst, label: "cross-first-alpha", pqProtected: true, timeoutMs: options.timeoutMs }),
        waitMessageExact({ sender: beta, receiver: alpha, senderFriendNumber: friendNumbers.betaFriendNumber, receiverFriendNumber: friendNumbers.alphaFriendNumber, text: betaFirst, label: "cross-first-beta", pqProtected: true, timeoutMs: options.timeoutMs }),
        ...burst.map(({ label, text }) => waitMessageExact({ sender: alpha, receiver: beta, senderFriendNumber: friendNumbers.alphaFriendNumber, receiverFriendNumber: friendNumbers.betaFriendNumber, text, label, pqProtected: true, timeoutMs: options.timeoutMs })),
      ]);
      const typing = await handshakeTyping;
      const responsiveness = await finishUiResponsivenessProbe(alpha);
      await screenshot(alpha, "01-auto-pq-recovered-alpha.png");
      return {
        queued,
        held: heldV2,
        connectionCheckpoint,
        beforeCut: beforeCutV2,
        cut: "exact beta PID after a real friend-online callback while PQ negotiation and at least one first delivery were incomplete",
        transportCutProof: { exactProcessExit: true, survivorObservedFriendOffline: true, reconnected: true },
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

    await scenario("final-no-loss-no-duplicates-readback", async () => {
      await delay(2_000);
      const expected = [...expectedRows];
      const [alphaHistory, betaHistory] = await Promise.all([
        messagesFor(alpha, friendNumbers.alphaFriendNumber),
        messagesFor(beta, friendNumbers.betaFriendNumber),
      ]);
      const finalPq = requirePqV2Pair(await pairPqStatus(alpha, beta, friendNumbers), "final readback");
      const delivered = assertFinalHistoryRows({ expected, alphaHistory, betaHistory });
      return { expectedMessages: expected.length, exactSenderRows: expected.length, exactReceiverRows: expected.length, pq: finalPq, delivered };
    });

    receipt.status = "pass";
  } catch (error) {
    failure = error;
    receipt.status = "fail";
    receipt.failure = {
      type: error?.name ?? "Error",
      message: sanitizeDiagnostic(error?.message ?? error, replacements),
    };
  } finally {
    await Promise.allSettled([alpha.stop(), beta.stop()]);
    if (!options.keepProfiles) {
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
  console.log(`[pq-two-instances] PASS: ${expectedRows.length} exact plaintext deliveries, PQ protocol ${EXPECTED_PQ_PROTOCOL_VERSION}, no duplicates`);
  console.log(`[pq-two-instances] receipt: ${receiptPath}`);
}

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  console.log(usage());
} else if (options.selfTest) {
  await selfTest();
} else {
  await runHarness(options);
}
