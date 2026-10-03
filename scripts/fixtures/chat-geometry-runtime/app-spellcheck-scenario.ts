import { composer } from "./composer-test-adapter";
import { geometrySetMenuProfiles } from "./app-platform";
import { spellcheckProbe } from "./spellcheck-control";
import { checkRequest, checked, chooseContact, config, delay, draft, frames, openSuggestion, ranges, selection, send, setToggle, settings, suggestion, waitFor, worker } from "./spellcheck-test-helpers";

export async function runActualAppSpellcheckScenario() {
  let assertions = 0;
  const failures: string[] = [], cases: Record<string, any>[] = [];
  const check = (condition: unknown, label: string) => { assertions++; if (!condition) failures.push(label); };
  try {
    await chooseContact("QA Carol");
    check(spellcheckProbe.enabled && worker().mode === "controlled" && !!(CSS as any).highlights, "controlled Worker boundary and real Highlight API are active");
    let record = worker(), current = config(record);
    spellcheckProbe.deliver(record, { type: "ready", configId: current.configId }); await frames();
    await draft("старрое", 3);
    const oldText = await checkRequest("старрое");
    await draft("новоое", 2);
    const newText = await checkRequest("новоое");
    spellcheckProbe.deliver(record, checked(oldText)); await frames();
    check(ranges().length === 0 && composer()?.value === "новоое" && selection().start === 2, "old text revision cannot highlight or move current draft/caret");
    spellcheckProbe.deliver(record, checked(newText)); await frames();
    check(ranges().map((range) => range.toString()).join() === "новоое", "current text result highlights actual editor range");
    const oldSuggestion = await openSuggestion();
    await draft("друггой", 4);
    spellcheckProbe.deliver(record, suggestion(oldSuggestion, "СТАРАЯ_ЗАМЕНА")); await frames();
    check(!document.querySelector(".spellcheck-context-menu") && composer()?.value === "друггой" && selection().start === 4, "late suggestion after text edit has no menu, replacement or caret effect");
    const beforeSwitch = await checkRequest("друггой");
    spellcheckProbe.deliver(record, checked(beforeSwitch)); await frames();
    const chatSuggestion = await openSuggestion();
    await chooseContact("QA Dave"); await draft("neighbor draft", 5);
    spellcheckProbe.deliver(record, checked(beforeSwitch));
    spellcheckProbe.deliver(record, suggestion(chatSuggestion, "СТАРЫЙ_ЧАТ")); await frames();
    check(ranges().length === 0 && !document.querySelector(".spellcheck-context-menu") && composer()?.value === "neighbor draft" && selection().start === 5, "old chat check/suggestion cannot touch neighbor draft/caret");
    await chooseContact("QA Carol");
    check(composer()?.value === "друггой", "unsent Carol draft survives neighbor chat round trip");

    const oldConfig = config(record);
    await settings(); await setToggle("English", true); await setToggle("Русский", false); await chooseContact("QA Carol");
    current = config(record);
    check(current.configId !== oldConfig.configId && current.english && !current.russian, "actual Settings changes worker RU/EN config");
    const afterLanguage = record.outgoing.length;
    await draft("engglish", 3);
    spellcheckProbe.deliver(record, { type: "ready", configId: oldConfig.configId });
    spellcheckProbe.deliver(record, checked(beforeSwitch));
    spellcheckProbe.deliver(record, suggestion(chatSuggestion, "СТАРАЯ_КОНФИГУРАЦИЯ")); await delay(650); await frames();
    check(record.outgoing.slice(afterLanguage).every((item) => item.type !== "check") && ranges().length === 0 && !document.querySelector(".spellcheck-context-menu"), "old RU ready/checked/suggestion cannot activate new EN config");
    spellcheckProbe.deliver(record, { type: "ready", configId: current.configId }); await frames();
    const freshLanguage = await checkRequest("engglish", record, afterLanguage);
    spellcheckProbe.deliver(record, checked(freshLanguage)); await frames();
    check(ranges().map((range) => range.toString()).join() === "engglish" && selection().start === 3, "new EN config checks without moving caret");

    await draft("🙂 helo suffix", 5);
    const utf16 = await checkRequest("🙂 helo suffix");
    spellcheckProbe.deliver(record, checked(utf16)); await frames();
    const replacement = await openSuggestion(record);
    spellcheckProbe.deliver(record, suggestion(replacement, "hello")); await frames();
    document.querySelector<HTMLButtonElement>(".spellcheck-context-menu button")!.click(); await frames();
    check(composer()?.value === "🙂 hello suffix" && selection().start === 8, "suggestion replaces exact UTF-16 word after emoji and leaves suffix/caret");

    const errorText = await checkRequest("🙂 hello suffix");
    spellcheckProbe.deliver(record, checked(errorText)); await frames();
    const pendingErrorSuggestion = await openSuggestion();
    spellcheckProbe.deliver(record, { type: "error", configId: config(record).configId, message: "Disposable dictionary refusal" }); await frames();
    check(ranges().length === 0 && !document.querySelector(".spellcheck-context-menu"), "dictionary error clears old highlights and pending suggestion menu");
    spellcheckProbe.deliver(record, suggestion(pendingErrorSuggestion, "ERROR_STALE")); await frames();
    spellcheckProbe.deliver(record, checked(errorText)); await frames();
    check(ranges().length === 0 && !document.querySelector(".spellcheck-context-menu") && composer()?.value === "🙂 hello suffix", "late checked/suggestion following dictionary error cannot reappear");
    check((await send("dictionary failure send")).text === "dictionary failure send", "send works during dictionary refusal");
    cases.push({ name: "text-config-chat-suggestion", outgoing: record.outgoing.length });

    await settings(); await setToggle("Проверять орфографию", false);
    check(record.terminated, "actual App releases disabled Worker");
    const constructorStart = spellcheckProbe.attempts.length;
    spellcheckProbe.failConstructors = 2;
    await setToggle("Проверять орфографию", true); await chooseContact("QA Carol");
    const constructorAttempts = spellcheckProbe.attempts.slice(constructorStart);
    const constructorMounted = !!composer() && !!document.querySelector(".rail-profile-menu-button");
    check(constructorAttempts.length > 0 && constructorAttempts.every((attempt) => attempt.failed) && constructorMounted, "constructor refusal keeps authenticated App/editor mounted");
    cases.push({ name: "constructor-refusal", attempts: constructorAttempts, mounted: constructorMounted });
    await draft("constructor draft", 4);
    check(composer()?.value === "constructor draft" && selection().start === 4, "constructor refusal leaves draft/caret usable");
    check((await send("constructor failure send")).text === "constructor failure send", "constructor refusal leaves actual send usable");
    await settings(); await setToggle("Проверять орфографию", false); await setToggle("Проверять орфографию", true); await chooseContact("QA Carol");
    record = worker(); current = config(record);
    spellcheckProbe.deliver(record, { type: "ready", configId: current.configId }); await frames();
    await draft("recoveryy", 3); const recovered = await checkRequest("recoveryy");
    spellcheckProbe.deliver(record, checked(recovered)); await frames();
    check(ranges().length === 1 && composer()?.value === "recoveryy" && selection().start === 3, "re-enable constructs healthy Worker and resumes spelling");

    for (const failure of ["error", "messageerror"] as const) {
      const beforeFailure = record;
      await openSuggestion(record);
      spellcheckProbe.fail(record, failure); await frames();
      check(record.terminated && ranges().length === 0 && !document.querySelector(".spellcheck-context-menu"), failure + " releases Worker and clears stale spelling/menu");
      check((await send(failure + " send")).text === failure + " send", failure + " does not block actual send");
      await settings(); await setToggle("Проверять орфографию", false); await setToggle("Проверять орфографию", true); await chooseContact("QA Carol");
      record = worker(); current = config(record);
      spellcheckProbe.deliver(record, { type: "ready", configId: current.configId }); await frames();
      await draft(failure + " recoveryy", 2); const request = await checkRequest(failure + " recoveryy");
      spellcheckProbe.deliver(record, checked(request)); await frames();
      spellcheckProbe.deliver(beforeFailure, { type: "error", configId: current.configId, message: "old retired Worker" }); await frames();
      check(ranges().length === 2 && composer()?.value === failure + " recoveryy" && selection().start === 2, failure + " recovery ignores retired Worker traffic and preserves draft/caret");
    }
    geometrySetMenuProfiles(true);
    const previousOwner = config(record), previousCheck = record.outgoing.findLast((item) => item.type === "check")!;
    const previousSuggestion = await openSuggestion(record);
    await waitFor(() => document.querySelector<HTMLButtonElement>('.profile-switcher-item[data-profile-id="qa-profile-b"]') ?? undefined, "owner B").then((item) => item.click());
    await waitFor(() => document.querySelector('.profile-switcher-item.active[data-profile-id="qa-profile-b"]') ?? undefined, "owner B active");
    await chooseContact("QA Dave"); await draft("B unsent neighbor", 6);
    spellcheckProbe.deliver(record, { type: "ready", configId: previousOwner.configId });
    spellcheckProbe.deliver(record, checked(previousCheck));
    spellcheckProbe.deliver(record, suggestion(previousSuggestion, "OLD_OWNER")); await frames();
    check(ranges().length === 0 && !document.querySelector(".spellcheck-context-menu") && composer()?.value === "B unsent neighbor" && selection().start === 6, "old owner traffic cannot alter B draft/caret/menu");
    cases.push({ name: "constructor-worker-failures-owner", attempts: spellcheckProbe.attempts, workers: spellcheckProbe.workers.map((item) => ({ id: item.id, mode: item.mode, terminated: item.terminated, outgoing: item.outgoing, incoming: item.incoming })) });
  } catch (error) { failures.push(String(error)); }
  return { ok: failures.length === 0, boundary: "actual RootApp/Settings/MessageComposer with controlled Worker events", assertions, failures, cases };
}
