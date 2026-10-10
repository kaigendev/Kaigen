import { geometrySetMenuProfiles, platformCapabilities } from "./app-platform";
import { avatarFixture } from "./avatar-fixture-images";
import { avatarSettingsCalls, avatarSettingsDataUrl, avatarSettingsPending, avatarSettingsPickers, avatarSettingsResolvePicker, avatarSettingsResolveSet } from "./avatar-settings-platform";

const A = "qa-profile-a", B = "qa-profile-b";
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const settle = async () => { await frames(); await new Promise(resolve => setTimeout(resolve, 40)); };
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const progress=(globalThis as any).__KAIGEN_AVATAR_SETTINGS_STAGE__ ??= {}; progress.wait=label; progress.waitStartedAt=performance.now();
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 15)); }
  throw Error(label + " timed out");
}
const input = () => document.querySelector<HTMLInputElement>(".avatar-upload input[type=file]");
const upload = () => document.querySelector<HTMLButtonElement>("button.avatar-upload");
const remove = () => [...document.querySelectorAll<HTMLButtonElement>(".profile-row button")].find(button => button.textContent?.trim() === "Удалить");
const shown = () => document.querySelector<HTMLImageElement>(".settings-avatar img")?.getAttribute("src") ?? null;
const errors = () => [...document.querySelectorAll(".setting-error,.transfer-toast")].map(node => node.textContent).join("|");
const active = () => document.querySelector(".profile-switcher-item.active")?.getAttribute("data-profile-id");
function choose(file: File) {
  const picker = input(); if (!picker) throw Error("Missing real Settings file input");
  const files = new DataTransfer(); files.items.add(file);
  Object.defineProperty(picker, "files", { configurable: true, value: files.files });
  picker.dispatchEvent(new Event("change", { bubbles: true }));
}
async function settings() {
  if (!document.querySelector(".settings-content")) {
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "profile menu");
    menu.querySelector<HTMLButtonElement>("button")!.click();
  }
  const tab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Профиль"]') ?? undefined, "Settings profile tab");
  tab.click(); await waitFor(() => document.querySelector(".profile-row") ?? undefined, "Settings avatar"); await settle();
}
async function chats() { document.querySelector<HTMLButtonElement>(".chats-button")!.click(); await settle(); }
async function switchTo(id: string) {
  if (active() !== id) {
    document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="' + id + '"]')!.click();
    await waitFor(() => active() === id ? true : undefined, "active " + id); await settle();
  }
  await settings();
}
type Leave = "switch" | "A-B-A" | "unmount";
async function leave(mode: Leave) {
  if (mode === "switch") await switchTo(B);
  else if (mode === "A-B-A") { await switchTo(B); await switchTo(A); }
  else await chats();
}
function drain(start = 0, error = "SYNTHETIC_AVATAR_CLEANUP") {
  avatarSettingsCalls.forEach((call, index) => { if (index >= start && call.status === "pending") avatarSettingsResolveSet(index, error); });
}

export async function runActualSettingsAvatarScenario() {
  const failures: string[] = []; let assertions = 0;
  const probes: Array<Record<string, unknown>> = [];
  const replaySamples: Array<{ format: string; dataUrl: string; bytes: number[]; width: number; height: number }> = [];
  const check = (value: unknown, label: string) => { assertions++; Object.assign((globalThis as any).__KAIGEN_AVATAR_SETTINGS_STAGE__ ??= {}, {label, assertions, failures: failures.length, pending: avatarSettingsPending()}); if (!value) failures.push(label); };
  const nativeRead = FileReader.prototype.readAsDataURL, nativeDecode = HTMLImageElement.prototype.decode, nativeBlob = HTMLCanvasElement.prototype.toBlob;
  let heldRead: (() => void) | undefined, heldDecode: (() => void) | undefined;
  let readMode: "normal" | "hold" | "abort" = "normal", decodeMode: "normal" | "hold" | "reject" = "normal", refuseCanvas = false;
  let nativeMode = platformCapabilities.nativeFilesystem;
  let profileEvents = 0;
  const profileChanged = () => { profileEvents++; };
  window.addEventListener("profiles-changed", profileChanged);
  FileReader.prototype.readAsDataURL = function(blob: Blob) {
    if (readMode !== "normal" && blob instanceof File) {
      const mode = readMode; readMode = "normal";
      if (mode === "hold") { heldRead = () => nativeRead.call(this, blob); return; }
      nativeRead.call(this, blob); this.abort(); return;
    }
    nativeRead.call(this, blob);
  };
  HTMLImageElement.prototype.decode = async function() {
    const mode = decodeMode; decodeMode = "normal";
    await nativeDecode.call(this);
    if (mode === "reject") throw Error("SYNTHETIC_IMAGE_DECODE_REFUSED");
    if (mode === "hold") await new Promise<void>(resolve => { heldDecode = resolve; });
  };
  HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
    if (refuseCanvas) { refuseCanvas = false; queueMicrotask(() => callback(null)); return; }
    nativeBlob.call(this, callback, ...args);
  };
  async function mode(native: boolean) {
    platformCapabilities.nativeFilesystem = native;
    await chats(); await settings();
    await waitFor(() => native ? upload() ?? undefined : input() ?? undefined, "avatar input mode");
  }
  const dispatch = async (file: File) => {
    const start = avatarSettingsCalls.length; choose(file);
    await waitFor(() => avatarSettingsCalls.length > start ? true : undefined, "native avatar mutation"); await settle(); return start;
  };
  async function resolveUpload(file: File) {
    const start = await dispatch(file); avatarSettingsResolveSet(start); await settle(); return start;
  }
  try {
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "actual App");
    geometrySetMenuProfiles(true);
    await waitFor(() => document.querySelector('.profile-switcher-item[data-profile-id="' + B + '"]') ?? undefined, "second owner");
    await settings(); await mode(false);
    const originals = { A: avatarSettingsDataUrl(A), B: avatarSettingsDataUrl(B) };
    check(shown() === originals.A, "actual Settings starts with canonical owner A avatar");
    const fixtures = await Promise.all(["image/png", "image/jpeg", "image/webp", "image/gif"].map(mime => avatarFixture(mime, 80, 40)));
    for (const fixture of fixtures) {
      const previous = avatarSettingsDataUrl(A), index = await dispatch(fixture.file), call = avatarSettingsCalls[index];
      check(shown() === previous && avatarSettingsDataUrl(A) === previous, fixture.mime + " preserves old avatar while backend pending");
      const decoded = call.dataUrl?.startsWith("data:image/png;base64,") ? [...atob(call.dataUrl.split(",")[1])].map(char => char.charCodeAt(0)) : [];
      check(call.profileId === A && call.filename === "avatar.png" && decoded.length > 0 && decoded.length <= 65536 && JSON.stringify(decoded) === JSON.stringify(call.bytes), fixture.mime + " sends exact owner PNG bytes equal to displayed data URL");
      const image = new Image(); image.src = call.dataUrl!; await nativeDecode.call(image);
      check(image.naturalWidth === 80 && image.naturalHeight === 40, fixture.mime + " normalized PNG preserves source dimensions and aspect ratio");
      replaySamples.push({ format: fixture.mime, dataUrl: call.dataUrl!, bytes: call.bytes!, width: image.naturalWidth, height: image.naturalHeight });
      avatarSettingsResolveSet(index); await settle();
      check(shown() === call.dataUrl && avatarSettingsDataUrl(B) === originals.B, fixture.mime + " success updates only owner A");
    }
    const good = fixtures[0];
    for (const fault of ["corrupt", "read", "decode", "canvas"] as const) {
      await chats(); await settings();
      const old = avatarSettingsDataUrl(A), start = avatarSettingsCalls.length;
      if (fault === "read") readMode = "abort";
      if (fault === "decode") decodeMode = "reject";
      if (fault === "canvas") refuseCanvas = true;
      choose(fault === "corrupt" ? new File(["invalid-image"], "corrupt.png", { type: "image/png" }) : good.file);
      await settle(); await settle();
      check(avatarSettingsCalls.length === start && shown() === old && avatarSettingsDataUrl(A) === old, fault + " failure preserves old avatar without backend mutation");
      check(!!errors(), fault + " failure presents a current error");
      drain(start); await settle();
      const retry = await resolveUpload(good.file);
      check(shown() === avatarSettingsCalls[retry].dataUrl, fault + " failure releases operation for retry");
    }
    // Current-lifetime backend refusal and nullable clear must preserve/clear exact owner.
    let index = await dispatch(good.file), old = avatarSettingsDataUrl(A);
    avatarSettingsResolveSet(index, "SYNTHETIC_BACKEND_REFUSED"); await settle();
    check(shown() === old && avatarSettingsDataUrl(A) === old && !!errors(), "backend failure keeps old avatar and exposes retry");
    await resolveUpload(good.file);
    index = avatarSettingsCalls.length; remove()!.click();
    await waitFor(() => avatarSettingsCalls.length > index ? true : undefined, "remove avatar");
    check(avatarSettingsCalls[index].profileId === A && avatarSettingsCalls[index].dataUrl === null && avatarSettingsCalls[index].bytes === null && avatarSettingsCalls[index].filename === null, "remove sends coherent nullable arguments for owner A");
    avatarSettingsResolveSet(index); await settle();
    check(shown() === null && avatarSettingsDataUrl(A) === null && avatarSettingsDataUrl(B) === originals.B, "successful remove clears only owner A");
    await resolveUpload(good.file);
    await waitFor(() => !document.querySelector(".transfer-toast") ? true : undefined, "earlier visible error expiry");

    for (const stage of ["read", "decode"] as const) for (const route of ["switch", "A-B-A", "unmount"] as const) {
      await switchTo(A); const start = avatarSettingsCalls.length, previous = avatarSettingsDataUrl(A);
      if (stage === "read") readMode = "hold"; else decodeMode = "hold";
      choose(good.file);
      await waitFor(() => stage === "read" ? heldRead : heldDecode, "held actual " + stage);
      await leave(route);
      const release = stage === "read" ? heldRead : heldDecode;
      heldRead = undefined; heldDecode = undefined; release!(); await settle(); await settle();
      check(avatarSettingsCalls.length === start && avatarSettingsDataUrl(A) === previous, stage + " after " + route + " cancels before backend mutation");
      drain(start); await settle(); await switchTo(A);
      const retry = await resolveUpload(good.file);
      check(shown() === avatarSettingsCalls[retry].dataUrl, stage + " after " + route + " releases owner for new upload");
    }

    await mode(true);
    for (const outcome of ["success", "null", "reject"] as const) for (const route of ["switch", "A-B-A", "unmount"] as const) {
      await switchTo(A); const start = avatarSettingsCalls.length, pick = avatarSettingsPickers.length;
      upload()!.click(); await waitFor(() => avatarSettingsPickers.length > pick ? true : undefined, "native picker boundary");
      await leave(route);
      avatarSettingsResolvePicker(pick, outcome === "success" ? good.dataUrl : null, outcome === "reject" ? "SYNTHETIC_PICKER_REFUSED" : undefined);
      await settle(); await settle();
      check(avatarSettingsCalls.length === start, "late picker " + outcome + " after " + route + " cannot mutate owner");
      check(!document.querySelector(".setting-error"), "late picker " + outcome + " after " + route + " cannot report error in a new Settings lifetime");
      drain(start); await settle(); await switchTo(A);
    }
    const firstPicker = avatarSettingsPickers.length; upload()!.click();
    await waitFor(() => avatarSettingsPickers.length > firstPicker ? true : undefined, "first held picker");
    upload()!.click(); await chats(); await settings(); upload()!.click(); await settle();
    check(avatarSettingsPickers.length === firstPicker + 1, "pending native picker has one owner reservation across double click and remount");
    avatarSettingsPickers.forEach((call, pick) => { if (call.status === "pending") avatarSettingsResolvePicker(pick, null); }); await settle();
    const pickerRetry = avatarSettingsPickers.length; upload()!.click();
    await waitFor(() => avatarSettingsPickers.length > pickerRetry ? true : undefined, "picker retry");
    index = avatarSettingsCalls.length; avatarSettingsResolvePicker(pickerRetry, good.dataUrl);
    await waitFor(() => avatarSettingsCalls.length > index ? true : undefined, "picker normalization dispatch");
    check(avatarSettingsCalls[index].profileId === A && avatarSettingsCalls[index].dataUrl?.startsWith("data:image/png;base64,"), "current native picker result uses actual PNG normalization and owner");
    avatarSettingsResolveSet(index); await settle();
    await mode(false);

    for (const mutation of ["set", "remove"] as const) {
      await switchTo(A); if (!shown()) await resolveUpload(good.file);
      const start = avatarSettingsCalls.length;
      if (mutation === "set") choose(good.file); else remove()!.click();
      await waitFor(() => avatarSettingsCalls.length > start ? true : undefined, "held " + mutation);
      choose(good.file); remove()?.click(); await settle();
      await chats(); await settings(); choose(good.file); remove()?.click(); await settle();
      check(avatarSettingsCalls.length === start + 1, "pending " + mutation + " rejects duplicate set/remove across Settings remount");
      const events = profileEvents;
      avatarSettingsResolveSet(start); await settle();
      check(profileEvents > events, "late " + mutation + " commit announces canonical profile refresh after Settings remount");
      check(shown() === avatarSettingsDataUrl(A), "late " + mutation + " commit reconciles remounted current avatar");
      drain(start + 1); await settle();
      await resolveUpload(good.file);
    }

    for (const route of ["switch", "A-B-A", "unmount", "commit-microtask"] as const) for (const outcome of ["success", "reject"] as const) {
      await switchTo(A); const start = await dispatch(fixtures[1].file), old = avatarSettingsDataUrl(A);
      let committedAtResolution = false, completed = false;
      const finish = () => {
        committedAtResolution = !document.querySelector(".settings-content");
        avatarSettingsResolveSet(start, outcome === "reject" ? "SYNTHETIC_LATE_BACKEND_REFUSED" : undefined); completed = true;
      };
      const observer = new MutationObserver(() => {
        if (!document.querySelector(".settings-content")) { observer.disconnect(); finish(); }
      });
      try {
        if (route === "commit-microtask") {
          observer.observe(document.body, { childList: true, subtree: true });
          document.querySelector<HTMLButtonElement>(".chats-button")!.click();
          await waitFor(() => completed ? true : undefined, "backend post-commit microtask");
          check(committedAtResolution, outcome + " settles after actual Settings DOM unmount");
        } else { await leave(route); finish(); }
        await settle();
        probes.push({ route, outcome, committedAtResolution });
        if (route === "switch") check(shown() === avatarSettingsDataUrl(B), "late A backend " + outcome + " preserves B avatar");
        if (route === "unmount" || route === "commit-microtask") check(!document.querySelector(".settings-content"), "late backend " + outcome + " preserves left Settings route");
        check(!errors(), "late backend " + outcome + " after " + route + " cannot expose stale error");
        await switchTo(A);
        check(shown() === avatarSettingsDataUrl(A) && (outcome === "success" || avatarSettingsDataUrl(A) === old), "late backend " + outcome + " after " + route + " refreshes canonical owner without old response overwrite");
      } finally { observer.disconnect(); }
      await resolveUpload(good.file);
    }
    check(avatarSettingsPending().setters === 0 && avatarSettingsPending().pickers === 0, "all disposable native operations settle");
  } catch (error) {
    failures.push("scenario exception: " + String(error));
  } finally {
    readMode = "normal"; decodeMode = "normal"; refuseCanvas = false;
    heldRead?.(); heldDecode?.();
    FileReader.prototype.readAsDataURL = nativeRead; HTMLImageElement.prototype.decode = nativeDecode; HTMLCanvasElement.prototype.toBlob = nativeBlob;
    platformCapabilities.nativeFilesystem = nativeMode;
    avatarSettingsPickers.forEach((call, index) => { if (call.status === "pending") avatarSettingsResolvePicker(index, null); });
    drain(); window.removeEventListener("profiles-changed", profileChanged);
    await settle();
  }
  return { ok: failures.length === 0, assertions, failures, probes, profileEvents, replaySamples,
    boundary: "actual App/Settings + FileReader/decode/canvas PNG; disposable deferred backend and synthetic native-picker result boundary, no OS dialog claim",
    calls: avatarSettingsCalls.map(({ bytes, dataUrl, ...call }) => ({ ...call, byteLength: bytes?.length ?? null, dataUrlLength: dataUrl?.length ?? null })), pickers: avatarSettingsPickers };
}
