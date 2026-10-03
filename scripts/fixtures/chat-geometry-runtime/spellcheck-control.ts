// Disposable Worker boundary. Native mode executes the actual product worker.
type Message = Record<string, any>;
export type WorkerRecord = {
  id: number; mode: "controlled" | "native"; url: string; terminated: boolean;
  outgoing: Message[]; incoming: Message[]; worker: Worker;
};
const parameters = new URLSearchParams(location.search);
const nativeWorker = globalThis.Worker;
export const spellcheckProbe = {
  enabled: parameters.has("spellcheck-controlled") || parameters.has("spellcheck-native"),
  mode: parameters.has("spellcheck-native") ? "native" as const : "controlled" as const,
  failConstructors: 0,
  attempts: [] as Array<{ url: string; failed: boolean }>,
  workers: [] as WorkerRecord[],
  deliver(record: WorkerRecord, message: Message) {
    if (record.mode !== "controlled") throw new Error("Cannot inject a native Worker result");
    record.incoming.push(structuredClone(message));
    const event = new MessageEvent("message", { data: message });
    record.worker.onmessage?.call(record.worker, event);
    record.worker.dispatchEvent(event);
  },
  fail(record: WorkerRecord, type: "error" | "messageerror") {
    if (record.mode !== "controlled") throw new Error("Cannot inject a native Worker failure");
    const event = type === "error" ? new ErrorEvent("error", { message: "Disposable Worker failure" }) : new MessageEvent("messageerror");
    if (type === "error") record.worker.onerror?.call(record.worker, event as ErrorEvent);
    else record.worker.onmessageerror?.call(record.worker, event as MessageEvent);
    record.worker.dispatchEvent(event);
  },
};

class ControlledWorker extends EventTarget {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage() {}
  terminate() {}
}

if (spellcheckProbe.enabled) {
  globalThis.Worker = function (url: string | URL, options?: WorkerOptions) {
    const source = String(url);
    if (!source.includes("spellcheck.worker")) return new nativeWorker(url, options);
    const failed = spellcheckProbe.failConstructors > 0;
    spellcheckProbe.attempts.push({ url: source, failed });
    if (failed) { spellcheckProbe.failConstructors--; throw new Error("Disposable Worker constructor refusal"); }
    const worker = spellcheckProbe.mode === "native" ? new nativeWorker(url, options) : new ControlledWorker() as unknown as Worker;
    const record: WorkerRecord = {
      id: spellcheckProbe.workers.length, mode: spellcheckProbe.mode, url: source,
      terminated: false, outgoing: [], incoming: [], worker,
    };
    spellcheckProbe.workers.push(record);
    const post = worker.postMessage.bind(worker);
    worker.postMessage = ((message: Message, transfer?: Transferable[]) => {
      record.outgoing.push(structuredClone(message));
      post(message, transfer ?? []);
    }) as Worker["postMessage"];
    const terminate = worker.terminate.bind(worker);
    worker.terminate = () => { record.terminated = true; terminate(); };
    if (record.mode === "native") worker.addEventListener("message", (event) => record.incoming.push(structuredClone(event.data)));
    return worker;
  } as unknown as typeof Worker;
  globalThis.Worker.prototype = nativeWorker.prototype;
}
