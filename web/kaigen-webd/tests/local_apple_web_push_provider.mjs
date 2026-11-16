import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createDecipheriv, createECDH, createHash, createPublicKey, hkdfSync, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { appendFileSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  dir: { type: 'string' }, vapid: { type: 'string' }, subject: { type: 'string' },
} });
assert(values.dir && values.vapid && values.subject, 'expected --dir, --vapid, and --subject');
assert(lstatSync(values.dir).isDirectory(), 'fixture directory must be a real directory');
const dir = realpathSync(values.dir);
assert.equal(readdirSync(dir).length, 0, 'fixture directory must be empty');
const subject = new URL(values.subject);
assert.equal(subject.protocol, 'https:');
assert([subject.origin, `${subject.origin}/`].includes(values.subject), 'subject must be an HTTPS origin');

function fromBase64url(value) {
  assert(typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value));
  const bytes = Buffer.from(value, 'base64url');
  assert.equal(bytes.toString('base64url'), value);
  return bytes;
}

const expectedVapid = fromBase64url(values.vapid);
assert(expectedVapid.length === 65 && expectedVapid[0] === 4, 'expected uncompressed P-256 VAPID key');
const vapidKey = createPublicKey({ format: 'jwk', key: {
  kty: 'EC', crv: 'P-256', x: expectedVapid.subarray(1, 33).toString('base64url'),
  y: expectedVapid.subarray(33).toString('base64url'),
} });
const receiver = createECDH('prime256v1');
const receiverPublic = receiver.generateKeys();
const authSecret = randomBytes(16);
const hostname = 'kaigen-fixture.push.apple.com';
const origin = `https://${hostname}`;
const prefix = `/web-push/${randomBytes(18).toString('base64url')}`;
const statuses = { accepted: 201, expired: 404, gone: 410, retry: 503 };
const caPemPath = join(dir, 'ca.pem');

if (process.platform !== 'win32') process.umask(0o077);
function openssl(args) {
  execFileSync(process.env.OPENSSL || 'openssl', args, { cwd: dir, stdio: 'ignore', timeout: 10_000 });
}
openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-subj', '/CN=Kaigen disposable Web Push fixture CA', '-days', '1', '-keyout', 'ca.key', '-out', 'ca.pem',
  '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
openssl(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
  '-subj', `/CN=${hostname}`, '-keyout', 'provider.key', '-out', 'provider.csr',
  '-addext', `subjectAltName=DNS:${hostname}`, '-addext', 'extendedKeyUsage=serverAuth']);
openssl(['x509', '-req', '-in', 'provider.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key',
  '-CAcreateserial', '-copy_extensions', 'copy', '-days', '1', '-out', 'provider.pem']);
const providerKey = readFileSync(join(dir, 'provider.key'));
const providerCert = readFileSync(join(dir, 'provider.pem'));
for (const name of ['ca.key', 'ca.srl', 'provider.csr', 'provider.key', 'provider.pem']) unlinkSync(join(dir, name));

function verifyVapid(header, origin) {
  assert(typeof header === 'string');
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+),\s*k=([A-Za-z0-9_-]+)$/.exec(header);
  assert(match, 'expected VAPID authorization');
  const [, protectedHeader, encodedClaims, encodedSignature, encodedKey] = match;
  const key = fromBase64url(encodedKey);
  assert(key.length === expectedVapid.length && timingSafeEqual(key, expectedVapid));
  const signature = fromBase64url(encodedSignature);
  assert.equal(signature.length, 64);
  assert(verify('sha256', Buffer.from(`${protectedHeader}.${encodedClaims}`),
    { key: vapidKey, dsaEncoding: 'ieee-p1363' }, signature), 'invalid VAPID signature');
  const jwtHeader = JSON.parse(fromBase64url(protectedHeader));
  assert.equal(jwtHeader.alg, 'ES256');
  assert.equal(jwtHeader.typ, 'JWT');
  const claims = JSON.parse(fromBase64url(encodedClaims));
  assert.equal(claims.aud, origin);
  assert.equal(claims.sub, values.subject);
  const now = Math.floor(Date.now() / 1000);
  assert(Number.isSafeInteger(claims.exp) && claims.exp > now && claims.exp <= now + 86_400);
}

function decrypt(body) {
  assert(body.length >= 103 && body.readUInt32BE(16) === 4096 && body[20] === 65);
  const sender = body.subarray(21, 86);
  assert.equal(sender[0], 4);
  const shared = receiver.computeSecret(sender);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiverPublic, sender]);
  const ikm = hkdfSync('sha256', shared, authSecret, info, 32);
  const salt = body.subarray(0, 16);
  const key = hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12);
  const record = body.subarray(86);
  assert(record.length < 4096);
  const cipher = createDecipheriv('aes-128-gcm', key, nonce);
  cipher.setAuthTag(record.subarray(-16));
  const message = Buffer.concat([cipher.update(record.subarray(0, -16)), cipher.final()]);
  assert.equal(message.at(-1), 2, 'expected final RFC 8188 record delimiter');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(message.subarray(0, -1)));
}

function observed(payload) {
  const { language, silent, volume, routingHint, eventToken, notification } = payload;
  assert.deepEqual(Object.keys(payload).sort(), ['eventToken', 'language', 'notification', 'routingHint', 'silent', 'volume', 'web_push']);
  assert.equal(payload.web_push, 8030);
  assert(language === 'ru' || language === 'en');
  assert(typeof silent === 'boolean' && Number.isFinite(volume) && volume >= 0 && volume <= 1);
  assert.match(routingHint, /^[A-Za-z0-9_-]{22}$/);
  assert(typeof eventToken === 'string' && /^[A-Za-z0-9_-]{1,512}$/.test(eventToken));
  const { title, body, tag, navigate } = notification;
  assert.deepEqual(Object.keys(notification).sort(), ['body', 'navigate', 'silent', 'tag', 'title']);
  assert.equal(title, 'Kaigen');
  assert.equal(body, language === 'en' ? 'New events in a connected profile' : 'В подключённом профиле новые события');
  assert.equal(tag, `kaigen-events-${routingHint}`);
  assert.equal(notification.silent, silent);
  const url = new URL(navigate);
  assert.equal(url.origin, subject.origin);
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '?kaigen-notification=1');
  assert(!url.username && !url.password);
  assert.deepEqual([...new URLSearchParams(url.hash.slice(1))], [
    ['kaigen-notification', routingHint], ['kaigen-notification-event', eventToken],
  ]);
  return { language, silent, volume, routingHint, eventToken, web_push: 8030,
    notification: { title, body, tag, navigate, silent } };
}

const server = createServer({ key: providerKey, cert: providerCert,
  headersTimeout: 4000, requestTimeout: 5000, keepAliveTimeout: 500, maxHeaderSize: 8192 }, async (request, response) => {
  const { headers, method, url } = request;
  const branch = Object.keys(statuses).find((name) => url === `${prefix}/${name}`);
  if (!branch || method !== 'POST' || headers.host !== hostname || request.socket.servername !== hostname) {
    response.writeHead(404, { connection: 'close' }).end();
    return;
  }
  const requestDeadline = setTimeout(() => request.destroy(), 4000);
  try {
    verifyVapid(headers.authorization, origin);
    assert.equal(headers['content-encoding'], 'aes128gcm');
    assert.equal(headers['content-type'], 'application/octet-stream');
    assert.equal(headers.urgency, 'high');
    assert.equal(headers.ttl, '86400');
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      assert(size <= 4181, 'Web Push request too large');
      chunks.push(chunk);
    }
    const payload = observed(decrypt(Buffer.concat(chunks)));
    assert.equal(headers.topic, createHash('sha256').update(payload.routingHint).digest('base64url').slice(0, 32));
    const status = statuses[branch];
    appendFileSync(join(dir, 'observed.jsonl'), `${JSON.stringify({ branch, status, payload })}\n`, { mode: 0o600 });
    response.writeHead(status, { connection: 'close' }).end();
  } catch {
    if (!response.destroyed) response.writeHead(400, { connection: 'close' }).end();
  } finally {
    clearTimeout(requestDeadline);
  }
});
server.maxConnections = 8;
server.listen(0, '127.0.0.1', () => {
  const endpoints = Object.fromEntries(Object.keys(statuses).map((name) => [name, `${origin}${prefix}/${name}`]));
  const readiness = `${JSON.stringify({ origin, port: server.address().port, caPemPath, p256dh: receiverPublic.toString('base64url'),
    auth: authSecret.toString('base64url'), endpoints })}\n`;
  const pending = join(dir, 'ready.json.tmp');
  writeFileSync(pending, readiness, { mode: 0o600, flag: 'wx' });
  renameSync(pending, join(dir, 'ready.json'));
  process.stdout.write(readiness);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
}
