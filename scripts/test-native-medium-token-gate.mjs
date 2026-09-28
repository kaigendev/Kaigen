import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  KaigenProcess,
  parseWindowsNodeTokenEvidence,
  requireMediumWindowsNodeToken,
  validateWindowsNodeTokenEvidence,
} from "./test-pq-two-instances.mjs";

async function withMockedExecFile(outcomes, action) {
  const original = childProcess.execFile;
  const calls = [];
  childProcess.execFile = (executable, args, options, callback) => {
    calls.push({ executable, args, options });
    const outcome = outcomes[calls.length - 1] ?? { error: new Error("unexpected mock call") };
    queueMicrotask(() => callback(outcome.error ?? null, outcome.stdout ?? "", outcome.stderr ?? ""));
    return undefined;
  };
  syncBuiltinESMExports();
  try {
    await action(calls);
    for (const call of calls) {
      assert.equal(path.win32.isAbsolute(call.executable), true);
      assert.match(call.executable, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/iu);
      assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
      assert.match(call.args[4], /^[A-Za-z0-9+/=]+$/u);
      const script = Buffer.from(call.args[4], "base64").toString("utf16le");
      assert.ok(script.includes(`[KaigenNodeTokenReadOnly]::Inspect([uint32]${process.pid})`));
      assert.equal(call.options.timeout, 10_000);
      assert.equal(call.options.maxBuffer, 4096);
      assert.equal(call.options.windowsHide, true);
      assert.equal(call.options.shell, false);
    }
  } finally {
    childProcess.execFile = original;
    syncBuiltinESMExports();
  }
}

async function mockWindowsQueries() {
  const medium = { pid: process.pid, integrity: "Medium", uiAccess: false, adminEffective: false };
  const output = (evidence) => ({ stdout: JSON.stringify(evidence) });
  await withMockedExecFile([output(medium), output(medium)], async (calls) => {
    const [first, second] = await Promise.all([requireMediumWindowsNodeToken(), requireMediumWindowsNodeToken()]);
    assert.strictEqual(first, second);
    assert.equal(calls.length, 1, "simultaneous starts share only the in-flight query");
    await requireMediumWindowsNodeToken();
    assert.equal(calls.length, 2, "a completed PASS is not cached");
  });

  await withMockedExecFile([
    { error: new Error("private-path") }, output(medium),
  ], async (calls) => {
    await assert.rejects(Promise.all([requireMediumWindowsNodeToken(), requireMediumWindowsNodeToken()]),
      (error) => /token query failed/u.test(error.message) && !/private-path/u.test(error.message));
    assert.equal(calls.length, 1, "simultaneous failures share only the in-flight query");
    await requireMediumWindowsNodeToken();
    assert.equal(calls.length, 2, "a failed query is not cached");
  });

  for (const [outcome, message] of [
    [{ error: Object.assign(new Error("private-path"), { killed: true, code: "ETIMEDOUT" }) }, /token query timed out/u],
    [{ error: Object.assign(new Error("private-path"), { killed: true, code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) }, /token query failed/u],
    [{ stdout: "not-json" }, /malformed JSON/u],
    [{ stdout: JSON.stringify({ ...medium, pid: process.pid + 1 }) }, /malformed or unbound/u],
    [{ stdout: JSON.stringify(medium), stderr: "private-path" }, /token query failed/u],
  ]) {
    await withMockedExecFile([outcome], async (calls) => {
      await assert.rejects(requireMediumWindowsNodeToken(),
        (error) => message.test(error.message) && !/private-path/u.test(error.message));
      assert.equal(calls.length, 1);
    });
  }

  await withMockedExecFile([output({ ...medium, integrity: "High" })], async (calls) => {
    const sentinel = path.join(tmpdir(), `kaigen-token-gate-${randomUUID()}`);
    assert.equal(existsSync(sentinel), false);
    const client = new KaigenProcess({ label: "token-sentinel", executable: path.join(sentinel, "absent.exe"),
      root: sentinel, port: 65535, startupTimeoutMs: 1_000 });
    await assert.rejects(client.start(), /observed High/u);
    assert.equal(calls.length, 1);
    assert.equal(client.child, null, "start must refuse before spawn");
    assert.equal(existsSync(sentinel), false, "start must refuse before mkdir");
  });
}

const mode = process.argv[2] ?? "--expect-medium";
if (process.argv.length > 3 || !["--pure", "--expect-medium", "--expect-high", "--help"].includes(mode)) {
  throw new Error("Usage: test-native-medium-token-gate.mjs [--pure|--expect-medium|--expect-high|--help]");
}

if (mode === "--help") {
  console.log("Usage: test-native-medium-token-gate.mjs [--pure|--expect-medium|--expect-high|--help]");
} else if (mode === "--pure") {
  const pid = 4242;
  const medium = { pid, integrity: "Medium", uiAccess: false, adminEffective: false };
  assert.deepEqual(validateWindowsNodeTokenEvidence(medium, pid), medium);
  assert.deepEqual(parseWindowsNodeTokenEvidence(JSON.stringify(medium), pid), medium);
  for (const integrity of ["High", "Low", "System", "Unknown"]) {
    assert.throws(() => validateWindowsNodeTokenEvidence({ ...medium, integrity }, pid), /requires Medium Windows Node integrity/u);
  }
  assert.throws(() => validateWindowsNodeTokenEvidence({ ...medium, uiAccess: true }, pid), /UIAccess=false/u);
  assert.throws(() => validateWindowsNodeTokenEvidence({ ...medium, adminEffective: true }, pid), /non-administrative/u);
  for (const invalid of [
    { ...medium, pid: pid + 1 },
    { ...medium, uiAccess: 0 },
    { ...medium, adminEffective: "false" },
    { ...medium, extra: true },
    null,
  ]) {
    assert.throws(() => validateWindowsNodeTokenEvidence(invalid, pid), /malformed or unbound/u);
  }
  assert.throws(() => parseWindowsNodeTokenEvidence("not-json", pid), /malformed JSON/u);
  assert.throws(() => parseWindowsNodeTokenEvidence("", pid), /malformed JSON/u);
  if (process.platform === "win32") await mockWindowsQueries();
  console.log(JSON.stringify({ status: "PASS", mode: "pure", mockedQueries: process.platform === "win32", productStarted: false }));
} else {
  assert.equal(process.platform, "win32", "Actual token checks require Windows");
  if (mode === "--expect-medium") {
    const evidence = await requireMediumWindowsNodeToken();
    assert.equal(evidence.integrity, "Medium");
    assert.equal(evidence.uiAccess, false);
    assert.equal(evidence.adminEffective, false);
  } else {
    await assert.rejects(requireMediumWindowsNodeToken(), /observed High/u);
  }
  console.log(JSON.stringify({ status: "PASS", mode, productStarted: false }));
}
