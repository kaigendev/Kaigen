import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const {
  incomingBrowserCommitComplete,
  isRetryableTransferFailure,
  retryTransferOperation,
  transferFailureCode,
  transferRetryDelay,
} = await importTypeScriptModule(new URL("../src/web/transferPump.ts", import.meta.url));

assert.equal(incomingBrowserCommitComplete(10, 10, 10), true);
assert.equal(incomingBrowserCommitComplete(10, 10, 9), false,
  "a full OPFS file with an unconfirmed final ACK must keep draining");
assert.equal(incomingBrowserCommitComplete(9, 10, 10), false);

assert.equal(transferFailureCode(new Error(" TOX_BUSY ")), "TOX_BUSY");
assert.equal(transferFailureCode("Error: STATE_UNAVAILABLE"), "STATE_UNAVAILABLE");
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_CANCELLED")), false);
assert.equal(isRetryableTransferFailure(new Error("TRANSFER_CHUNK_RANGE_INVALID")), false);
assert.equal(isRetryableTransferFailure(new TypeError("Failed to fetch")), true);
assert.equal(isRetryableTransferFailure(new Error("HTTP_503")), true);
assert.deepEqual(
  [0, 1, 2, 3, 4, 5, 9].map(transferRetryDelay),
  [100, 200, 400, 800, 1_600, 2_000, 2_000],
);

{
  let attempts = 0;
  const waits = [];
  const result = await retryTransferOperation(async () => {
    attempts += 1;
    if (attempts < 4) throw new TypeError("Failed to fetch");
    return "complete";
  }, { wait: async (milliseconds) => waits.push(milliseconds) });
  assert.equal(result, "complete");
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [100, 200, 400]);
}

{
  let attempts = 0;
  await assert.rejects(
    retryTransferOperation(async () => {
      attempts += 1;
      throw new Error("TRANSFER_CANCELLED");
    }, { wait: async () => {} }),
    /TRANSFER_CANCELLED/u,
  );
  assert.equal(attempts, 1, "an explicit terminal state must never be retried");
}

{
  let active = true;
  let attempts = 0;
  await assert.rejects(
    retryTransferOperation(async () => {
      attempts += 1;
      throw new Error("STATE_UNAVAILABLE");
    }, {
      active: () => active,
      wait: async () => { active = false; },
    }),
    /TRANSFER_PUMP_STOPPED/u,
  );
  assert.equal(attempts, 1, "session teardown must stop a retrying browser pump");
}

const session = await readFile(new URL("../src/web/session.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const server = await readFile(new URL("../web/kaigen-webd/src/server.rs", import.meta.url), "utf8");
const webCore = await readFile(new URL("../src-tauri/src/web_core.rs", import.meta.url), "utf8");

const outgoingStart = session.slice(
  session.indexOf("private startOutgoingTransfer"),
  session.indexOf("async startIncomingTransfer"),
);
const incomingStart = session.slice(
  session.indexOf("async startIncomingTransfer"),
  session.indexOf("async recoverIncomingTransfer"),
);
assert.doesNotMatch(outgoingStart, /control_tox_file_transfer|action:\s*"cancel"/u,
  "a local browser-pump error must not cancel the peer transfer");
assert.doesNotMatch(incomingStart, /control_tox_file_transfer|action:\s*"pause"/u,
  "a local browser-pump error must not pause the peer transfer");
assert.match(session, /writeTransferCache\(transfer\.id, file, transfer\.mime\)/u);
assert.match(session, /transferCacheDirectory\(create: boolean\)[^]*workspaceDigest\(\)/u);
assert.match(session, /transfer\.direction === "outgoing"[^]*startOutgoingTransfer\(transfer, cached\)/u,
  "a reload must resume outgoing browser uploads from workspace-scoped OPFS");
assert.match(session, /transfer\.state === "complete"[^]*rememberTransferPreview\(transfer\.id, cached\)/u,
  "a reload must restore a completed image preview from workspace-scoped OPFS");
assert.match(session, /incomingBrowserCommitComplete\(received, transfer\.sizeBytes, transfer\.acknowledgedBytes\)/u,
  "a full OPFS file must continue replaying until the server confirms the final ACK");
assert.match(session, /await checkpoint\.close\(\)[^]*acknowledge_web_incoming_chunk/u,
  "each incoming OPFS range must be durably closed before its server ACK");
assert.doesNotMatch(session, /let writable: FileSystemWritableFileStream/u,
  "an open replacement stream must not span multiple ACKs across a possible reload");
assert.match(app, /kaigen:transfer-preview-ready/u);
assert.match(app, /revealAttachmentImage[^]*browserRecoveryAttemptedRef\.current\.delete/u,
  "Show/Retry must start a fresh preview recovery attempt");

const acknowledgeCommand = server.slice(
  server.indexOf('"acknowledge_web_incoming_chunk" =>'),
  server.indexOf('"complete_web_incoming_transfer" =>'),
);
const uploadEndpoint = server.slice(
  server.indexOf("fn upload_transfer_chunk"),
  server.indexOf("fn download_transfer_chunk"),
);
const downloadEndpoint = server.slice(
  server.indexOf("fn download_transfer_chunk"),
  server.indexOf("fn valid_transfer_id"),
);
assert.doesNotMatch(acknowledgeCommand, /changed\s*=\s*true|checkpoint\(|AppState::persist/u,
  "acknowledging an active chunk must not serialize the workspace");
assert.doesNotMatch(uploadEndpoint, /checkpoint\(|AppState::persist/u,
  "uploading an active chunk must not serialize the workspace");
assert.match(downloadEndpoint, /if terminal \{\s*AppState::persist\(stored\)\?/u,
  "only a terminal download transition may serialize the workspace");
assert.match(server, /Duration::from_millis\(250\)[^]*state\.transfer_tick\(\)/u,
  "terminal bridge slots must be reconciled even when a browser pump stops polling");

const confirmIncoming = webCore.slice(
  webCore.indexOf("pub(crate) fn confirm_incoming_complete"),
  webCore.indexOf("pub(crate) fn control(", webCore.indexOf("pub(crate) fn confirm_incoming_complete")),
);
assert.doesNotMatch(confirmIncoming, /incoming_remote_complete/u,
  "browser-verified bytes are the commit point; callback order must not strand 100 percent");
assert.match(webCore, /incoming_terminal_by_native[^]*active_id[^]*!matches!\(transfer\.state\.as_str\(\), "cancelled" \| "failed"\)/u,
  "the trailing native completion callback must still resolve while browser backpressure paused the transfer");
assert.match(webCore, /for \(position, bytes\) in &transfer\.incoming_chunks[^]*FRAME_STREAM_CHUNK_BYTES/u,
  "adjacent native receive chunks must be coalesced into bounded browser frames");
assert.match(webCore, /view\.acknowledged_bytes[^]*"receiving"/u,
  "receiver progress must follow browser-committed bytes instead of server buffering");
const uploadCore = webCore.slice(
  webCore.indexOf("fn drain_web_outgoing_transfer"),
  webCore.indexOf("pub fn control_web_transfer"),
);
assert.match(uploadCore, /stage_outgoing_upload\(transfer_id, position, data\)/u,
  "each authenticated browser range must be staged exactly once before native delivery");
assert.match(uploadCore, /next_outgoing_chunk\(transfer_id, now_ms\)/u,
  "native delivery must drain the bounded staged range independently of browser retransmission");
assert.doesNotMatch(uploadCore, /data\.len\(\)\s*-\s*accepted_bytes/u,
  "SENDQ must retain the staged suffix instead of discarding and re-requesting it");
assert.match(webCore, /active_outgoing_id[^]*drain_web_outgoing_transfer/u,
  "the server transfer tick must keep draining a staged upload if browser polling pauses");

console.log("WEB_TRANSFER_PUMP_PASS retries=3 terminal_no_retry=1 opfs_recovery=1 final_ack_replay=1 coalesced_download=1 staged_upload_once=1");
