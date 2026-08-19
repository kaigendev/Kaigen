import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(repository, path), "utf8").replaceAll("\r\n", "\n");
const rust = read("src-tauri/src/lib.rs");
const instance = read("src-tauri/src/instance.rs");
const pq = read("src-tauri/src/pq.rs");
const app = read("src/App.tsx");
const identity = read("src/contactIdentity.ts");
const patch = read("patches/c-toxcore/friend-request-retry-cap.patch");
const windowsPrep = read("scripts/prepare-dependencies.ps1");
const unixPrep = read("scripts/prepare-unix-dependencies.sh");
const offlineLoopback = read("scripts/tests/offline-friend-request-loopback.c");
const offlineLoopbackRunner = read("scripts/test-offline-friend-request-loopback.ps1");

let assertions = 0;
function check(condition, message) {
  assert.ok(condition, message);
  assertions += 1;
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  check(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  check(endIndex >= 0, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function includesAll(source, snippets, label) {
  for (const snippet of snippets) {
    check(source.includes(snippet), `${label} is missing: ${snippet}`);
  }
}

// Model the collision-prone case explicitly: both runtime numbers swap in one
// reload. The public key is captured before the simultaneous numeric remap.
const previous = new Map([
  ["ALICE_PUBLIC_KEY", 7],
  ["BOB_PUBLIC_KEY", 19],
]);
const current = new Map([
  ["ALICE_PUBLIC_KEY", 19],
  ["BOB_PUBLIC_KEY", 7],
]);
const publicKeyByOldNumber = new Map([...previous].map(([key, number]) => [number, key]));
const history = [
  { friendNumber: 7, friendPublicKey: "", text: "alice-history" },
  { friendNumber: 19, friendPublicKey: "", text: "bob-history" },
];
for (const message of history) {
  message.friendPublicKey ||= publicKeyByOldNumber.get(message.friendNumber) ?? "";
}
for (const message of history) {
  message.friendNumber = current.get(message.friendPublicKey) ?? message.friendNumber;
}
assert.deepEqual(
  history,
  [
    { friendNumber: 19, friendPublicKey: "ALICE_PUBLIC_KEY", text: "alice-history" },
    { friendNumber: 7, friendPublicKey: "BOB_PUBLIC_KEY", text: "bob-history" },
  ],
  "a number swap must not swap the durable owners of history rows",
);
assert.equal(history.find((message) => message.friendPublicKey === "ALICE_PUBLIC_KEY")?.text, "alice-history");
assert.equal(history.find((message) => message.friendPublicKey === "BOB_PUBLIC_KEY")?.text, "bob-history");
assertions += 3;

// A is moved into B's old numeric slot while B disappears. Only A has a
// current public-key owner; B's durable queue must remain recoverable but can
// never resolve to A's number for transmission.
const partialCurrent = new Map([["ALICE_PUBLIC_KEY", 19]]);
const queuedAfterPartialReload = [
  { friendNumber: 7, friendPublicKey: "ALICE_PUBLIC_KEY", text: "for-alice" },
  { friendNumber: 19, friendPublicKey: "BOB_PUBLIC_KEY", text: "for-bob" },
].map((item) => ({
  ...item,
  resolvedNumber: partialCurrent.get(item.friendPublicKey) ?? null,
}));
assert.deepEqual(queuedAfterPartialReload, [
  { friendNumber: 7, friendPublicKey: "ALICE_PUBLIC_KEY", text: "for-alice", resolvedNumber: 19 },
  { friendNumber: 19, friendPublicKey: "BOB_PUBLIC_KEY", text: "for-bob", resolvedNumber: null },
]);
assert.deepEqual(
  queuedAfterPartialReload.filter((item) => item.resolvedNumber !== null).map((item) => item.text),
  ["for-alice"],
  "an absent public key must never inherit another contact's reused number",
);
assertions += 2;

const cachedFriend = section(rust, "struct CachedFriendProfile {", "\n}\n\n#[derive(Clone, Deserialize, Serialize)]\nstruct ToxAttachment");
includesAll(cachedFriend, ["friend_number: Option<u32>", "pending_authorization: bool", "authorization_message: String", "authorization_last_refreshed_at: u64"], "durable friend cache");

for (const [start, end, label] of [
  ["struct ToxMessage {", "\n}\n\n#[derive(Clone, Deserialize, Serialize)]\nstruct PqHistoryEvent", "history"],
  ["struct PendingToxMessage {", "\n}\n\n// toxcore cannot start", "pending message"],
  ["struct PendingToxFile {", "\n}\n\n#[derive(Serialize)]", "pending file"],
]) {
  includesAll(section(rust, start, end), ["friend_number: u32", "friend_public_key: String"], label);
}

const matchesFriend = section(rust, "fn message_matches_friend(", "\n}\n\nfn default_message_delivery");
check(matchesFriend.includes("friend_identity_matches("), "history lookup must use the shared identity predicate");
const identityMatch = section(rust, "fn friend_identity_matches(", "\n}\n\nfn default_message_delivery");
includesAll(identityMatch, [
  "if !friend_public_key.is_empty() && !record_public_key.is_empty()",
  "record_public_key.eq_ignore_ascii_case(friend_public_key)",
  "record_friend_number == friend_number",
], "public-key-first identity match");
check(identityMatch.indexOf("eq_ignore_ascii_case") < identityMatch.indexOf("record_friend_number == friend_number"), "history lookup must prefer the stable public key");

const reconciliation = section(rust, "    fn reconcile_friend_number_maps(", "\n    fn attach_stable_friend_keys(");
includesAll(reconciliation, [
  "self.attach_stable_friend_keys(&public_keys_by_number);",
  "self.reconcile_durable_friend_numbers(current);",
  "self.reconcile_ephemeral_friend_numbers(&resolved_numbers, &previous_by_number);",
  "reconcile_friend_avatar_files(&self.avatars_dir, previous, current);",
  "cache.entry(public_key.clone()).or_default().friend_number = Some(*friend_number);",
], "friend-number reconciliation");
check(reconciliation.indexOf("self.attach_stable_friend_keys") < reconciliation.indexOf("self.reconcile_durable_friend_numbers"), "legacy rows must receive their stable key before a colliding number swap");

const remap = section(rust, "    fn reconcile_durable_friend_numbers(", "\n    fn rebuild_network_route(");
includesAll(remap, [
  "self.messages.lock()",
  "[&self.pending_messages, &self.pending_pq_messages]",
  "self.pending_files.lock()",
  "friend_number_for_public_key(current, public_key)",
  "self.delivery_receipts.lock()",
  "self.pq_receipts.lock()",
  "self.incoming_files.lock()",
  "self.outgoing_files.lock()",
  "self.unread_state.lock()",
  ".reconcile_friend_numbers(resolved, previous_public_keys);",
], "public-key-owned friend-number reconciliation");

includesAll(pq, [
  "quarantined_peers: Vec<(u32, Peer)>",
  "quarantined_outbox: VecDeque<(u32, Vec<u8>)>",
  "quarantined_fingerprints: Vec<QuarantinedFingerprint>",
  "pub fn reconcile_friend_numbers(",
  "pub fn remove_friend(&self, friend_number: u32, public_key: Option<&str>)",
], "recoverable PQ quarantine");

const deleteFriend = section(rust, "fn delete_tox_friend(", "\n#[tauri::command]\nfn get_incoming_friend_requests(");
includesAll(deleteFriend, [
  "DeletedContactQueueRecovery",
  "deleted-contact-recovery",
  "atomic_write(",
  "pending_messages.retain",
  "pending_pq_messages.retain",
  "pending_files.retain",
  "tox_state.pq.remove_friend(",
  "reconcile_friend_avatar_files(",
], "recoverable delete/reuse isolation");

includesAll(instance, [
  "struct ProfileIdentityGuard",
  "ACTIVE_PROFILE_IDENTITIES",
  "Local\\\\Kaigen.ToxProfileIdentity.",
  "TOX_PROFILE_IDENTITY_ALREADY_LOADED",
  "libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB)",
], "cross-process duplicate identity guard");
includesAll(rust, [
  "_identity_guard: Arc<ProfileIdentityGuard>",
  "ProfileIdentityGuard::acquire(&hex_upper(&address[..32]))",
], "profile-lifetime identity reservation");

includesAll(identity, [
  "return `tox-${publicKey.toUpperCase()}`;",
  "const legacyNumber = /^tox-(\\d+)$/.exec(chatId)?.[1];",
  "return friend ? toxChatId(friend.public_key) : chatId;",
], "frontend stable contact identity");
includesAll(app, ["id: toxChatId(friend.public_key)", "key={chat.id}"], "contact-list stable React identity");

const addFriend = section(rust, "fn add_tox_friend(", "\n#[tauri::command]\nasync fn get_tox_friends");
includesAll(addFriend, [
  "tox_friend_add(",
  "let public_key = address[..32]",
  "let entry = cache.entry(public_key).or_default();",
  "entry.pending_authorization = true;",
  "entry.authorization_message = message.to_string();",
  "entry.authorization_last_refreshed_at = unix_timestamp();",
  "ToxState::save(instance)?;",
], "offline outgoing friend request persistence");

const networkLoop = section(rust, "    fn start_network_loop(", "\n    fn stop(");
check(networkLoop.indexOf("tox_callback_friend_request(") < networkLoop.indexOf("tox_iterate("), "friend-request callback must be registered before event iteration");

const incomingRequest = section(rust, "unsafe extern \"C\" fn on_friend_request(", "\nunsafe extern \"C\" fn on_friend_message(");
includesAll(incomingRequest, [
  "request.public_key == public_key",
  "persist_incoming_friend_requests(requests, &context.incoming_requests_path);",
  "state.requests.insert(public_key);",
  "persist_unread_state(&context.unread_state, &context.unread_state_path);",
], "incoming request delivery");

const authorize = section(rust, "fn mark_friend_authorized(", "\nunsafe impl Send for ToxHandle");
includesAll(authorize, [
  "let public_key = hex_upper(&key);",
  "let entry = cache.entry(public_key).or_default();",
  "entry.pending_authorization = false;",
  "entry.authorization_message.clear();",
], "outgoing authorization completion");

includesAll(patch, [
  "+#define FRIENDREQUEST_TIMEOUT_MAX 60",
  "+            min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);",
], "c-toxcore retry-cap patch manifest");
for (const [source, label] of [[windowsPrep, "Windows dependency prep"], [unixPrep, "Unix dependency prep"]]) {
  includesAll(source, [
    "FRIENDREQUEST_TIMEOUT_MAX 60",
    "min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);",
    "friend-request timeout declaration changed; review the Kaigen retry-cap patch",
    "friend-request retry implementation changed; review the Kaigen retry-cap patch",
  ], label);
}
check(windowsPrep.includes("if (-not $header.Contains(\"#define FRIENDREQUEST_TIMEOUT_MAX 60\"))"), "Windows patching must be idempotent");
check(unixPrep.includes("if ! grep -q '^#define FRIENDREQUEST_TIMEOUT_MAX 60$'"), "Unix patching must be idempotent");

includesAll(offlineLoopback, [
  "tox_new_testing(options, &new_error, &testing, &testing_error)",
  "#define ROUTER_COUNT 4",
  "static const uint32_t expected_retry_timeouts[] = {5, 10, 20, 40, 60}",
  "sender->m->friendlist[friend_number].friendrequest_timeout < FRIENDREQUEST_TIMEOUT_MAX",
  "FAIL sender stopped being routable while recipient was absent",
  "FAIL offline request was not delivered within the 60-second cap plus scheduler grace",
], "accelerated native offline-request fixture");
check(
  offlineLoopback.indexOf("tox_kill(recipient);") < offlineLoopback.indexOf("tox_friend_add("),
  "the native fixture must remove the recipient before the sender queues its request",
);
includesAll(offlineLoopbackRunner, [
  '(Join-Path $pthreadsBuild "pthread.h")',
  '/I"{6}"',
], "native offline-request fixture runner");

const retryIntervals = [];
let interval = 5;
for (let attempt = 0; attempt < 8; attempt += 1) {
  retryIntervals.push(interval);
  interval = Math.min(interval * 2, 60);
}
assert.deepEqual(retryIntervals, [5, 10, 20, 40, 60, 60, 60, 60]);
assertions += 1;
check(retryIntervals.every((seconds) => seconds <= 60), "friend-request retry backoff must never exceed 60 seconds");

const expectedAssertions = 126;
assert.equal(assertions, expectedAssertions, "update the declared assertion count when friend-resilience coverage changes");
console.log(`PASS friend resilience source/model regression (${assertions} assertions)`);
console.log("PASS stable public-key ownership survives a colliding friend-number swap");
console.log("PASS offline request state is persisted and incoming requests are durable");
console.log(`PASS c-toxcore retry schedule: ${retryIntervals.join(" -> ")} seconds`);
