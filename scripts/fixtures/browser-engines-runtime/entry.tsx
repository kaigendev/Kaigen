import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import WebRoot from "../../../src/web/WebRoot";
import { webSession } from "../../../src/web/session";
import MessageComposer, { clearSpellcheckMemory } from "../../../src/SpellcheckComposer";
import { ThemeProvider } from "@kaigen/theme";
import { I18nProvider } from "../../../src/i18n";
import "../../../src/theme.css";

const trace = { workers: [] as Array<{ url: string; messages: unknown[]; errors: number; terminated: boolean }>, draft: "", sent: [] as string[] };
const NativeWorker = globalThis.Worker;
// Observe real native workers; no ready/checked/suggestion messages are mocked.
class ObservedWorker extends NativeWorker {
  private record: (typeof trace.workers)[number];
  constructor(scriptURL: string | URL, options?: WorkerOptions) {
    super(scriptURL, options);
    this.record = { url: String(scriptURL), messages: [], errors: 0, terminated: false };
    trace.workers.push(this.record);
    this.addEventListener("message", (event) => this.record.messages.push(event.data));
    this.addEventListener("error", () => { this.record.errors += 1; });
  }
  terminate() { this.record.terminated = true; super.terminate(); }
}
globalThis.Worker = ObservedWorker;
let showWorker: (shown: boolean) => void = () => {};
function Fixture() {
  const [shown, setShown] = useState(false);
  showWorker = setShown;
  return <ThemeProvider initialTheme="current">
    <WebRoot />
    {shown && <aside id="engine-worker-probe" style={{ position: "fixed", bottom: 0, left: 0, width: 420, zIndex: 20000, background: "white" }}>
      <I18nProvider language="en" setLanguage={() => {}}><MessageComposer
        chatId="engine-worker-local" initialValue={trace.draft} sendOnEnter
        spellcheckEnabled spellcheckRussian={false} spellcheckEnglish
        onDraftChange={(_owner, value) => { trace.draft = value; }}
        onSend={async (value) => { trace.sent.push(value); return true; }}
        onStageFiles={() => {}} fileActionsEnabled={false}
      /></I18nProvider>
    </aside>}
  </ThemeProvider>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
const fixture = {
  session: webSession, trace,
  showWorker: () => showWorker(true),
  hideWorker: () => { showWorker(false); clearSpellcheckMemory(); },
  unmount: () => { root.unmount(); clearSpellcheckMemory(); },
};
Object.assign(globalThis, { __KAIGEN_ENGINE_FIXTURE__: fixture });
