import { avatarOwnerCalls, avatarOwnerCommit, avatarOwnerPending, avatarOwnerProfiles, avatarOwnerReplace, avatarOwnerResolve } from "./avatar-owner-platform";

const A = "avatar-a", B = "avatar-b";
const frames = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
const settle = async () => { await frames(); await new Promise(resolve => setTimeout(resolve, 100)); await frames(); };
async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`${label} timed out`);
}
const row = (owner: string) => [...document.querySelectorAll<HTMLElement>(".unlock-list article")].find(item => item.querySelector("small")?.textContent === `${owner}.kai`);
const picker = (owner: string) => row(owner)?.querySelector<HTMLInputElement>('input[type="file"]');
const shownAvatar = (owner: string) => row(owner)?.querySelector<HTMLImageElement>(".unlock-profile-avatar img,img.unlock-profile-avatar")?.src;
function choose(owner: string, file: File) {
  const field = picker(owner); if (!field) throw new Error(`No picker for ${owner}`);
  const transfer = new DataTransfer(); transfer.items.add(file);
  Object.defineProperty(field, "files", { configurable: true, value: transfer.files });
  field.dispatchEvent(new Event("change", { bubbles: true }));
}
async function png(color: string, name = "avatar.png") {
  const canvas = document.createElement("canvas"); canvas.width = 80; canvas.height = 40;
  const context = canvas.getContext("2d")!; context.fillStyle = color; context.fillRect(0, 0, 80, 40);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), "image/png"));
  return new File([blob], name, { type: "image/png" });
}
async function dispatched(start: number) {
  await waitFor(() => avatarOwnerCalls.length > start ? true : undefined, "avatar invoke"); await frames();
}
function drain(start: number, error?: string) {
  avatarOwnerCalls.forEach((call, index) => { if (index >= start && call.status === "pending") avatarOwnerResolve(index, error); });
}
async function replace(next: ReturnType<typeof avatarOwnerProfiles>) { avatarOwnerReplace(next); await settle(); }

export async function runActualRootAvatarScenario() {
  let assertions = 0; const failures: string[] = [];
  const check = (value: unknown, label: string) => { assertions++; if (!value) failures.push(label); };
  let profileEvents = 0;
  const onProfilesChanged = () => { profileEvents++; };
  window.addEventListener("profiles-changed", onProfilesChanged);
  const nativeRead = FileReader.prototype.readAsDataURL, nativeDecode = HTMLImageElement.prototype.decode;
  let heldRead: (() => void) | undefined, holdDecode = false, heldDecode: (() => void) | undefined;
  FileReader.prototype.readAsDataURL = function (blob: Blob) {
    if (blob instanceof File && blob.name === "avatar-held-read.png") { heldRead = () => nativeRead.call(this, blob); return; }
    nativeRead.call(this, blob);
  };
  HTMLImageElement.prototype.decode = async function () {
    await nativeDecode.call(this);
    if (holdDecode) { holdDecode = false; await new Promise<void>(resolve => { heldDecode = resolve; }); }
  };
  try {
    await waitFor(() => picker(A) && picker(B) ? true : undefined, "actual UnlockProfiles");
    const oldA = shownAvatar(A), oldB = shownAvatar(B);
    check(!!oldA && !!oldB && !picker("avatar-c"), "loaded owners have independent avatars; locked owner has no upload control");

    const duplicate = avatarOwnerCalls.length, red = await png("#e01030");
    choose(A, red); choose(A, red); await dispatched(duplicate);
    check(avatarOwnerCalls.length === duplicate + 1, "same-turn file changes dispatch once for captured owner");
    check(picker(A)?.disabled && !picker(B)?.disabled, "pending A disables only A avatar picker");
    check(shownAvatar(A) === oldA && shownAvatar(B) === oldB, "pending operation preserves both previous avatars");
    drain(duplicate, "SYNTHETIC_AVATAR_WRITE_REFUSED"); await settle();
    check(shownAvatar(A) === oldA && !!row(A)?.querySelector("em") && !row(B)?.querySelector("em") && !picker(A)?.disabled,
      "backend refusal preserves old avatar, isolates error and permits retry");

    const malformed = avatarOwnerCalls.length;
    choose(A, new File(["invalid image"], "broken.png", { type: "image/png" })); await settle();
    check(avatarOwnerCalls.length === malformed && shownAvatar(A) === oldA && !!row(A)?.querySelector("em"), "real decode failure preserves previous avatar and never invokes backend");

    const reversed = avatarOwnerCalls.length;
    choose(A, await png("#e01030")); choose(B, await png("#1060e0"));
    await waitFor(() => avatarOwnerCalls.length >= reversed + 2 ? true : undefined, "two owner uploads");
    const callA = avatarOwnerCalls.findIndex((call, index) => index >= reversed && call.profileId === A);
    const callB = avatarOwnerCalls.findIndex((call, index) => index >= reversed && call.profileId === B);
    check(callA >= 0 && callB >= 0, "parallel uploads capture separate profile IDs");
    avatarOwnerCommit(callA); avatarOwnerCommit(callB); avatarOwnerResolve(callB); await settle();
    await replace(avatarOwnerProfiles().map(profile => ({ ...profile, active: profile.id === B })));
    avatarOwnerResolve(callA); await settle();
    check(shownAvatar(A) === avatarOwnerCalls[callA].dataUrl && shownAvatar(B) === avatarOwnerCalls[callB].dataUrl,
      "reversed backend snapshots preserve both committed owner avatars");
    check(document.title.includes("Avatar Beta"), "late owner avatar response preserves newer active profile selection");
    for (const call of [avatarOwnerCalls[callA], avatarOwnerCalls[callB]]) {
      const data = Uint8Array.from(atob(call.dataUrl!.split(",")[1]), character => character.charCodeAt(0));
      check(call.filename === "avatar.png" && call.bytes!.length <= 65536 && call.bytes!.length === data.length && call.bytes!.every((value, index) => value === data[index]),
        `real normalization produces matching PNG data URL and transfer bytes for ${call.profileId}`);
    }

    const beforeRead = avatarOwnerProfiles(), readStart = avatarOwnerCalls.length;
    choose(A, await png("#d08020", "avatar-held-read.png"));
    await waitFor(() => heldRead ? true : undefined, "held real FileReader");
    await replace(beforeRead.filter(profile => profile.id !== A));
    check(!row(A), "owner is removed while file read is pending");
    heldRead!(); heldRead = undefined; await settle();
    check(avatarOwnerCalls.length === readStart, "removed owner cancels after read before native mutation");
    drain(readStart, "PROFILE_NOT_LOADED"); await replace(beforeRead);

    const decodeStart = avatarOwnerCalls.length, beforeDecode = avatarOwnerProfiles();
    holdDecode = true; choose(B, await png("#30b080"));
    await waitFor(() => heldDecode ? true : undefined, "held real decode completion");
    await replace(beforeDecode.map(profile => profile.id === B ? { ...profile, loaded: false, connection: "locked" } : profile));
    heldDecode!(); heldDecode = undefined; await settle();
    check(avatarOwnerCalls.length === decodeStart && !picker(B), "owner locked during decode cannot mutate backend or old avatar");
    drain(decodeStart, "PROFILE_NOT_LOADED"); await replace(beforeDecode);

    const removedStart = avatarOwnerCalls.length, beforeRemove = avatarOwnerProfiles();
    choose(A, await png("#a030d0")); await dispatched(removedStart); avatarOwnerCommit(removedStart);
    await replace(beforeRemove.filter(profile => profile.id !== A)); avatarOwnerResolve(removedStart); await settle();
    check(!row(A) && avatarOwnerProfiles().every(profile => profile.id !== A), "late successful backend snapshot cannot restore removed owner row");
    await replace(beforeRemove);

    const lateError = avatarOwnerCalls.length;
    choose(A, await png("#408060")); await dispatched(lateError);
    const remountProfiles = avatarOwnerProfiles();
    await replace(remountProfiles.filter(profile => profile.id !== A)); await replace(remountProfiles);
    const newer = avatarOwnerCalls.length;
    choose(A, await png("#805020")); await settle();
    const replacementStarted = avatarOwnerCalls.length > newer;
    check(!replacementStarted && picker(A)?.disabled, "removed and readded owner retains reservation until old backend write settles");
    avatarOwnerResolve(lateError, "SYNTHETIC_OLD_AVATAR_FAILURE"); await settle();
    if (replacementStarted) { drain(newer, "SYNTHETIC_COMPETING_WRITE_CLEANUP"); await settle(); }
    check(!picker(A)?.disabled && !row(A)?.querySelector("em"), "old refusal releases retained reservation without a stale row error");
    const retry = avatarOwnerCalls.length; choose(A, await png("#805020")); await dispatched(retry);
    avatarOwnerResolve(retry); await settle();
    check(shownAvatar(A) === avatarOwnerCalls[retry].dataUrl && !picker(A)?.disabled, "readded owner can retry after prior backend write settles");

    for (const outcome of ["success", "reject"] as const) {
      const first = avatarOwnerCalls.length, previous = shownAvatar(A);
      choose(A, await png(outcome === "success" ? "#d030b0" : "#3070b0")); await dispatched(first);
      document.querySelector<HTMLButtonElement>(".unlock-add-profile")!.click();
      const back = await waitFor(() => document.querySelector<HTMLButtonElement>(".welcome-profile-back") ?? undefined, "Welcome back to profiles");
      back.click(); await waitFor(() => picker(A), "same-owner UnlockProfiles remount"); await settle();
      const competing = avatarOwnerCalls.length;
      choose(A, await png("#107090")); await settle();
      check(picker(A)?.disabled && avatarOwnerCalls.length === competing && competing === first + 1,
        "Add Profile and back retains one backend mutation for unchanged owner: " + outcome);
      const events = profileEvents;
      avatarOwnerResolve(first, outcome === "reject" ? "SYNTHETIC_UNMOUNTED_ROOT_REFUSAL" : undefined); await settle();
      if (outcome === "success") {
        check(profileEvents > events, "old Unlock lifetime announces committed avatar for canonical refresh");
        check(shownAvatar(A) === avatarOwnerCalls[first].dataUrl, "fresh remounted Unlock reads old-lifetime committed avatar");
      } else check(shownAvatar(A) === previous && !row(A)?.querySelector("em"), "old Unlock refusal preserves remount avatar without stale error");
      drain(competing, "SYNTHETIC_COMPETING_WRITE_CLEANUP"); await settle();
      check(!picker(A)?.disabled, "settled old Unlock request releases shared owner reservation: " + outcome);
    }

    const unmounted = avatarOwnerCalls.length;
    choose(A, await png("#60b030")); await dispatched(unmounted); avatarOwnerCommit(unmounted);
    document.querySelector<HTMLButtonElement>(".unlock-add-profile")!.click(); await frames();
    const create = [...document.querySelectorAll<HTMLButtonElement>(".welcome-screen button")].find(button => button.textContent?.includes("Создать профиль"))!;
    create.click(); await frames();
    const draft = document.querySelector<HTMLInputElement>('.create-flow input:not([type])')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(draft, "Avatar route draft"); draft.dispatchEvent(new Event("input", { bubbles: true })); await frames();
    avatarOwnerResolve(unmounted); await settle();
    check(!!document.querySelector(".create-flow") && document.querySelector<HTMLInputElement>('.create-flow input:not([type])')?.value === "Avatar route draft",
      "unmounted Unlock completion preserves current Add Profile route and draft");
    document.querySelector<HTMLButtonElement>(".create-flow .startup-back")!.click(); await frames();
    document.querySelector<HTMLButtonElement>(".welcome-profile-back")!.click();
    await waitFor(() => picker(A), "return from preserved create draft"); await settle();
    await replace(avatarOwnerProfiles().map(profile => ({ ...profile, active: profile.id === A })));
    const crossing = avatarOwnerCalls.length;
    choose(A, await png("#d08a10")); await dispatched(crossing);
    document.querySelector<HTMLButtonElement>(".unlock-actions .startup-primary")!.click();
    await waitFor(() => document.querySelector(".app-shell") ?? undefined, "Continue into actual Messenger");
    document.querySelector<HTMLButtonElement>(".rail-profile-menu-button")!.click();
    const menu = await waitFor(() => document.querySelector(".rail-profile-menu") ?? undefined, "Messenger profile menu");
    menu.querySelector<HTMLButtonElement>("button")!.click();
    const profileTab = await waitFor(() => document.querySelector<HTMLButtonElement>('.settings-tabs button[aria-label="Профиль"]') ?? undefined, "Messenger Settings profile tab");
    profileTab.click(); await settle();
    const settingsFile = document.querySelector<HTMLInputElement>(".avatar-upload input[type=file]")!;
    const settingsOld = document.querySelector<HTMLImageElement>(".settings-avatar img")?.src;
    const competing = avatarOwnerCalls.length, transfer = new DataTransfer(); transfer.items.add(await png("#10a090"));
    Object.defineProperty(settingsFile, "files", { configurable: true, value: transfer.files });
    settingsFile.dispatchEvent(new Event("change", { bubbles: true })); await settle();
    check(settingsFile.disabled && avatarOwnerCalls.length === competing && competing === crossing + 1,
      "Unlock to Messenger Settings retains one pending backend mutation for same owner");
    check(document.querySelector<HTMLImageElement>(".settings-avatar img")?.src === settingsOld, "cross-view pending owner write preserves Settings avatar");
    const events = profileEvents;
    avatarOwnerResolve(crossing); await settle();
    check(profileEvents > events && document.querySelector<HTMLImageElement>(".settings-avatar img")?.src === avatarOwnerCalls[crossing].dataUrl,
      "old Unlock success refreshes current Messenger Settings from canonical owner");
    drain(competing, "SYNTHETIC_COMPETING_WRITE_CLEANUP"); await settle();
    check(avatarOwnerPending() === 0, "all deferred avatar commands are drained");
    return { ok: failures.length === 0, assertions, failures, profileEvents, boundary: "actual RootApp/UnlockProfiles and Messenger Settings + actual FileReader/image.decode/canvas normalization; disposable deferred platform", calls: avatarOwnerCalls.map(({bytes, dataUrl, ...call}) => ({...call, byteLength:bytes?.length ?? null, dataUrlLength:dataUrl?.length ?? null})) };
  } catch (error) {
    return { ok:false, assertions, failures, error:error instanceof Error ? error.stack : String(error), pending:avatarOwnerPending(), calls:avatarOwnerCalls.map(({bytes,dataUrl,...call})=>({...call,byteLength:bytes?.length ?? null,dataUrlLength:dataUrl?.length ?? null})) };
  } finally {
    FileReader.prototype.readAsDataURL = nativeRead; HTMLImageElement.prototype.decode = nativeDecode;
    window.removeEventListener("profiles-changed", onProfilesChanged);
    heldRead?.(); heldDecode?.(); drain(0, "SYNTHETIC_FIXTURE_CLEANUP");
  }
}
