import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(repository, path), "utf8").replaceAll("\r\n", "\n");
const rust = read("src-tauri/src/lib.rs");
const instance = read("src-tauri/src/instance.rs");
const pqEngine = read("src-tauri/src/pq/engine.rs");
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

// Both runtime numbers swap in one reload. The history already has stable owners.
const current = new Map([
  ["ALICE_PUBLIC_KEY", 19],
  ["BOB_PUBLIC_KEY", 7],
]);
const history = [
  { friendNumber: 7, friendPublicKey: "ALICE_PUBLIC_KEY", text: "alice-history" },
  { friendNumber: 19, friendPublicKey: "BOB_PUBLIC_KEY", text: "bob-history" },
];
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
  ["struct ToxMessage {", "\nstruct PqHistoryEvent {", "history"],
  ["struct PendingToxMessage {", "\n}\n\n// toxcore cannot start", "pending message"],
  ["struct PendingToxFile {", "\n}\n\n#[derive(Serialize)]", "pending file"],
]) {
  includesAll(section(rust, start, end), ["friend_number: u32", "friend_public_key: String"], label);
}

const matchesFriend = section(rust, "fn message_matches_friend(", "\n}\n\nfn default_message_delivery");
check(matchesFriend.includes("friend_identity_matches("), "history lookup must use the shared identity predicate");
const identityMatch = section(rust, "fn friend_identity_matches(", "\n}\n\nfn default_message_delivery");
includesAll(identityMatch, [
  "!record_public_key.is_empty()",
  "!friend_public_key.is_empty()",
  "record_public_key.eq_ignore_ascii_case(friend_public_key)",
], "stable public-key identity match");
check(/!record_public_key\.is_empty\(\)\s*&& !friend_public_key\.is_empty\(\)\s*&& record_public_key\.eq_ignore_ascii_case\(friend_public_key\)/u.test(identityMatch)
  && !/(?:_?record_friend_number|_?friend_number)\s*==/u.test(identityMatch),
  "history lookup requires both stable keys and cannot fall back to a reused runtime number");

const reconciliation = section(rust, "    fn reconcile_friend_number_maps(", "\n    fn reconcile_durable_friend_numbers(");
includesAll(reconciliation, [
  "let durable_changed = self.reconcile_durable_friend_numbers(current);",
  "let previous_by_number = unique_public_keys_by_friend_number(previous).0;",
  "self.reconcile_ephemeral_friend_numbers(&resolved_numbers, &previous_by_number);",
  "let profile = cache.entry(public_key.clone()).or_default();",
  "if profile.friend_number != Some(*friend_number)",
], "friend-number reconciliation");
const durableIdentityBody = rust.match(/fn reconcile_durable_friend_numbers\([^]*?\n    fn reconcile_ephemeral_friend_numbers\(/u)?.[0] ?? "";
check(/if !public_key\.is_empty\(\) \{\s*if let Some\(current_number\) = friend_number_for_public_key\(current, public_key\)/u.test(durableIdentityBody)
  && !reconciliation.includes("attach_stable_friend_keys("),
  "only already-bound durable rows are remapped; a reused numeric slot never adopts an unbound legacy row");
const keyedAvatars = rust.match(/fn latest_friend_avatar_sources\([^]*?\n\}/u)?.[0] ?? "";
const keyedAvatarRemoval = rust.match(/fn remove_friend_avatars\([^]*?\n\}/u)?.[0] ?? "";
check(keyedAvatars.includes("key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit())")
  && keyedAvatars.includes(".then(|| key.to_ascii_uppercase())")
  && /if public_key\.len\(\) != 64 \|\| !public_key\.bytes\(\)\.all\(\|b\| b\.is_ascii_hexdigit\(\)\) \{\s*return;/u.test(keyedAvatarRemoval)
  && keyedAvatarRemoval.includes('let prefix = format!("{}-", public_key.to_ascii_uppercase());'),
  "avatar display and deletion both use a validated stable key rather than inherited friend numbers");

const remap = section(rust, "    fn reconcile_durable_friend_numbers(", "\n    fn rebuild_network_route(");
includesAll(remap, [
  "self.messages.lock()",
  "[&self.pending_messages, &self.pending_pq_messages]",
  "self.pending_files.lock()",
  "friend_number_for_public_key(current, public_key)",
  "self.delivery_receipts.lock()",
  "self.pq.reconcile_friend_numbers(resolved);",
  "self.incoming_files.lock()",
  "self.outgoing_files.lock()",
  "self.unread_state.lock()",
  "remap(friend_number).map(|number| ((number, message_id), value))",
], "public-key-owned friend-number reconciliation");

includesAll(pqEngine, [
  "pub fn reconcile_friend_numbers(",
  "self.v2.remap(resolved);",
  ".filter_map(|(old, packet)| resolved.get(&old).map(|new| (*new, packet)))",
  "pub fn remove_friend(&self, friend: u32) -> Result<(), String>",
  "self.v2.detach(friend)?;\n        self.v2.unbind(friend);",
], "durable PQ journal remap, verified outbox owner and explicit deletion");

const deleteFriend = section(rust, "fn delete_tox_friend_for_state_bound(", "\n    #[tauri::command]\n    fn get_incoming_friend_requests(");
includesAll(deleteFriend, [
  "DeletedContactQueueRecovery",
  "deleted-contact-recovery",
  "atomic_write(",
  "pending_messages.retain",
  "pending_pq_messages.retain",
  "pending_files.retain",
  "remove_friend_avatars(&tox_state.avatars_dir, &friend_public_key, None);",
], "recoverable delete/reuse isolation");
const durablePqDetach = /tox_state\s*\.\s*pq\s*\.\s*remove_friend\s*\(\s*friend_number\s*\)\s*\?/.exec(deleteFriend);
const nativeDelete = deleteFriend.indexOf("instance.native().friend_delete(friend_number, &mut error)");
check(durablePqDetach && nativeDelete >= 0 && durablePqDetach.index < nativeDelete, "durable PQ detach must succeed before deleting the Tox contact through its native facade");

includesAll(instance, [
  "struct ProfileIdentityGuard",
  "ACTIVE_PROFILE_IDENTITIES",
  "Local\\\\Kaigen.ToxProfileIdentity.",
  "TOX_PROFILE_IDENTITY_ALREADY_LOADED",
  "match lock.try_lock() {\n                Ok(()) => Ok(Self { _lock: lock }),\n                Err(TryLockError::WouldBlock)",
], "cross-process duplicate identity guard");
includesAll(rust, [
  "_identity_guard: Arc<ProfileIdentityGuard>",
  "ProfileIdentityGuard::acquire(&hex_upper(\n            &handle.address()[..32],",
], "profile-lifetime identity reservation");

includesAll(identity.replace(/\s+/gu, " "), [
  "return `tox-${publicKey.toUpperCase()}`;",
], "frontend stable contact identity");
check(!identity.includes("resolveFriendChatId"), "frontend contact identity cannot be recovered from a numeric slot");
includesAll(app, ["id: toxChatId(friend.public_key)", "key={chat.id}"], "contact-list stable React identity");

const addFriend = section(rust, "fn add_tox_friend(", "\n    #[tauri::command]\n    async fn get_tox_friends");
includesAll(addFriend, [
  "instance.native().friend_add(&address, message.as_bytes(), &mut error)",
  "let public_key = hex_upper(&address[..32]);",
  "let entry = cache.entry(public_key.clone()).or_default();",
  "entry.pending_authorization = !entry.authorized;",
  "entry.authorization_message = message.to_string();",
  "entry.authorization_last_refreshed_at = added_at;",
  "ToxState::save(instance)?;",
], "offline outgoing friend request persistence");

const networkLoop = section(rust, "    fn start_network_loop(", "\n    fn stop(");
const registration = networkLoop.indexOf("handle.register_callbacks();");
const iteration = networkLoop.indexOf("handle.iterate(&callback_store);");
const callbackRegistration = rust.slice(rust.indexOf("fn register_callbacks("), rust.indexOf("fn iterate("));
check(registration >= 0 && iteration > registration && callbackRegistration.includes("tox_callback_friend_request(")
  && callbackRegistration.includes("Some(on_friend_request)"), "friend-request callback must be registered before event iteration");

const incomingRequest = section(rust, "unsafe extern \"C\" fn on_friend_request(", "\nunsafe extern \"C\" fn on_friend_message(");
includesAll(incomingRequest, [
  "request.public_key == public_key",
  "persist_incoming_friend_requests(requests, &context.incoming_requests_path);",
  "state.requests.insert(public_key.clone());",
  "persist_unread_state(&context.unread_state, &context.unread_state_path);",
], "incoming request delivery");

const authorize = section(rust, "fn mark_friend_authorized(", "\n}\n");
includesAll(authorize, [
  "let Some(public_key) = tox_friend_public_key(tox, friend_number) else {",
  "let entry = cache.entry(public_key).or_default();",
  "entry.pending_authorization = false;",
  "entry.authorization_message.clear();",
], "outgoing authorization completion");

includesAll(patch, [
  "+#define FRIENDREQUEST_TIMEOUT_MAX 60",
  "+            min_u32(f->friendrequest_timeout * 2, FRIENDREQUEST_TIMEOUT_MAX);",
], "historical retry-cap patch");
includesAll(windowsPrep, [
  "kaigendev/kaigen-toxcore",
  "d34d16e6473f61545fed9d8cb59bb1e86da993f1",
  "376182C5AEF175FD03362D46333344FACC751E9A00427A3B467D86D3301E5EC4",
  "kaigen-toxcore-$ToxcoreCommit.zip",
], "Windows dependency prep");
includesAll(unixPrep, [
  "kaigendev/kaigen-toxcore",
  "d34d16e6473f61545fed9d8cb59bb1e86da993f1",
  "376182c5aef175fd03362d46333344facc751e9a00427a3b467d86d3301e5ec4",
  "kaigen-toxcore-$toxcore_commit.zip",
], "Unix dependency prep");
check(!windowsPrep.includes("Apply-KaigenToxcoreRetryCap"), "Windows must use the fork's retry cap without another patch");
check(!unixPrep.includes("apply_kaigen_toxcore_retry_cap"), "Unix must use the fork's retry cap without another patch");

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
