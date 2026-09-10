import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../../src/i18n";
import PqEntropy, { PqCapabilityWait } from "../../../src/PqEntropy";
import "../../../src/theme.css";
import "../../../src/App.css";
import "./runtime.css";

declare global {
  interface Window {
    __PQ_ENTROPY_RUNTIME__?: { calls: number; noise: number[]; completedAt?: number };
    __PQ_ENTROPY_BEGIN__?: { calls: number; grantedAt?: number };
    __PQ_ENTROPY_VISIBLE_AT__?: number;
    __PQ_ENTROPY_UNMOUNT__?: () => void;
  }
}

document.documentElement.dataset.kaigenTheme = new URLSearchParams(location.search).get("theme") === "softlifegreen"
  ? "softlifegreen"
  : "current";

function Fixture() {
  const query = new URLSearchParams(location.search);
  const mode = query.get("mode") ?? "entropy";
  const fullShell = query.get("shell") === "full";
  const capability = mode === "capability";
  const cancelled = mode === "cancelled";
  const baseline = mode === "baseline";
  const [mounted, setMounted] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    const resize = new ResizeObserver(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    });
    const composerSection = document.querySelector('.chat-composer-section');
    if (composerSection) resize.observe(composerSection);
    const observer = new MutationObserver(() => {
      const panel = document.querySelector('.pq-entropy-panel');
      if (panel && panel.getBoundingClientRect().height > 0) requestAnimationFrame(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        window.__PQ_ENTROPY_VISIBLE_AT__ ??= performance.now();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__PQ_ENTROPY_UNMOUNT__ = () => setMounted(false);
    return () => { resize.disconnect(); observer.disconnect(); delete window.__PQ_ENTROPY_UNMOUNT__; };
  }, [mode]);
  return <I18nProvider language="ru" setLanguage={() => {}}>
    <main className={`app-shell pq-fixture-shell ${fullShell ? "pq-fixture-full-shell" : ""}`}>
      {fullShell && <>
        <nav className="rail" aria-label="Профили"><button className="rail-logo" aria-label="Kaigen">K</button></nav>
        <aside className="chat-list">
          <div className="profile-sidebar-header"><span className="avatar blue">Я</span><span className="own-profile-copy"><strong>Профиль</strong><small>в сети</small></span></div>
          <label className="search"><span>⌕</span><input readOnly value="" placeholder="Поиск" /></label>
          <div className="contact-list-heading"><span className="section-label">Чаты</span></div>
          <div className="chat-items"><button className="chat-item selected"><span className="avatar blue">К</span><span className="chat-copy"><strong className="chat-name">Контакт</strong><small>Первое сообщение сохранено</small></span><time className="chat-time">12:00</time></button></div>
        </aside>
      </>}
      <section className="conversation pq-fixture-conversation">
        <header className="conversation-header">
          <span className="avatar blue">К</span>
          <span className="header-copy"><strong>Контакт</strong><small>защищённый чат E2EE</small></span>
        </header>
        <div className="message-scroll" ref={scrollRef}>
          {Array.from({ length: 14 }, (_, index) => <article className={index % 3 === 0 ? "message mine" : "message"} data-message-key={`history-${index}`} key={index}><p><span className="message-text">Сообщение истории {index + 1}</span><time>11:{String(40 + index).padStart(2, "0")}</time></p></article>)}
          <article className="message mine" data-message-key="pending-first"><p><span className="message-text">Первое сообщение сохранено и ожидает подготовки PQ-ключа.</span><time>12:00</time></p></article>
        </div>
        <div className="chat-composer-section">
          {!baseline && mounted && (capability || cancelled ? <PqCapabilityWait friendNumber={7} reason={cancelled ? "cancelled" : "checking"} onSkip={async () => {
            window.__PQ_ENTROPY_RUNTIME__ = { calls: 1, noise: [] };
          }} /> : <PqEntropy friendNumber={7} onBegin={async () => {
            const calls = (window.__PQ_ENTROPY_BEGIN__?.calls ?? 0) + 1;
            window.__PQ_ENTROPY_BEGIN__ = { calls };
            if (mode === "denied") return 0;
            if (mode === "expired") return 3_000;
            if (mode === "begin-error" && calls === 1) throw new Error("Synthetic lease failure");
            if (mode === "delayed") await new Promise((resolve) => window.setTimeout(resolve, 1_200));
            window.__PQ_ENTROPY_BEGIN__ = { calls, grantedAt: performance.now() };
            return 8_000;
          }} onComplete={async (_friendNumber, noise) => {
            const previous = window.__PQ_ENTROPY_RUNTIME__ ?? { calls: 0, noise: [] };
            window.__PQ_ENTROPY_RUNTIME__ = { calls: previous.calls + 1, noise: [...noise], completedAt: performance.now() };
          }} />)}
          <div className="composer"><div className="compose-row"><button className="attach" aria-label="Прикрепить файл">+</button><textarea aria-label="Сообщение" placeholder="Сообщение…" /><button className="send">➤</button></div></div>
        </div>
      </section>
    </main>
  </I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
