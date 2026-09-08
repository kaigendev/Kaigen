import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  KaigenProcess,
  check,
  freeLoopbackPort,
  messagesFor,
  parseArguments,
  preparePaths,
  publicKeyFromToxId,
  removeDisposableProfiles,
  safePqStatus,
  sanitizeDiagnostic,
  sendDurably,
  setUserStatus,
  sha256File,
  waitMessageExact,
  waitPairOnline,
  waitPairPqCapable,
  waitPairPqActive,
  waitUntil,
  writeReceipt,
} from "./test-pq-two-instances.mjs";

const EXPECTED_PQ_PROTOCOL_VERSION = 2;
const OBSERVATION_KEY = "__kaigenPqEntropyInvokeObservation";
const POINTER_OBSERVATION_KEY = "__kaigenPqEntropyPointerObservation";

function scanSerializedIdentityPayload(body, expectedFriendNumber) {
  const invalid = {
    bodyShape: false,
    extraNoiseLength: -1,
    byteShape: false,
    expectedFriend: false,
  };
  if (typeof body !== "string") return invalid;

  const firstNonWhitespace = (() => {
    for (let index = 0; index < body.length; index += 1) {
      if (!/\s/u.test(body[index])) return index;
    }
    return -1;
  })();
  let lastNonWhitespace = -1;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    if (!/\s/u.test(body[index])) {
      lastNonWhitespace = index;
      break;
    }
  }
  if (firstNonWhitespace < 0 || body[firstNonWhitespace] !== "{" || body[lastNonWhitespace] !== "}") return invalid;

  const afterUniqueKey = (key) => {
    const marker = `"${key}"`;
    const found = body.indexOf(marker);
    if (found < 0 || body.indexOf(marker, found + marker.length) >= 0) return -1;
    let cursor = found + marker.length;
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    if (body[cursor] !== ":") return -1;
    cursor += 1;
    while (/\s/u.test(body[cursor] ?? "")) cursor += 1;
    return cursor;
  };

  let friendCursor = afterUniqueKey("friendNumber");
  if (friendCursor < 0) return invalid;
  let friendSign = 1;
  if (body[friendCursor] === "-") {
    friendSign = -1;
    friendCursor += 1;
  }
  const friendStart = friendCursor;
  let friendNumber = 0;
  while (friendCursor < body.length && body.charCodeAt(friendCursor) >= 48 && body.charCodeAt(friendCursor) <= 57) {
    friendNumber = friendNumber * 10 + body.charCodeAt(friendCursor) - 48;
    friendCursor += 1;
  }
  if (friendCursor === friendStart || !Number.isSafeInteger(friendNumber)) return invalid;
  friendNumber *= friendSign;

  let noiseCursor = afterUniqueKey("extraNoise");
  if (noiseCursor < 0 || body[noiseCursor] !== "[") return invalid;
  noiseCursor += 1;
  let extraNoiseLength = 0;
  let byteShape = true;
  while (noiseCursor < body.length) {
    while (/\s/u.test(body[noiseCursor] ?? "")) noiseCursor += 1;
    if (body[noiseCursor] === "]") {
      noiseCursor += 1;
      break;
    }
    const numberStart = noiseCursor;
    let value = 0;
    while (noiseCursor < body.length && body.charCodeAt(noiseCursor) >= 48 && body.charCodeAt(noiseCursor) <= 57) {
      value = value * 10 + body.charCodeAt(noiseCursor) - 48;
      noiseCursor += 1;
    }
    if (noiseCursor === numberStart) return invalid;
    extraNoiseLength += 1;
    if (!Number.isSafeInteger(value) || value > 255) byteShape = false;
    while (/\s/u.test(body[noiseCursor] ?? "")) noiseCursor += 1;
    if (body[noiseCursor] === ",") {
      noiseCursor += 1;
      continue;
    }
    if (body[noiseCursor] === "]") {
      noiseCursor += 1;
      break;
    }
    return invalid;
  }
  while (/\s/u.test(body[noiseCursor] ?? "")) noiseCursor += 1;
  if (body[noiseCursor] !== "," && body[noiseCursor] !== "}") return invalid;
  return {
    bodyShape: true,
    extraNoiseLength,
    byteShape,
    expectedFriend: friendNumber === expectedFriendNumber,
  };
}

function usage() {
  return `Usage:
  node scripts/test-pq-native-entropy.mjs --artifact-root <fresh-portable-dir> [--exe <Kaigen.exe>] [options]

Options:
  --run-root <new-dir>          Exact new run directory below the canonical PQ two-instance runs directory
  --timeout-ms <ms>            Per network/delivery gate, 30000..600000 (default 180000)
  --startup-timeout-ms <ms>    Per process startup gate, 10000..180000 (default 60000)
  --debug-ports <alpha,beta>   Fixed loopback CDP ports; otherwise two free ports are selected
  --keep-profiles              Keep disposable profile roots after the run for a local retry
  --self-test                  Validate driver safety and metadata contracts without launching Kaigen
  --help                       Show this text

The artifact is read only. The driver uses two real Kaigen processes and the real entropy
panel. Its JSON receipt contains only command lengths, boolean input-path observations,
safe PQ status, delivery counts, and screenshot hashes; it omits raw entropy, input events,
keys, identifiers, and message text. Screenshots contain synthetic chat data and mask Tox
and PQ fingerprints.`;
}

function validateOptions(options) {
  check(options.faultStages !== true, "--fault-stages belongs to test-pq-two-instances.mjs and is not supported by the entropy driver");
}

async function prepareVisibleChat(client, timeoutMs) {
  await client.cdp.send("Page.bringToFront");
  await waitUntil(async () => {
    const ready = await client.evaluate(`(() => {
      window.focus();
      const splash = document.querySelector(".splash-screen");
      if (splash && splash.getBoundingClientRect().width > 0) return false;
      const chats = [...document.querySelectorAll(".chat-item")].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      });
      if (chats.length !== 1) return false;
      const area = document.querySelector(".compose-row textarea");
      if (!(area instanceof HTMLTextAreaElement) || area.getBoundingClientRect().width <= 0) chats[0].click();
      const selectedArea = document.querySelector(".compose-row textarea");
      if (!(selectedArea instanceof HTMLTextAreaElement)) return false;
      const bounds = selectedArea.getBoundingClientRect();
      return bounds.width > 0 && bounds.height > 0 && document.visibilityState === "visible";
    })()`);
    return ready === true ? true : undefined;
  }, timeoutMs, `${client.label} visible synthetic chat`, 50);
}

async function installInvokeObservation(client, expectedFriendNumber) {
  const installed = await client.evaluate(`(() => {
    const key = ${JSON.stringify(OBSERVATION_KEY)};
    if (globalThis[key]) return false;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    if (!descriptor?.writable || typeof descriptor.value !== "function") return false;
    const original = globalThis.fetch;
    const expectedFriendNumber = ${JSON.stringify(expectedFriendNumber)};
    const scanSerializedIdentityPayload = ${scanSerializedIdentityPayload.toString()};
    const records = [];
    function isIdentityIpc(input) {
      try {
        const raw = typeof input === "string" ? input
          : input instanceof URL ? input.href
            : typeof input?.url === "string" ? input.url : "";
        const url = new URL(raw, location.href);
        return url.hostname === "ipc.localhost"
          && decodeURIComponent(url.pathname.replace(/^\\/+/, "")) === "complete_pq_identity";
      } catch {
        return false;
      }
    }
    function wrapper(input, init) {
      if (!isIdentityIpc(input)) return Reflect.apply(original, this, [input, init]);
      const metadata = scanSerializedIdentityPayload(init?.body, expectedFriendNumber);
      const record = {
        call: records.length + 1,
        bodyShape: metadata.bodyShape,
        extraNoiseLength: metadata.extraNoiseLength,
        byteShape: metadata.byteShape,
        expectedFriend: metadata.expectedFriend,
        dispatched: true,
        responseReceived: false,
        transportRejected: false,
      };
      records.push(record);
      try {
        return Reflect.apply(original, this, [input, init]).then((response) => {
          record.responseReceived = true;
          return response;
        }, (error) => {
          record.transportRejected = true;
          throw error;
        });
      } catch (error) {
        record.transportRejected = true;
        throw error;
      }
    }
    globalThis.fetch = wrapper;
    if (globalThis.fetch !== wrapper) return false;
    globalThis[key] = { original, wrapper, records };
    return true;
  })()`);
  check(installed === true, `${client.label} could not install the pass-through Tauri IPC observation`);
}

async function readInvokeObservation(client) {
  return client.evaluate(`(() => {
    const state = globalThis[${JSON.stringify(OBSERVATION_KEY)}];
    if (!state) return null;
    return state.records.map((record) => ({
      call: record.call,
      bodyShape: record.bodyShape,
      extraNoiseLength: record.extraNoiseLength,
      byteShape: record.byteShape,
      expectedFriend: record.expectedFriend,
      dispatched: record.dispatched,
      responseReceived: record.responseReceived,
      transportRejected: record.transportRejected,
    }));
  })()`);
}

async function restoreInvokeObservation(client) {
  if (!client.cdp || !client.isRunning()) return;
  await client.evaluate(`(() => {
    const key = ${JSON.stringify(OBSERVATION_KEY)};
    const state = globalThis[key];
    if (!state) return false;
    if (globalThis.fetch === state.wrapper) globalThis.fetch = state.original;
    state.records.length = 0;
    delete globalThis[key];
    return true;
  })()`);
}

function verifyInvokeObservation(records, expectedLength, label) {
  check(Array.isArray(records) && records.length === 1, `${label} did not forward exactly one real complete_pq_identity command`);
  const record = records[0];
  check(record.call === 1, `${label} identity observation had an invalid call ordinal`);
  check(record.bodyShape === true, `${label} identity IPC payload did not have the expected serialized shape`);
  check(record.extraNoiseLength === expectedLength, `${label} forwarded the wrong optional-noise length`);
  check(record.byteShape === true, `${label} optional-noise input was not a byte array`);
  check(record.expectedFriend === true, `${label} identity completion targeted a different synthetic contact`);
  check(record.dispatched === true && record.responseReceived === true && record.transportRejected === false, `${label} real identity IPC did not receive a native response`);
  return {
    calls: 1,
    extraNoiseLength: expectedLength,
    byteShape: true,
    expectedContact: true,
    ipcDispatched: true,
    nativeResponseReceived: true,
  };
}

async function waitEntropyPanel(client, timeoutMs) {
  return waitUntil(async () => {
    const state = await client.evaluate(`(() => {
      const panel = document.querySelector(".pq-entropy-panel");
      const svg = document.querySelector(".pq-entropy-constellation");
      const system = document.querySelector(".pq-entropy-system");
      const proceed = document.querySelector(".pq-entropy-continue");
      if (!(panel instanceof HTMLElement) || !(svg instanceof SVGSVGElement)
        || !(system instanceof HTMLButtonElement) || !(proceed instanceof HTMLButtonElement)) return null;
      const panelBounds = panel.getBoundingClientRect();
      const svgBounds = svg.getBoundingClientRect();
      if (panelBounds.width <= 0 || panelBounds.height <= 0 || svgBounds.width <= 0 || svgBounds.height <= 0) return null;
      return { visible: true, systemEnabled: !system.disabled, proceedEnabled: !proceed.disabled };
    })()`);
    return state?.visible && state.systemEnabled && state.proceedEnabled ? true : undefined;
  }, timeoutMs, `${client.label} visible PQ entropy panel`, 25);
}

async function focusClient(client, timeoutMs) {
  await client.cdp.send("Page.bringToFront");
  await client.evaluate("(() => { window.focus(); return true; })()");
  await waitUntil(async () => {
    const focused = await client.evaluate("document.visibilityState === 'visible' && document.hasFocus()");
    return focused === true ? true : undefined;
  }, timeoutMs, `${client.label} foreground entropy interaction`, 20);
}

async function visibleBounds(client, selector) {
  const bounds = await client.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof Element)) return null;
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const bounds = element.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    if (element instanceof HTMLButtonElement && element.disabled) return null;
    return { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
  })()`);
  check(bounds && [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite), `${client.label} ${selector} was not interactable`);
  return bounds;
}

async function clickWithNativeMouse(client, selector) {
  const bounds = await visibleBounds(client, selector);
  const x = bounds.left + bounds.width / 2;
  const y = bounds.top + bounds.height / 2;
  await client.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await client.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function installPointerObservation(client) {
  const installed = await client.evaluate(`(() => {
    const key = ${JSON.stringify(POINTER_OBSERVATION_KEY)};
    if (globalThis[key]) return false;
    const svg = document.querySelector(".pq-entropy-constellation");
    if (!(svg instanceof SVGSVGElement)) return false;
    const state = { mouseMoved: false, touchMoved: false };
    const listener = (event) => {
      if (event.pointerType === "mouse") state.mouseMoved = true;
      if (event.pointerType === "touch") state.touchMoved = true;
    };
    svg.addEventListener("pointermove", listener, true);
    globalThis[key] = { svg, listener, state };
    return true;
  })()`);
  check(installed === true, `${client.label} could not observe real pointer-type delivery`);
}

async function finishPointerObservation(client) {
  const result = await client.evaluate(`(() => {
    const key = ${JSON.stringify(POINTER_OBSERVATION_KEY)};
    const state = globalThis[key];
    if (!state) return null;
    state.svg.removeEventListener("pointermove", state.listener, true);
    const result = { mouseMoved: state.state.mouseMoved, touchMoved: state.state.touchMoved };
    delete globalThis[key];
    return result;
  })()`);
  check(result?.mouseMoved === true, `${client.label} did not deliver CDP mouseMoved through the entropy SVG pointer path`);
  check(result?.touchMoved === true, `${client.label} did not deliver CDP touchMove through the entropy SVG pointer path`);
  return { mousePointerPathObserved: true, touchPointerPathObserved: true };
}

async function exerciseAlphaPointerPaths(client) {
  await focusClient(client, 2_000);
  await installPointerObservation(client);
  const bounds = await visibleBounds(client, ".pq-entropy-constellation");
  const point = (xRatio, yRatio) => ({
    x: bounds.left + bounds.width * xRatio,
    y: bounds.top + bounds.height * yRatio,
  });

  for (const [xRatio, yRatio] of [
    [0.08, 0.62], [0.18, 0.28], [0.30, 0.70], [0.42, 0.34],
    [0.55, 0.66], [0.68, 0.25], [0.80, 0.58], [0.92, 0.38],
  ]) {
    await client.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point(xRatio, yRatio), button: "none", buttons: 0 });
  }

  await client.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  try {
    const touchPoints = [[0.16, 0.72], [0.34, 0.42], [0.52, 0.74], [0.72, 0.36], [0.88, 0.62]];
    const first = point(...touchPoints[0]);
    await client.cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ ...first, radiusX: 1, radiusY: 1, force: 0.5, id: 17 }],
    });
    for (const ratios of touchPoints.slice(1)) {
      const current = point(...ratios);
      await client.cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ ...current, radiusX: 1, radiusY: 1, force: 0.5, id: 17 }],
      });
    }
    await client.cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await client.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false, maxTouchPoints: 1 }).catch(() => {});
  }
  return finishPointerObservation(client);
}

async function captureEvidence(client, evidenceRoot, fileName) {
  const destination = path.join(evidenceRoot, fileName);
  await client.captureScreenshot(destination, { waitForChat: false });
  const information = await stat(destination);
  return { file: fileName, bytes: information.size, sha256: await sha256File(destination), masked: true };
}

function plainMessageCount(messages) {
  return messages.filter((message) => !message.event).length;
}

async function selfTest() {
  const alpha = verifyInvokeObservation([{
    call: 1,
    bodyShape: true,
    extraNoiseLength: 32,
    byteShape: true,
    expectedFriend: true,
    dispatched: true,
    responseReceived: true,
    transportRejected: false,
  }], 32, "alpha self-test");
  const beta = verifyInvokeObservation([{
    call: 1,
    bodyShape: true,
    extraNoiseLength: 0,
    byteShape: true,
    expectedFriend: true,
    dispatched: true,
    responseReceived: true,
    transportRejected: false,
  }], 0, "beta self-test");
  assert.deepEqual([alpha.extraNoiseLength, beta.extraNoiseLength], [32, 0]);
  assert.deepEqual(scanSerializedIdentityPayload('{"friendNumber":7,"extraNoise":[0,17,255]}', 7), {
    bodyShape: true,
    extraNoiseLength: 3,
    byteShape: true,
    expectedFriend: true,
  });
  assert.equal(scanSerializedIdentityPayload('{"extraNoise":[],"friendNumber":8}', 7).expectedFriend, false);
  assert.equal(scanSerializedIdentityPayload('{"friendNumber":7,"extraNoise":[256]}', 7).byteShape, false);
  assert.throws(() => verifyInvokeObservation([], 32, "missing self-test"));
  assert.throws(() => validateOptions({ faultStages: true }));
  assert.equal(parseArguments(["--timeout-ms", "30000", "--debug-ports", "9301,9302"]).debugPorts.length, 2);
  assert.equal(sanitizeDiagnostic(`${"B".repeat(64)} ${randomUUID()}`).includes("[redacted-id]"), true);
  console.log("PQ native entropy driver self-test passed (metadata-only observation, CLI, and redaction contracts).");
}

async function run(options) {
  if (process.platform !== "win32") throw new Error("The native entropy driver requires a Windows portable Kaigen build");
  if (typeof WebSocket !== "function") throw new Error("This Node runtime does not expose WebSocket; use the pinned project Node runtime");
  validateOptions(options);

  const paths = await preparePaths(options);
  const ports = options.debugPorts ?? [await freeLoopbackPort(), await freeLoopbackPort()];
  check(ports[0] !== ports[1], "selected DevTools ports collided");
  const receiptPath = path.join(paths.evidenceRoot, "native-entropy-receipt.json");
  const receipt = {
    schemaVersion: 1,
    driver: "pq-native-entropy-v1",
    runId: paths.runId,
    status: "running",
    startedAt: new Date().toISOString(),
    completedAt: null,
    artifact: {
      executable: path.basename(paths.executable),
      bytes: paths.executableStat.size,
      sha256: await sha256File(paths.executable),
    },
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    expectedPqProtocolVersion: EXPECTED_PQ_PROTOCOL_VERSION,
    setup: null,
    entropyChoices: null,
    delivery: null,
    finalPq: null,
    screenshots: [],
    profilesDisposed: false,
    failure: null,
  };
  await writeReceipt(receiptPath, receipt);

  const alpha = new KaigenProcess({
    label: "alpha",
    executable: paths.executable,
    root: path.join(paths.instancesRoot, "alpha"),
    port: ports[0],
    startupTimeoutMs: options.startupTimeoutMs,
  });
  const beta = new KaigenProcess({
    label: "beta",
    executable: paths.executable,
    root: path.join(paths.instancesRoot, "beta"),
    port: ports[1],
    startupTimeoutMs: options.startupTimeoutMs,
  });
  const replacements = [
    [paths.runRoot, "[run-root]"],
    [paths.artifactRoot, "[artifact-root]"],
    [paths.executable, "[artifact]"],
    [paths.runId, "[run-id]"],
  ];
  let friendNumbers = null;
  let alphaPublicKey = "";
  let betaPublicKey = "";
  let failure = null;
  let sends = null;
  const alphaText = `native-entropy-alpha-${randomUUID()}`;
  const betaText = `native-entropy-beta-${randomUUID()}`;

  try {
    await alpha.start();
    await beta.start();
    const [alphaNetwork, betaNetwork] = await Promise.all([
      alpha.invoke("get_network_settings"),
      beta.invoke("get_network_settings"),
    ]);
    check(alphaNetwork?.udpEnabled === true && alphaNetwork?.localDiscoveryEnabled === true, "alpha LAN discovery was not enabled");
    check(betaNetwork?.udpEnabled === true && betaNetwork?.localDiscoveryEnabled === true, "beta LAN discovery was not enabled");

    const [alphaProfiles, betaProfiles] = await Promise.all([
      alpha.invoke("create_profile", { name: "PQ Entropy Alpha", password: null }),
      beta.invoke("create_profile", { name: "PQ Entropy Beta", password: null }),
    ]);
    check(alphaProfiles?.some((profile) => profile.active && profile.loaded), "alpha synthetic profile was not active and loaded");
    check(betaProfiles?.some((profile) => profile.active && profile.loaded), "beta synthetic profile was not active and loaded");

    const [alphaToxId, betaToxId] = await Promise.all([alpha.invoke("get_tox_id"), beta.invoke("get_tox_id")]);
    alphaPublicKey = publicKeyFromToxId(alphaToxId, "alpha");
    betaPublicKey = publicKeyFromToxId(betaToxId, "beta");
    check(alphaPublicKey !== betaPublicKey, "synthetic clients unexpectedly shared one Tox identity");
    const [alphaAdded, betaAdded] = await Promise.all([
      alpha.invoke("add_tox_friend", { toxId: betaToxId, message: "PQ native entropy synthetic authorization" }),
      beta.invoke("add_tox_friend", { toxId: alphaToxId, message: "PQ native entropy synthetic authorization" }),
    ]);
    check(Number.isInteger(alphaAdded) && Number.isInteger(betaAdded), "reciprocal friend creation did not return friend numbers");
    friendNumbers = await waitPairOnline(alpha, beta, alphaPublicKey, betaPublicKey, options.timeoutMs);
    await waitPairPqCapable(alpha, beta, friendNumbers, options.timeoutMs);
    await Promise.all([setUserStatus(alpha, "online"), setUserStatus(beta, "online")]);

    await prepareVisibleChat(alpha, options.startupTimeoutMs);
    await prepareVisibleChat(beta, options.startupTimeoutMs);
    const [alphaHistory, betaHistory, alphaBeforeRaw, betaBeforeRaw] = await Promise.all([
      messagesFor(alpha, friendNumbers.alphaFriendNumber),
      messagesFor(beta, friendNumbers.betaFriendNumber),
      alpha.invoke("get_pq_status", { friendNumber: friendNumbers.alphaFriendNumber }),
      beta.invoke("get_pq_status", { friendNumber: friendNumbers.betaFriendNumber }),
    ]);
    check(plainMessageCount(alphaHistory) === 0 && plainMessageCount(betaHistory) === 0, "synthetic chat was not empty before the lifetime-first messages");
    check(alphaBeforeRaw.identity_needs_entropy === true && betaBeforeRaw.identity_needs_entropy === true, "a synthetic profile already had a long-term PQ identity");
    check(alphaBeforeRaw.identity_waiting === false && betaBeforeRaw.identity_waiting === false, "PQ identity collection started before the first message");
    check(alphaBeforeRaw.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION && betaBeforeRaw.protocol_version === EXPECTED_PQ_PROTOCOL_VERSION, "pre-send status was not PQv2");
    receipt.setup = {
      processes: 2,
      isolatedPortableRoots: true,
      distinctSyntheticIdentities: true,
      reciprocalFriendsOnline: true,
      plaintextRowsBeforeFirstSend: { alpha: 0, beta: 0 },
      pqBeforeFirstSend: { alpha: safePqStatus(alphaBeforeRaw), beta: safePqStatus(betaBeforeRaw) },
    };

    await Promise.all([
      installInvokeObservation(alpha, friendNumbers.alphaFriendNumber),
      installInvokeObservation(beta, friendNumbers.betaFriendNumber),
    ]);

    const alphaSend = sendDurably(alpha, friendNumbers.alphaFriendNumber, alphaText, options.timeoutMs);
    const betaSend = sendDurably(beta, friendNumbers.betaFriendNumber, betaText, options.timeoutMs);
    void alphaSend.catch(() => {});
    void betaSend.catch(() => {});
    sends = [alphaSend, betaSend];

    await Promise.all([waitEntropyPanel(alpha, options.timeoutMs), waitEntropyPanel(beta, options.timeoutMs)]);
    receipt.screenshots.push(...await Promise.all([
      captureEvidence(alpha, paths.evidenceRoot, "01-alpha-before-entropy-choice.png"),
      captureEvidence(beta, paths.evidenceRoot, "02-beta-before-entropy-choice.png"),
    ]));

    const pointerPaths = await exerciseAlphaPointerPaths(alpha);
    receipt.screenshots.push(await captureEvidence(alpha, paths.evidenceRoot, "03-alpha-after-pointer-input.png"));
    await clickWithNativeMouse(alpha, ".pq-entropy-continue");
    await focusClient(beta, 2_000);
    await clickWithNativeMouse(beta, ".pq-entropy-system");

    const [alphaRecords, betaRecords] = await Promise.all([
      waitUntil(async () => {
        const records = await readInvokeObservation(alpha);
        return records?.length === 1 && records[0].responseReceived ? records : undefined;
      }, options.timeoutMs, "alpha real identity completion observation", 20),
      waitUntil(async () => {
        const records = await readInvokeObservation(beta);
        return records?.length === 1 && records[0].responseReceived ? records : undefined;
      }, options.timeoutMs, "beta real identity completion observation", 20),
    ]);
    receipt.entropyChoices = {
      alpha: {
        choice: "additional-pointer-noise",
        pointerPaths,
        command: verifyInvokeObservation(alphaRecords, 32, "alpha"),
      },
      beta: {
        choice: "system-only",
        explicitUiAction: true,
        command: verifyInvokeObservation(betaRecords, 0, "beta"),
      },
    };

    await Promise.all(sends);
    receipt.finalPq = await waitPairPqActive(alpha, beta, friendNumbers, options.timeoutMs);
    const delivery = await Promise.all([
      waitMessageExact({
        sender: alpha,
        receiver: beta,
        senderFriendNumber: friendNumbers.alphaFriendNumber,
        receiverFriendNumber: friendNumbers.betaFriendNumber,
        text: alphaText,
        label: "alpha-lifetime-first-message",
        pqProtected: true,
        timeoutMs: options.timeoutMs,
      }),
      waitMessageExact({
        sender: beta,
        receiver: alpha,
        senderFriendNumber: friendNumbers.betaFriendNumber,
        receiverFriendNumber: friendNumbers.alphaFriendNumber,
        text: betaText,
        label: "beta-lifetime-first-message",
        pqProtected: true,
        timeoutMs: options.timeoutMs,
      }),
    ]);
    receipt.delivery = { lifetimeFirstMessages: 2, exactNoDuplicates: true, rows: delivery };
    receipt.screenshots.push(...await Promise.all([
      captureEvidence(alpha, paths.evidenceRoot, "04-alpha-after-pq-delivery.png"),
      captureEvidence(beta, paths.evidenceRoot, "05-beta-after-pq-delivery.png"),
    ]));
    receipt.status = "pass";
  } catch (error) {
    failure = error;
    receipt.status = "fail";
    receipt.failure = {
      type: error?.name ?? "Error",
      message: sanitizeDiagnostic(error?.message ?? error, replacements),
    };
    if (friendNumbers) {
      const statuses = await Promise.allSettled([
        alpha.cdp && alpha.isRunning() ? alpha.invoke("get_pq_status", { friendNumber: friendNumbers.alphaFriendNumber }) : null,
        beta.cdp && beta.isRunning() ? beta.invoke("get_pq_status", { friendNumber: friendNumbers.betaFriendNumber }) : null,
      ]);
      receipt.failurePq = {
        alpha: statuses[0].status === "fulfilled" && statuses[0].value ? safePqStatus(statuses[0].value) : null,
        beta: statuses[1].status === "fulfilled" && statuses[1].value ? safePqStatus(statuses[1].value) : null,
      };
    }
    for (const client of [alpha, beta]) {
      if (!client.cdp || !client.isRunning()) continue;
      try {
        receipt.screenshots.push(await captureEvidence(client, paths.evidenceRoot, `failure-${client.label}.png`));
      } catch { /* Preserve the original failed gate. */ }
    }
  } finally {
    await Promise.allSettled([restoreInvokeObservation(alpha), restoreInvokeObservation(beta)]);
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
    console.error(`[pq-native-entropy] FAIL: ${receipt.failure?.message ?? "see sanitized receipt"}`);
    console.error(`[pq-native-entropy] receipt: ${receiptPath}`);
    process.exitCode = 1;
    return;
  }
  console.log("[pq-native-entropy] PASS: alpha forwarded 32 optional-noise bytes, beta forwarded 0, and both lifetime-first messages were PQv2 delivered exactly once");
  console.log(`[pq-native-entropy] receipt: ${receiptPath}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else if (options.selfTest) {
    await selfTest();
  } else {
    await run(options);
  }
}
