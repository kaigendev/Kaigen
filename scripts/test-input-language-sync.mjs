import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importTypeScriptModule } from "./import-typescript-module.mjs";

const { installInputLanguageSync } = await importTypeScriptModule(
  new URL("../src/inputLanguageSync.ts", import.meta.url),
);

class FakeClock {
  now = 0;
  nextId = 1;
  jobs = new Map();

  set = (callback, delayMs) => {
    const id = this.nextId++;
    this.jobs.set(id, { at: this.now + delayMs, callback });
    return id;
  };

  clear = (id) => { this.jobs.delete(id); };

  advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!next) break;
      this.now = next[1].at;
      this.jobs.delete(next[0]);
      next[1].callback();
    }
    this.now = target;
  }
}

function setup(enabled = true, { initiallyFocused = true, preserveInitial = false } = {}) {
  const clock = new FakeClock();
  const windowTarget = new EventTarget();
  let focused = initiallyFocused;
  const documentTarget = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
  });
  const calls = [];
  const dispose = installInputLanguageSync({
    enabled, windowTarget, documentTarget, timers: clock,
    notify: () => calls.push(clock.now),
  });
  // Most cases begin after the initial focused-window sample has settled.
  if (!preserveInitial) {
    clock.advance(160);
    calls.length = 0;
    clock.now = 0;
  }
  return { clock, windowTarget, documentTarget, calls, dispose, setFocused: (next) => { focused = next; } };
}

function modifierKeyDown(target, key, { code = "", repeat = false, isComposing = false } = {}) {
  const event = new Event("keydown", { cancelable: true });
  Object.assign(event, { key, code, repeat, isComposing });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "bridge must never intercept an OS shortcut");
}

function modifierKeyUp(target, key, isComposing = false, code = "") {
  const event = new Event("keyup", { cancelable: true });
  Object.assign(event, { key, code, isComposing });
  target.dispatchEvent(event);
  assert.equal(event.defaultPrevented, false, "bridge must never intercept an OS shortcut");
}

{
  const harness = setup(true, { preserveInitial: true });
  assert.deepEqual(harness.calls, [], "installation must queue, not synchronously fire, the focused sample");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 60, 160], "already-focused installation must sample the native baseline");
  harness.dispose();
}

{
  const harness = setup(true, { initiallyFocused: false, preserveInitial: true });
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [], "unfocused installation must not sample");
  harness.setFocused(true);
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [160, 220, 320], "first real focus must establish the baseline");
  harness.dispose();
}

{
  const harness = setup(false);
  modifierKeyDown(harness.windowTarget, "Control");
  modifierKeyUp(harness.windowTarget, "Shift", false, "ShiftRight");
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.windowTarget.dispatchEvent(new Event("focus"));
  harness.clock.advance(500);
  assert.deepEqual(harness.calls, [], "web/non-native installation must remain inert");
  assert.equal(harness.clock.jobs.size, 0);
  harness.dispose();
}

{
  const harness = setup();
  let laterListenerCalls = 0;
  harness.windowTarget.addEventListener("keyup", () => { laterListenerCalls += 1; });
  modifierKeyDown(harness.windowTarget, "Shift", { code: "ShiftRight" });
  assert.deepEqual(harness.calls, [0], "first modifier down must sample before a possible layout switch");
  modifierKeyDown(harness.windowTarget, "Shift", { code: "ShiftRight", repeat: true });
  assert.deepEqual(harness.calls, [0], "held-key repeats must not start more samples");
  modifierKeyUp(harness.windowTarget, "a");
  harness.clock.advance(10_000);
  assert.deepEqual(harness.calls, [0], "ordinary keys and a long-held modifier must not poll");
  modifierKeyUp(harness.windowTarget, "Shift", false, "ShiftRight");
  assert.equal(laterListenerCalls, 2, "the bridge must not stop later keyboard listeners");
  harness.clock.advance(0);
  assert.deepEqual(harness.calls, [0, 10_000]);
  harness.clock.advance(59);
  assert.equal(harness.calls.length, 2);
  harness.clock.advance(1);
  assert.deepEqual(harness.calls, [0, 10_000, 10_060]);
  harness.clock.advance(100);
  assert.deepEqual(harness.calls, [0, 10_000, 10_060, 10_160]);
  assert.equal(harness.clock.jobs.size, 0);
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Control", false, "ControlLeft");
  harness.clock.advance(0);
  harness.clock.advance(20);
  modifierKeyUp(harness.windowTarget, "Alt", false, "AltRight");
  harness.clock.advance(0);
  harness.clock.advance(59);
  assert.deepEqual(harness.calls, [0, 20], "the latest release must cancel old pending samples");
  harness.clock.advance(1);
  assert.deepEqual(harness.calls, [0, 20, 80], "the latest event must get a fresh 60 ms sample");
  harness.clock.advance(100);
  assert.deepEqual(harness.calls, [0, 20, 80, 180]);
  harness.clock.advance(500);
  assert.equal(harness.calls.length, 4, "coalescing must not start an unbounded poll");
  modifierKeyUp(harness.windowTarget, "Meta", false, "MetaLeft");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls.slice(4), [680, 740, 840]);
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(0);
  harness.clock.advance(20);
  modifierKeyDown(harness.windowTarget, "Shift", { code: "ShiftLeft" });
  harness.clock.advance(200);
  assert.deepEqual(harness.calls, [0, 20], "new modifier down must cancel stale release samples");
  modifierKeyUp(harness.windowTarget, "Shift", false, "ShiftLeft");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 20, 220, 280, 380], "release must get a fresh bounded burst");
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyDown(harness.windowTarget, "Control");
  harness.clock.advance(10);
  modifierKeyDown(harness.windowTarget, "Shift");
  modifierKeyUp(harness.windowTarget, "Control");
  modifierKeyUp(harness.windowTarget, "Shift");
  harness.clock.advance(0);
  harness.clock.advance(30);
  modifierKeyDown(harness.windowTarget, "Control");
  modifierKeyDown(harness.windowTarget, "Shift");
  modifierKeyUp(harness.windowTarget, "Shift");
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 10, 10, 40, 40, 40, 100, 200],
    "rapid Ctrl+Shift chords must cancel stale tails and keep fresh release samples");
  assert.equal(harness.clock.jobs.size, 0);
  harness.dispose();
}

for (const [first, final, finalCode] of [
  ["Control", "Shift", "ShiftRight"],
  ["Shift", "Control", "ControlRight"],
]) {
  const harness = setup();
  modifierKeyDown(harness.windowTarget, final, { code: finalCode });
  modifierKeyUp(harness.windowTarget, first);
  harness.clock.advance(150);
  assert.deepEqual(harness.calls, [0, 0, 60], "first release consumed its own early samples");
  modifierKeyUp(harness.windowTarget, final, false, finalCode);
  harness.clock.advance(0);
  harness.clock.advance(60);
  assert.deepEqual(harness.calls, [0, 0, 60, 150, 210],
    `${first} then ${final}: final release needs two fresh samples`);
  harness.clock.advance(100);
  assert.deepEqual(harness.calls, [0, 0, 60, 150, 210, 310],
    `${first} then ${final}: old 160 ms tail must be cancelled`);
  assert.equal(harness.clock.jobs.size, 0);
  harness.dispose();
}

{
  const harness = setup();
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.clock.advance(150);
  modifierKeyUp(harness.windowTarget, "Shift", false, "ShiftLeft");
  harness.clock.advance(60);
  assert.deepEqual(harness.calls, [0, 60, 150, 210],
    "focus sampling must not consume the final modifier-release pair");
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Shift");
  harness.clock.advance(0);
  harness.setFocused(false);
  harness.windowTarget.dispatchEvent(new Event("blur"));
  harness.clock.advance(300);
  assert.deepEqual(harness.calls, [0], "blur must cancel outstanding samples");
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(300);
  assert.deepEqual(harness.calls, [0], "blurred keyup must remain inert");
  harness.setFocused(true);
  harness.windowTarget.dispatchEvent(new Event("focus"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 600, 660, 760]);
  harness.dispose();
}

{
  const harness = setup();
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.windowTarget.dispatchEvent(new Event("focus"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 60, 160],
    "focusin and window focus must coalesce into one bounded burst");
  harness.setFocused(false);
  harness.windowTarget.dispatchEvent(new Event("blur"));
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls.slice(3), [], "programmatic focusin while blurred must stay inert");
  harness.setFocused(true);
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls.slice(3), [320, 380, 480],
    "focusin after blur must rearm the bridge");
  harness.dispose();
}

{
  const harness = setup();
  harness.documentTarget.dispatchEvent(new Event("compositionstart"));
  harness.documentTarget.dispatchEvent(new Event("compositionend"));
  modifierKeyUp(harness.windowTarget, "Shift", true, "ShiftLeft");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [], "late composing keyup must cancel the old burst");
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [160, 220, 320],
    "late composing keyup must not latch composition after compositionend");
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Control");
  harness.documentTarget.visibilityState = "hidden";
  harness.documentTarget.dispatchEvent(new Event("visibilitychange"));
  harness.clock.advance(300);
  assert.deepEqual(harness.calls, [], "hidden document must cancel the burst");
  modifierKeyUp(harness.windowTarget, "Shift");
  harness.clock.advance(300);
  assert.deepEqual(harness.calls, [], "hidden keyup must not notify");
  harness.documentTarget.visibilityState = "visible";
  harness.documentTarget.dispatchEvent(new Event("visibilitychange"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [600, 660, 760]);
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(0);
  harness.documentTarget.dispatchEvent(new Event("compositionstart"));
  modifierKeyUp(harness.windowTarget, "Shift", true, "ShiftRight");
  harness.windowTarget.dispatchEvent(new Event("focus"));
  harness.clock.advance(300);
  assert.deepEqual(harness.calls, [0], "composition must cancel and suppress samples");
  harness.documentTarget.dispatchEvent(new Event("compositionend"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [0, 300, 360, 460], "compositionend must rearm once");
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Shift", true, "ShiftLeft");
  harness.clock.advance(200);
  assert.deepEqual(harness.calls, [], "isComposing keyup alone must suppress scheduling");
  harness.documentTarget.dispatchEvent(new Event("compositionend"));
  harness.clock.advance(160);
  assert.deepEqual(harness.calls, [200, 260, 360]);
  harness.dispose();
}

{
  const harness = setup();
  modifierKeyUp(harness.windowTarget, "Shift");
  harness.dispose();
  harness.dispose();
  assert.equal(harness.clock.jobs.size, 0, "dispose must clear all timers");
  harness.windowTarget.dispatchEvent(new Event("focus"));
  harness.documentTarget.dispatchEvent(new Event("focusin"));
  modifierKeyDown(harness.windowTarget, "Shift");
  modifierKeyUp(harness.windowTarget, "Control");
  harness.clock.advance(500);
  assert.deepEqual(harness.calls, [], "dispose must remove all listeners");
}

const rootSource = await readFile(new URL("../src/RootApp.tsx", import.meta.url), "utf8");
assert.match(rootSource, /installInputLanguageSync\(\{/u);
assert.match(rootSource, /enabled:\s*platformCapabilities\.nativeFilesystem/u);
assert.equal((rootSource.match(/invoke\("synchronize_input_language"\)/gu) ?? []).length, 1,
  "renderer bridge must invoke only the no-argument native sync command");
assert.doesNotMatch(rootSource, /invoke\("synchronize_input_language"\s*,/u);

console.log("PASS input language sync: initial focus, modifier baseline, release, focus, composition, cancellation, disposal, native guard");
