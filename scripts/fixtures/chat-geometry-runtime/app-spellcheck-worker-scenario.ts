import { composer } from "./composer-test-adapter";
import { spellcheckProbe } from "./spellcheck-control";
import { checkRequest, chooseContact, config, draft, frames, openSuggestion, ranges, selection, send, setToggle, settings, waitFor, worker } from "./spellcheck-test-helpers";

export async function runActualSpellcheckWorkerScenario() {
  let assertions = 0;
  const failures: string[] = [], cases: Record<string, any>[] = [];
  const check = (condition: unknown, label: string) => { assertions++; if (!condition) failures.push(label); };
  try {
    await chooseContact("QA Carol");
    const record = worker(), failed = config(record);
    check(record.mode === "native" && record.url.includes("spellcheck.worker"), "actual native product Worker is running");
    await waitFor(() => record.incoming.find((item) => item.type === "error" && item.configId === failed.configId), "actual HTTP dictionary error", 20_000);
    await draft("🙂 привеет hello", 5);
    check(composer()?.value === "🙂 привеет hello" && selection().start === 5 && ranges().length === 0, "HTTP refusal preserves real draft/caret without false highlights");
    check((await send("native dictionary failure send")).text === "native dictionary failure send", "actual send succeeds during real dictionary failure");
    await settings(); await setToggle("Русский", false); await chooseContact("QA Carol");
    const english = config(record);
    await waitFor(() => record.incoming.find((item) => item.type === "ready" && item.configId === english.configId), "EN remains available", 20_000);
    await draft("🙂 helo suffix", 5);
    const enCheck = await checkRequest("🙂 helo suffix");
    await waitFor(() => record.incoming.find((item) => item.type === "checked" && item.revision === enCheck.revision && item.configId === english.configId), "actual EN check");
    await frames();
    check(ranges().some((range) => range.toString() === "helo") && selection().start === 5, "actual Hunspell EN produces editor highlight with stable caret");
    const request = await openSuggestion(record, ranges().findIndex((range) => range.toString() === "helo"));
    await waitFor(() => record.incoming.find((item) => item.type === "suggestions" && item.requestId === request.requestId && item.configId === request.configId && item.tokenId === request.tokenId), "actual Hunspell suggestion");
    const hello = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".spellcheck-context-menu button")].find((button) => button.textContent === "hello"), "actual hello suggestion");
    hello.click(); await frames();
    check(composer()?.value === "🙂 hello suffix" && selection().start === 8, "native suggestion replaces exact UTF-16 word and preserves suffix/caret");

    await fetch("/__spellcheck-fixture__/fault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ failRussian: false }) });
    await settings(); await setToggle("Русский", true); await chooseContact("QA Carol");
    const retry = config(record);
    const completion = await waitFor(() => record.incoming.find((item) => ["ready", "error"].includes(item.type) && item.configId === retry.configId), "same Worker RU retry completion", 20_000);
    check(completion.type === "ready", "failed RU dictionary retries after HTTP recovery on same Worker");
    check(worker() === record && !record.terminated && spellcheckProbe.workers.length === 1, "RU retry keeps the original native Worker with EN enabled");
    if (completion.type === "ready") {
      await draft("🙂 привеет helo", 5); const actual = await checkRequest("🙂 привеет helo", record);
      await waitFor(() => record.incoming.find((item) => item.type === "checked" && item.revision === actual.revision && item.configId === retry.configId), "actual RU/EN recovered check"); await frames();
      check(ranges().map((range) => range.toString()).join("|") === "привеет|helo" && composer()?.value === "🙂 привеет helo" && selection().start === 5, "recovered actual RU/EN highlights exact ranges without altering draft/caret");
      const ruSuggest = await openSuggestion(record);
      const ruResult = await waitFor(() => record.incoming.find((item) => item.type === "suggestions" && item.requestId === ruSuggest.requestId && item.configId === ruSuggest.configId && item.tokenId === ruSuggest.tokenId), "actual RU recovered suggestion");
      const ruButton = await waitFor(() => [...document.querySelectorAll<HTMLButtonElement>(".spellcheck-context-menu button")].find((button) => ruResult.suggestions.includes(button.textContent)), "actual RU suggestion painted");
      check(ruResult.suggestions.length > 0 && !!ruButton, "recovered RU dictionary supplies actual suggestions");
      check((await send("native recovery send")).text === "native recovery send", "send stays usable after native recovery");
    }
    const http = await fetch("/__spellcheck-fixture__/fault").then((response) => response.json());
    check(http.requests.some((item: any) => item.path === "/dictionaries/ru-RU.dic" && item.status === 503) && http.requests.some((item: any) => item.path === "/dictionaries/ru-RU.dic" && item.status === 200), "raw HTTP records show failed and recovered RU dictionary request");
    check(http.requests.filter((item: any) => item.path.startsWith("/dictionaries/en-US.") && item.status === 200).length === 2, "healthy EN aff/dic cache is reused across RU retry");
    cases.push({ http, worker: { id: record.id, url: record.url, terminated: record.terminated, outgoing: record.outgoing, incoming: record.incoming }, retry: completion });
  } catch (error) {
    failures.push(String(error));
    cases.push({ failedTrace: spellcheckProbe.workers.map((record) => ({ id: record.id, mode: record.mode, terminated: record.terminated, outgoing: record.outgoing, incoming: record.incoming })), http: await fetch("/__spellcheck-fixture__/fault").then((response) => response.json()).catch(() => null) });
  }
  return { ok: failures.length === 0, boundary: "actual RootApp/Settings/MessageComposer, native Worker and real bundled Hunspell dictionaries over loopback HTTP", assertions, failures, cases };
}
