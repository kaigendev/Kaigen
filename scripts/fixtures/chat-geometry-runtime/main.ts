import "../../../src/App.css";
import { scrollMessageWithinContainer } from "../../../src/chatNavigation";

type GeometryResult = {
  ok: boolean;
  assertions: number;
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
          <button class="chat-pending-send" hidden>Message queued · show</button>
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
  const queuedNotice = document.querySelector<HTMLButtonElement>(".chat-pending-send")!;
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
    queuedNotice.hidden = false;
  });
  queuedNotice.addEventListener("click", () => {
    if (queued) scrollMessageWithinContainer(scroller, queued);
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
  send.click();
  check(document.activeElement === textarea, "composer lost focus during deep-history send");
  check(queued?.textContent === "queued from deep history", "deep-history send did not append the queued row");
  check(!queuedNotice.hidden, "deep-history send did not expose the queued-message jump");
  queuedNotice.click();
  await layoutTurn();
  check(conversation.scrollTop === 0, "deep-history send/jump moved the outer conversation");
  unchanged(top(header), headerTop, "header after deep-history send/jump");
  unchanged(top(composer), composerTop, "composer after deep-history send/jump");

  globalThis.__KAIGEN_CHAT_GEOMETRY_RESULT__ = {
    ok: true,
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
