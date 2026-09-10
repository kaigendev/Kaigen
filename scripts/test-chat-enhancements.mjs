import assert from "node:assert/strict";
import { importTypeScriptModule } from "./import-typescript-module.mjs";
import "./test-chat-links.mjs";

const richText = await importTypeScriptModule(new URL("../src/chatRichText.ts", import.meta.url));
const textEdit = await importTypeScriptModule(new URL("../src/textEditCommands.ts", import.meta.url));
const textEditFormatting = await importTypeScriptModule(new URL("../src/textEditFormatting.ts", import.meta.url));

const overlappingSearch = richText.searchTextSegments("aaa", [{ start: 0, end: 2, resultIndex: 0 }, { start: 1, end: 3, resultIndex: 1 }], 1);
assert.equal(overlappingSearch.map((part) => part.text).join(""), "aaa", "overlapping search results never duplicate message text");
assert.equal(overlappingSearch.filter((part) => part.resultIndex === 1).map((part) => part.text).join(""), "aa", "the selected overlapping occurrence remains addressable");
const emojiSearch = richText.searchTextSegments("A😀😀B", [{ start: 1, end: 5, resultIndex: 0 }, { start: 3, end: 5, resultIndex: 1 }, { start: -1, end: 90, resultIndex: 2 }], 1);
assert.equal(emojiSearch.map((part) => part.text).join(""), "A😀😀B");
assert.equal(emojiSearch.filter((part) => part.resultIndex === 1).map((part) => part.text).join(""), "😀");
assert.deepEqual(richText.searchTextSegments("abc", [], 0), [{ start: 0, end: 3, text: "abc", resultIndex: undefined }]);

assert.deepEqual(
  richText.normalizeFormattingSpans("abcdef", [
    { kind: "bold", offsetUtf16: 0, lengthUtf16: 2 },
    { kind: "bold", offsetUtf16: 2, lengthUtf16: 2 },
    { kind: "italic", offsetUtf16: 99, lengthUtf16: 4 },
    { kind: "unknown", offsetUtf16: 0, lengthUtf16: 6 },
  ]),
  [{ kind: "bold", offsetUtf16: 0, lengthUtf16: 4 }],
  "equivalent ranges merge while invalid and empty remote spans are discarded",
);

assert.deepEqual(
  richText.normalizeFormattingSpans("A😀BC", [{ kind: "underline", offsetUtf16: 2, lengthUtf16: 1 }]),
  [{ kind: "underline", offsetUtf16: 1, lengthUtf16: 2 }],
  "a malformed offset cannot split a surrogate pair",
);

assert.deepEqual(
  richText.formattedTextSegments("abcdef", [
    { kind: "bold", offsetUtf16: 0, lengthUtf16: 4 },
    { kind: "italic", offsetUtf16: 2, lengthUtf16: 3 },
  ]),
  [
    { text: "ab", offsetUtf16: 0, kinds: ["bold"] },
    { text: "cd", offsetUtf16: 2, kinds: ["bold", "italic"] },
    { text: "e", offsetUtf16: 4, kinds: ["italic"] },
    { text: "f", offsetUtf16: 5, kinds: [] },
  ],
  "overlapping formats become safe declarative text segments",
);

assert.deepEqual(
  richText.toggleFormattingForSelection(
    "abcdef",
    2,
    4,
    "bold",
    [{ kind: "bold", offsetUtf16: 0, lengthUtf16: 6 }],
  ),
  [
    { kind: "bold", offsetUtf16: 0, lengthUtf16: 2 },
    { kind: "bold", offsetUtf16: 4, lengthUtf16: 2 },
  ],
  "toggling a covered subrange removes only that subrange",
);

assert.deepEqual(
  richText.toggleFormattingForSelection(
    "abcdef",
    1,
    5,
    "bold",
    [{ kind: "bold", offsetUtf16: 0, lengthUtf16: 2 }],
  ),
  [{ kind: "bold", offsetUtf16: 0, lengthUtf16: 5 }],
  "toggling a partially covered range applies and merges it",
);

assert.deepEqual(
  richText.rebaseFormattingAfterTextEdit(
    "abcdef",
    "abXcdef",
    [{ kind: "bold", offsetUtf16: 1, lengthUtf16: 4 }],
  ),
  [{ kind: "bold", offsetUtf16: 1, lengthUtf16: 5 }],
  "typing inside a formatted range keeps the inserted text formatted",
);

assert.deepEqual(
  richText.rebaseFormattingAfterTextEdit(
    "abcdef",
    "abef",
    [{ kind: "bold", offsetUtf16: 1, lengthUtf16: 4 }],
  ),
  [{ kind: "bold", offsetUtf16: 1, lengthUtf16: 2 }],
  "deleting text joins the surviving formatted sides",
);

assert.deepEqual(
  richText.prepareFormattedSubmission(
    "  hello  ",
    [{ kind: "strikethrough", offsetUtf16: 0, lengthUtf16: 9 }],
  ),
  {
    text: "hello",
    formatting: [{ kind: "strikethrough", offsetUtf16: 0, lengthUtf16: 5 }],
  },
  "submission trimming keeps UTF-16 spans aligned",
);

assert.equal(richText.shouldSubmitComposerKey({ key: "Enter", shiftKey: false }, true), true);
assert.equal(richText.shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, true), false);
assert.equal(richText.shouldSubmitComposerKey({ key: "Enter", shiftKey: false, isComposing: true }, true), false);
assert.equal(richText.shouldSubmitComposerKey({ key: "Enter", shiftKey: false, keyCode: 229 }, true), false);
assert.equal(richText.shouldSubmitComposerKey({ key: "Enter", shiftKey: true }, false), true);

assert.equal(
  richText.serializeQtoxQuote("first\r\nsecond\u2028third"),
  "> first\n> second\n> third\n",
  "qTox compatibility normalizes every upstream-supported line separator",
);
assert.deepEqual(
  richText.parseQtoxQuoteMessage("> first\n> second\nanswer"),
  { quoteText: "first\nsecond", body: "answer" },
);
assert.equal(richText.parseQtoxQuoteMessage("ordinary > text"), null);
assert.deepEqual(richText.CHAT_REACTION_CODES, ["thumbs_up", "thumbs_down", "grin", "sad", "heart", "rocket"]);

const selection = textEdit.normalizeTextEditSelection("alpha beta", 6, 10, "backward");
assert.equal(textEdit.selectedText(selection), "beta");
assert.equal(textEdit.selectedText(selection, true), "", "password selections are never exposed for copy or cut");
assert.equal(textEditFormatting.snapshotTextEditFormatting({}, selection), null, "unregistered edit targets never expose formatting");
assert.equal(
  textEditFormatting.snapshotTextEditFormatting({}, textEdit.normalizeTextEditSelection("alpha", 2, 2, "none")),
  null,
  "collapsed selections never expose formatting",
);
const formattingTarget = {};
const applications = [];
const unregisterFirstOwner = textEditFormatting.registerTextEditFormatting(formattingTarget, (capturedSelection) => ({
  activeKinds: ["bold"],
  isCurrent: () => capturedSelection.start === 6 && capturedSelection.end === 10,
  apply: (kind) => { applications.push(`first:${kind}`); return true; },
}));
const firstFormattingSnapshot = textEditFormatting.snapshotTextEditFormatting(formattingTarget, selection);
assert.deepEqual(firstFormattingSnapshot?.activeKinds, ["bold"]);
assert.equal(firstFormattingSnapshot?.isCurrent(), true);
const unregisterSecondOwner = textEditFormatting.registerTextEditFormatting(formattingTarget, () => ({
  activeKinds: [],
  isCurrent: () => true,
  apply: (kind) => { applications.push(`second:${kind}`); return true; },
}));
assert.equal(firstFormattingSnapshot?.isCurrent(), false, "replacing the exact target owner invalidates an open menu snapshot");
assert.equal(firstFormattingSnapshot?.apply("italic"), false, "a stale owner snapshot cannot apply formatting");
unregisterFirstOwner();
const secondFormattingSnapshot = textEditFormatting.snapshotTextEditFormatting(formattingTarget, selection);
assert.equal(secondFormattingSnapshot?.apply("underline"), true, "old cleanup cannot unregister a replacement owner");
assert.deepEqual(applications, ["second:underline"]);
unregisterSecondOwner();
assert.equal(secondFormattingSnapshot?.isCurrent(), false, "owner cleanup invalidates an already open formatting snapshot");
assert.equal(secondFormattingSnapshot?.apply("bold"), false, "a removed owner cannot apply formatting");
assert.deepEqual(applications, ["second:underline"]);
assert.deepEqual(
  textEdit.applyPlainTextEdit(selection, "cut"),
  { value: "alpha ", start: 6, end: 6, direction: "none" },
);
assert.deepEqual(
  textEdit.applyPlainTextEdit(selection, "paste", "world"),
  { value: "alpha world", start: 11, end: 11, direction: "none" },
);
assert.deepEqual(
  textEdit.applyPlainTextEdit(selection, "selectAll"),
  { value: "alpha beta", start: 0, end: 10, direction: "none" },
);
assert.equal(textEdit.isKeyboardContextMenuGesture({ key: "ContextMenu", shiftKey: false }), true);
assert.equal(textEdit.isKeyboardContextMenuGesture({ key: "F10", shiftKey: true }), true);
assert.equal(textEdit.isKeyboardContextMenuGesture({ key: "F10", shiftKey: false }), false);
assert.deepEqual(
  textEdit.clampContextMenuPoint({ x: 999, y: -5 }, { width: 180, height: 240 }, { width: 800, height: 600 }),
  { x: 612, y: 8 },
);
assert.equal(textEdit.clipboardImageExtension("image/jpeg"), "jpg");
assert.equal(textEdit.clipboardImageExtension("image/unknown"), "png");

console.log("Chat enhancement behavior passed.");
