import { useLayoutEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../../src/i18n";
import PqEntropy, { PqCapabilityWait } from "../../../src/PqEntropy";
import "../../../src/theme.css";
import "../../../src/App.css";
import "./runtime.css";

declare global {
  interface Window {
    __PQ_ENTROPY_RUNTIME__?: { calls: number; noise: number[] };
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
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
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
          {!baseline && (capability || cancelled ? <PqCapabilityWait friendNumber={7} reason={cancelled ? "cancelled" : "checking"} onSkip={async () => {
            window.__PQ_ENTROPY_RUNTIME__ = { calls: 1, noise: [] };
          }} /> : <PqEntropy friendNumber={7} onComplete={async (_friendNumber, noise) => {
            const previous = window.__PQ_ENTROPY_RUNTIME__ ?? { calls: 0, noise: [] };
            window.__PQ_ENTROPY_RUNTIME__ = { calls: previous.calls + 1, noise: [...noise] };
          }} />)}
          <div className="composer"><div className="compose-row"><button className="attach" aria-label="Прикрепить файл">+</button><textarea aria-label="Сообщение" placeholder="Сообщение…" /><button className="send">➤</button></div></div>
        </div>
      </section>
    </main>
  </I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
