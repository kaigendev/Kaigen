import "../../../src/App.css";
import { scrollMessageWithinContainer } from "../../../src/chatNavigation";

type GeometryResult = {
  ok: boolean;
  assertions: number;
  fileGeometry?: FileGeometryEvidence;
  details?: Record<string, number | string>;
  error?: string;
};

declare global {
  var __KAIGEN_CHAT_GEOMETRY_RESULT__: GeometryResult | undefined;
  var __KAIGEN_CHAT_GEOMETRY_PHASE__: string | undefined;
}

globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__ = "module";

let assertions = 0;
function check(value: unknown, message: string): asserts value {
  assertions += 1;
  if (!value) throw new Error(message);
}

const layoutTurn = () => new Promise<void>((resolve) => setTimeout(resolve));

function top(element: Element) {
  return element.getBoundingClientRect().top;
}

function unchanged(actual: number, expected: number, label: string) {
  check(Math.abs(actual - expected) < 0.5, `${label} moved from ${expected} to ${actual}`);
}

type FileGeometryEvidence = {
  assertions: number;
  terminalCases: number;
  preservedCases: number;
  oldNoWrapOverflow: boolean;
  cases: Array<Record<string, string | number>>;
};

function checkAttachmentGeometry(): FileGeometryEvidence {
  let checked = 0;
  const verify = (value: unknown, message: string) => {
    checked += 1;
    if (!value) throw new Error(`attachment geometry: ${message}`);
  };
  const evidence: FileGeometryEvidence = { assertions: 0, terminalCases: 0, preservedCases: 0, oldNoWrapOverflow: false, cases: [] };
  const host = document.createElement("div");
  host.className = "message-scroll";
  // Only the available chat width and user font settings are fixture inputs.
  // All card, text, metadata and control geometry comes from production App.css.
  Object.assign(host.style, { position: "fixed", left: "0", top: "0", height: "600px" });
  document.body.append(host);
  const rect = (element: Element, relativeTo: Element) => {
    const bounds = element.getBoundingClientRect();
    const origin = relativeTo.getBoundingClientRect();
    return [bounds.left - origin.left, bounds.top - origin.top, bounds.width, bounds.height];
  };
  const parts = (card: HTMLElement) => [...card.querySelectorAll<HTMLElement>(
    ".file-attachment, .file-attachment > *, .file-static-meta > *, .attachment-transfer, .attachment-transfer > *, .transfer-control, time",
  )].filter((element) => getComputedStyle(element).display !== "none")
    .map((element) => ({ className: element.className, bounds: rect(element, card) }));
  const sameParts = (actual: ReturnType<typeof parts>, before: ReturnType<typeof parts>) => actual.length === before.length
    && actual.every((part, index) => part.className === before[index].className
      && part.bounds.every((value, axis) => Math.abs(value - before[index].bounds[axis]) < 0.5));
  const rangeBounds = (element: HTMLElement) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return [...range.getClientRects()].filter((bounds) => bounds.width > 0 && bounds.height > 0);
  };
  const within = (inner: DOMRect, outer: DOMRect) => inner.left >= outer.left - 0.5
    && inner.right <= outer.right + 0.5 && inner.top >= outer.top - 0.5 && inner.bottom <= outer.bottom + 0.5;
  const makeCard = (mine: boolean, state: string) => {
    const card = document.createElement("article");
    card.className = `message ${mine ? "mine " : ""}has-file`;
    // Match the two App.tsx attachment branches: a terminal direct error and
    // an activity-grid error have different parents despite sharing a class.
    card.innerHTML = `<div class="file-attachment"><span class="file-attachment-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 1.5h5.25l3.75 3.75v9.25h-9z" /></svg></span><span>fixture-64k.bin</span></div>`;
    const file = card.firstElementChild!;
    if (state === "failed" || state === "completed") {
      const meta = document.createElement("small");
      meta.className = "file-static-meta";
      meta.textContent = state === "failed" ? "Ошибка передачи" : "64 KiB";
      if (mine && state === "failed") meta.innerHTML += '<button class="transfer-control transfer-retry" aria-label="Повторить передачу">↻</button>';
      meta.innerHTML += `<time>12:34${mine ? '<span class="delivery-state"></span>' : ""}</time>`;
      file.append(meta);
    } else {
      const actions = document.createElement("div");
      actions.className = "attachment-transfer-actions attachment-transfer-actions-header";
      if (!mine && state === "awaiting_confirmation") actions.innerHTML = '<button class="transfer-control transfer-retry transfer-accept">Принять файл</button>';
      else if (state !== "queued" && state !== "awaiting_confirmation") actions.innerHTML = `<button class="transfer-control transfer-${state === "paused" ? "resume" : "pause"}">${state === "paused" ? "▶" : "Ⅱ"}</button>`;
      actions.innerHTML += '<button class="transfer-control transfer-cancel">×</button>';
      file.append(actions);
      const activity = document.createElement("div");
      activity.className = "attachment-transfer attachment-transfer-file";
      activity.innerHTML = `<div class="attachment-transfer-head"><b>Передача файла</b></div><div class="attachment-progress"><i style="width: 50%"></i></div><small>${state === "queued" ? "Ожидает отправки" : state === "awaiting_confirmation" ? "Файл отправлен, ожидается подтверждение получателя" : state === "paused" ? "Передача приостановлена" : "Отправка: ожидание получателя…"}</small>${state === "control-error" ? '<small class="attachment-transfer-error">Не удалось приостановить передачу. Попробуйте ещё раз.</small>' : ""}<small class="file-transfer-meta"><span class="file-transfer-percent">50%</span><time>12:34${mine ? '<span class="delivery-state"></span>' : ""}</time></small>`;
      card.append(activity);
    }
    return card;
  };
  const messages = [
    ["ru", "Передача файла завершилась ошибкой: Тайм-аут передачи. Можно отправить файл заново."],
    ["en", "File transfer failed: The transfer timed out. You can send the file again."],
    ["long-token", "File transfer failed: " + "unbroken_diagnostic_token_".repeat(12)],
  ];
  try {
    for (const width of [360, 760]) for (const fontSize of [16, 22]) for (const mine of [false, true]) {
      host.style.width = `${width}px`;
      host.style.fontSize = `${fontSize}px`;
      host.style.setProperty("--chat-font", "Arial, sans-serif");
      host.style.setProperty("--chat-font-size", `${fontSize}px`);
      const direction = mine ? "outgoing" : "incoming";
      for (const [language, message] of messages) {
        const label = `${width}/${fontSize}/${direction}/${language}`;
        const card = makeCard(mine, "failed");
        const error = document.createElement("small");
        error.className = "attachment-transfer-error";
        error.textContent = "Short error";
        card.append(error);
        host.replaceChildren(card);
        const short = { width: card.getBoundingClientRect().width, height: card.getBoundingClientRect().height, scrollWidth: card.scrollWidth, parts: parts(card) };
        error.textContent = message;
        const box = card.getBoundingClientRect();
        const lines = rangeBounds(error);
        verify(error.textContent === message && lines.length > 1, `${label}: full terminal error must wrap`);
        verify(lines.every((line) => within(line, error.getBoundingClientRect()) && within(line, box)), `${label}: terminal glyph bounds leave their card`);
        verify(error.scrollWidth <= error.clientWidth + 1 && error.scrollHeight <= error.clientHeight + 1, `${label}: terminal text is clipped`);
        // The existing outgoing bubble tail contributes to card.scrollWidth.
        // Text must stay inside the contour, without increasing that baseline.
        verify(host.scrollWidth <= host.clientWidth + 1 && card.scrollWidth <= short.scrollWidth + 1, `${label}: error adds horizontal scrolling (${host.scrollWidth}/${host.clientWidth}; card ${card.scrollWidth}/${short.scrollWidth})`);
        verify(Math.abs(box.width - short.width) < 0.5 && box.height > short.height + 1, `${label}: wrapping must grow height, preserving card width`);
        verify(sameParts(parts(card), short.parts), `${label}: terminal error changes file row, retry, or time geometry`);
        if (!evidence.oldNoWrapOverflow) {
          error.setAttribute("style", "display: inline; max-width: none; white-space: nowrap; overflow-wrap: normal");
          evidence.oldNoWrapOverflow = rangeBounds(error).some((line) => line.right > box.right + 1);
          verify(evidence.oldNoWrapOverflow, "old inline/nowrap control must reproduce the observed overflow");
          error.removeAttribute("style");
        }
        evidence.terminalCases += 1;
        evidence.cases.push({ kind: "terminal", width, fontSize, direction, language, cardWidth: box.width, cardHeight: box.height, lines: lines.length });
      }
      for (const state of ["queued", "awaiting_confirmation", "active", "paused", "control-error", "completed"]) {
        const label = `${width}/${fontSize}/${direction}/${state}`;
        const card = makeCard(mine, state);
        host.replaceChildren(card);
        const before = parts(card);
        const oldRule = document.createElement("style");
        oldRule.textContent = ".message.has-file > .attachment-transfer-error { display: inline; max-width: none; white-space: nowrap; overflow-wrap: normal; }";
        document.head.append(oldRule);
        const oldParts = parts(card);
        oldRule.remove();
        verify(sameParts(parts(card), oldParts) && sameParts(parts(card), before), `${label}: terminal fix changes an unaffected file card`);
        verify(host.scrollWidth <= host.clientWidth + 1, `${label}: card overflows the chat (${host.scrollWidth}/${host.clientWidth})`);
        const activity = card.querySelector<HTMLElement>(".attachment-transfer");
        if (activity) {
          const status = activity.querySelector<HTMLElement>(state === "control-error" ? ".attachment-transfer-error" : ":scope > small:not(.file-transfer-meta)")!;
          verify(Math.abs(status.getBoundingClientRect().height - 16) < 0.5 && getComputedStyle(status).whiteSpace === "nowrap", `${label}: inner grid status must remain one fixed row`);
          verify(within(activity.getBoundingClientRect(), card.getBoundingClientRect()), `${label}: activity grid leaves the card`);
        }
        evidence.preservedCases += 1;
        evidence.cases.push({ kind: "preserved", width, fontSize, direction, state, cardWidth: card.getBoundingClientRect().width, cardHeight: card.getBoundingClientRect().height });
      }
    }
  } finally {
    host.remove();
  }
  evidence.assertions = checked;
  return evidence;
}

async function run() {
  globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__ = "run";
  document.body.innerHTML = `
    <main class="app-shell">
      <aside class="rail"></aside>
      <aside class="chat-list"></aside>
      <section class="conversation">
        <header class="conversation-header"><span class="header-copy"><strong>QA Bob</strong></span></header>
        <div class="message-scroll" tabindex="0">
          <article class="message" data-message-key="head"><p><span>Сообщение0</span></p></article>
          <div class="history-space" style="height: 16000px"></div>
          <article class="message" data-message-key="deep"><p><span>Needle distant history</span></p></article>
          <div class="history-space" style="height: 16000px"></div>
          <article class="message mine" data-message-key="tail"><p><span>Сообщение99999</span></p></article>
        </div>
        <div class="chat-composer-section">
          <div class="composer"><div class="compose-row">
            <button class="attach" type="button">+</button>
            <textarea placeholder="Write a message"></textarea>
            <button class="send" type="button">Send</button>
          </div></div>
        </div>
      </section>
    </main>`;

  const conversation = document.querySelector<HTMLElement>(".conversation")!;
  const header = document.querySelector<HTMLElement>(".conversation-header")!;
  const scroller = document.querySelector<HTMLElement>(".message-scroll")!;
  const composer = document.querySelector<HTMLElement>(".composer")!;
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea")!;
  const send = document.querySelector<HTMLButtonElement>(".send")!;
  const tail = document.querySelector<HTMLElement>('[data-message-key="tail"]')!;
  const deep = document.querySelector<HTMLElement>('[data-message-key="deep"]')!;
  let queued: HTMLElement | undefined;

  send.addEventListener("click", () => {
    queued = document.createElement("article");
    queued.className = "message mine";
    queued.dataset.messageKey = "queued";
    queued.innerHTML = `<p><span>${textarea.value}</span></p>`;
    scroller.append(queued);
    textarea.value = "";
  });

  await layoutTurn();
  check(CSS.supports("overflow", "clip"), "runtime does not support overflow: clip");
  check(getComputedStyle(conversation).overflowY === "clip", "production conversation must compute overflow: clip");
  check(conversation.scrollHeight > conversation.clientHeight, "composer continuation must reproduce the nested scroll-parent boundary");

  conversation.style.overflow = "hidden";
  tail.scrollIntoView({ block: "center" });
  await layoutTurn();
  check(conversation.scrollTop > 1, "control did not reproduce unrestricted scrollIntoView moving the outer conversation");

  conversation.style.overflow = "clip";
  conversation.scrollTop = 0;
  scroller.scrollTop = 0;
  await layoutTurn();
  const headerTop = top(header);
  const composerTop = top(composer);

  const lastSearchMatch = [...scroller.querySelectorAll<HTMLElement>("[data-message-key]")]
    .find((item) => item.textContent?.includes("Сообщение99999"));
  check(lastSearchMatch === tail, "last-message search did not resolve the tail message");
  scrollMessageWithinContainer(scroller, lastSearchMatch!);
  await layoutTurn();
  check(conversation.scrollTop === 0, "last-message search moved the outer conversation");
  unchanged(top(header), headerTop, "header after last-message search");
  unchanged(top(composer), composerTop, "composer after last-message search");

  scrollMessageWithinContainer(scroller, deep);
  textarea.scrollIntoView({ block: "center" });
  textarea.focus();
  textarea.value = "queued from deep history";
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: textarea.value }));
  const readingTop = deep.getBoundingClientRect().top;
  const readingScrollTop = scroller.scrollTop;
  send.click();
  await layoutTurn();
  check(document.activeElement === textarea, "composer lost focus during deep-history send");
  check(queued?.textContent === "queued from deep history", "deep-history send did not append the queued row");
  check(!document.querySelector(".chat-pending-send"), "successful deep-history send exposed the obsolete queued-message notice");
  check(!document.querySelector(".transfer-toast"), "successful deep-history send exposed a transfer toast");
  check(!document.querySelector(".chat-return-anchor"), "successful deep-history send exposed a reading-position return control");
  check(Math.abs(scroller.scrollTop - readingScrollTop) < 0.5, "deep-history send changed the reading scroll position");
  unchanged(top(deep), readingTop, "reading anchor after deep-history send");
  check(conversation.scrollTop === 0, "deep-history send moved the outer conversation");
  unchanged(top(header), headerTop, "header after deep-history send");
  unchanged(top(composer), composerTop, "composer after deep-history send");

  const fileGeometry = checkAttachmentGeometry();

  globalThis.__KAIGEN_CHAT_GEOMETRY_RESULT__ = {
    ok: true,
    fileGeometry,
    assertions,
    details: {
      conversationScrollTop: conversation.scrollTop,
      headerTop: top(header),
      composerTop: top(composer),
      innerScrollTop: scroller.scrollTop,
    },
  };
  globalThis.__KAIGEN_CHAT_GEOMETRY_PHASE__ = "complete";
}

run().catch((error) => {
  globalThis.__KAIGEN_CHAT_GEOMETRY_RESULT__ = {
    ok: false,
    assertions,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
});
