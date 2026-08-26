import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

const baseUrl = process.env.KAIGEN_E2E_BASE_URL ?? "http://127.0.0.1:8787";
const publicOrigin = process.env.KAIGEN_E2E_PUBLIC_ORIGIN ?? "https://web.kaigen.one";
const cleanupTargets = JSON.parse(process.env.KAIGEN_E2E_CLEANUP_JSON ?? "[]");

const base64url = (bytes) => Buffer.from(bytes).toString("base64url");
const workspaceSelector = (identifier) => createHash("sha256")
  .update("kaigen-workspace-identifier-v1")
  .update(identifier)
  .digest("base64url");

async function postJson(route, body, session) {
  const headers = { "Content-Type": "application/json", Origin: publicOrigin };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (session?.csrf) headers["X-Kaigen-CSRF"] = session.csrf;
  if (session?.selector) headers["X-Kaigen-Workspace"] = session.selector;
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { response, payload };
}

async function login(identifier, password) {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = base64url(await webcrypto.subtle.exportKey("spki", pair.publicKey));
  const result = await postJson("/api/v1/auth/password", { identifier, password, publicKey });
  assert.equal(result.response.status, 200, JSON.stringify(result.payload));
  const cookie = (result.response.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const selector = workspaceSelector(identifier);
  assert.match(cookie, new RegExp(`^__Host-kaigen-device-${selector}=`));
  return { cookie, csrf: result.payload.csrfToken, selector };
}

async function archiveAndErase(target, index) {
  assert.equal(typeof target.identifier, "string");
  assert.equal(typeof target.password, "string");
  const session = await login(target.identifier, target.password);
  const archivePassword = `visual-qa-cleanup-${Date.now()}-${index}`;
  const response = await fetch(`${baseUrl}/api/v1/workspaces/archive`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: publicOrigin,
      Cookie: session.cookie,
      "X-Kaigen-CSRF": session.csrf,
      "X-Kaigen-Workspace": session.selector,
    },
    body: JSON.stringify({ password: archivePassword, identifier: target.identifier }),
  });
  if (response.status !== 200) {
    throw new Error(`workspace archive cleanup failed with ${response.status}:${await response.text()}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const archiveHash = createHash("sha256").update(bytes).digest("base64url");
  const transactionId = response.headers.get("x-kaigen-archive-transaction") ?? "";
  assert.equal(response.headers.get("x-kaigen-archive-sha256"), archiveHash);
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  assert.match(transactionId, /^[A-Za-z0-9_-]{32}$/u);
  assert.equal(bytes.includes(Buffer.from(target.identifier)), false);
  assert.equal(bytes.includes(Buffer.from(target.password)), false);
  assert.equal(bytes.includes(Buffer.from(archivePassword)), false);
  const erased = await postJson("/api/v1/workspaces/erase", {
    archiveHash,
    archiveBytes: bytes.length,
    transactionId,
    explicitConfirmation: true,
  }, session);
  assert.equal(erased.response.status, 200, JSON.stringify(erased.payload));
  assert.equal(erased.payload.erased, true);
}

assert.ok(Array.isArray(cleanupTargets) && cleanupTargets.length > 0);
for (const [index, target] of cleanupTargets.entries()) await archiveAndErase(target, index);
process.stdout.write(`${JSON.stringify({ ok: true, erased: cleanupTargets.length })}\n`);
