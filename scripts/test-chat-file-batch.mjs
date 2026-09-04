import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const batch = await importTypeScriptModule(new URL("../src/chatFileBatch.ts", import.meta.url));
const receiveSettings = await importTypeScriptModule(new URL("../src/fileReceiveSettings.ts", import.meta.url));
const MiB = 1024 * 1024;
assert.equal(batch.MAX_CHAT_FILE_BYTES, receiveSettings.MAX_CHAT_FILE_BYTES, "send and receive hard limits must stay identical");

const mixed = [
  { name: "photo.png", size: 1024 },
  { name: "recording.aup3", size: 13_574_144 },
  { name: "archive.zip", size: 2 * MiB },
  { name: "notes.txt", size: 32 },
  { name: "payload.bin", size: 25 * MiB },
];
const accepted = batch.admitChatFileBatch(mixed);
assert.equal(accepted.tooMany, false);
assert.deepEqual(accepted.accepted, mixed);
assert.deepEqual(accepted.rejected, []);

const six = batch.admitChatFileBatch([...mixed, { name: "sixth.jpg", size: 10 }]);
assert.equal(six.tooMany, true);
assert.equal(six.selectedCount, 6);
assert.deepEqual(six.accepted, []);
assert.match(batch.formatChatFileBatchNotice(six, "ru"), /не более 5 файлов[^]*Файлы не добавлены/u);

const validAlongsideInvalid = { name: "valid.txt", size: 17 };
const tooLarge = { name: "2.aup3", size: 38_572_032 };
const empty = { name: "empty.bin", size: 0 };
const filtered = batch.admitChatFileBatch([tooLarge, validAlongsideInvalid, empty]);
assert.deepEqual(filtered.accepted, [validAlongsideInvalid]);
assert.deepEqual(filtered.rejected, [
  { file: tooLarge, reason: "too_large" },
  { file: empty, reason: "empty" },
]);
const rejectedNotice = batch.formatChatFileBatchNotice(filtered, "ru");
assert.match(rejectedNotice, /2\.aup3[^]*25 МБ/u);
assert.match(rejectedNotice, /empty\.bin[^]*пустые файлы/u);
assert.match(batch.formatChatFileBatchNotice({
  accepted: [],
  rejected: [{ file: { name: "locked.zip", size: 512 }, reason: "unreadable" }],
  selectedCount: 1,
  tooMany: false,
}, "ru"), /locked\.zip[^]*не удалось прочитать/u);

const invalidSize = batch.admitChatFileBatch([{ name: "invalid.bin", size: Number.NaN }]);
assert.equal(invalidSize.rejected[0].reason, "empty");
assert.equal(batch.formatChatFileBatchNotice(accepted, "en"), null);

console.log("chat file batch admission: 18 assertions passed");
