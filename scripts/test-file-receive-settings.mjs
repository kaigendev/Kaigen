import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const settings = await importTypeScriptModule(new URL("../src/fileReceiveSettings.ts", import.meta.url));
const settingsSource = await readFile(new URL("../src/Settings.tsx", import.meta.url), "utf8");
const writerPosition = settingsSource.indexOf("const saveFileSettings = createFileReceiveSettingsWriter(");
assert(writerPosition >= 0 && writerPosition < settingsSource.indexOf("function Settings("),
  "unmounting and reopening Settings retains the same writer and pending request order");

assert.deepEqual(settings.DEFAULT_FILE_RECEIVE_SETTINGS, {
  denyAll: false,
  autoAcceptImages: true,
  showImages: true,
  autoAcceptAny: true,
  maxAutoBytes: 24 * 1024 * 1024,
  maxConcurrent: 2,
});
assert.deepEqual(settings.normalizeFileReceiveSettings({}), settings.DEFAULT_FILE_RECEIVE_SETTINGS);
assert.equal(settings.normalizeFileReceiveSettings({ maxAutoBytes: Number.POSITIVE_INFINITY }).maxAutoBytes, 24 * 1024 * 1024);
assert.equal(settings.normalizeFileReceiveSettings({ maxAutoBytes: 99 * 1024 * 1024 }).maxAutoBytes, 25 * 1024 * 1024);
assert.equal(settings.normalizeFileReceiveSettings({ maxConcurrent: 99 }).maxConcurrent, 2);
assert.equal(settings.normalizeFileReceiveSettings({ maxConcurrent: 0 }).maxConcurrent, 1);

const imageOnly = {
  ...settings.DEFAULT_FILE_RECEIVE_SETTINGS,
  autoAcceptAny: false,
};
assert.equal(settings.shouldAutoAcceptIncomingFile(imageOnly, "photo.PNG", 1024), true);
assert.equal(settings.shouldAutoAcceptIncomingFile(imageOnly, "photo.jpeg", 1024), true);
assert.equal(settings.shouldAutoAcceptIncomingFile(imageOnly, "archive.zip", 1024), false);
assert.equal(settings.shouldAutoAcceptIncomingFile({ ...imageOnly, denyAll: true }, "photo.jpg", 1024), false);
assert.equal(settings.shouldAutoAcceptIncomingFile(imageOnly, "photo.jpg", imageOnly.maxAutoBytes + 1), false);
assert.equal(settings.shouldAutoAcceptIncomingFile({ ...imageOnly, autoAcceptImages: false }, "photo.jpg", 1024), false);
assert.equal(settings.shouldAutoAcceptIncomingFile(settings.DEFAULT_FILE_RECEIVE_SETTINGS, "archive.zip", 1024), true);
for (const size of [NaN, Infinity, -1, 1.5, settings.MAX_CHAT_FILE_BYTES + 1]) {
  assert.equal(settings.shouldAutoAcceptIncomingFile({ ...imageOnly, maxAutoBytes: Infinity }, "photo.jpg", size), false);
}
assert.equal(settings.shouldAutoAcceptIncomingFile({ ...settings.DEFAULT_FILE_RECEIVE_SETTINGS, denyAll: true }, "archive.zip", 1), false);

const saves = [];
const writer = settings.createFileReceiveSettingsWriter((profileId, value) => new Promise((resolve, reject) => {
  saves.push({ profileId, value, resolve, reject });
}));
const first = writer("profile-one", imageOnly);
const denied = { ...imageOnly, denyAll: true };
const second = writer("profile-one", denied);
denied.denyAll = false;
const third = writer("profile-two", settings.DEFAULT_FILE_RECEIVE_SETTINGS);
await Promise.resolve();
assert.equal(saves.length, 1, "writes do not overlap while a prior save is pending");
saves[0].resolve(saves[0].value);
await first;
await Promise.resolve();
assert.equal(saves.length, 2);
assert.equal(saves[1].profileId, "profile-one");
assert.equal(saves[1].value.denyAll, true, "each queued action owns an immutable settings snapshot");
const secondRejected = assert.rejects(second, /disk denied/u);
saves[1].reject(new Error("disk denied"));
await secondRejected;
await Promise.resolve();
assert.equal(saves.length, 3, "a failed save does not block a later user action");
assert.equal(saves[2].profileId, "profile-two", "switching profiles cannot redirect queued settings");
saves[2].resolve(saves[2].value);
await third;

console.log("file receive settings: policy limits, deny-all, ordered saves, failure recovery and profile ownership passed");
