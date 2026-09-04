import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const settings = await importTypeScriptModule(new URL("../src/fileReceiveSettings.ts", import.meta.url));

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

console.log("file receive settings: 13 assertions passed");
