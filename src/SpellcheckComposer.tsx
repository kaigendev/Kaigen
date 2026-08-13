import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type TokenStatus = "pending" | "correct" | "misspelled";

type SpellToken = {
  id: number;
  start: number;
  end: number;
  text: string;
  status: TokenStatus;
};

type SpellMenu = {
  target: Pick<SpellToken, "id" | "start" | "end"> | null;
  x: number;
  y: number;
  suggestions: string[] | null;
};

type WorkerResponse =
  | { type: "ready"; configId: number }
  | { type: "error"; configId: number; message: string }
  | { type: "checked"; configId: number; revision: number; results: Array<{ id: number; start: number; end: number; text: string; correct: boolean }> }
  | { type: "suggestions"; configId: number; requestId: number; tokenId: number; suggestions: string[] };

type Props = {
  chatId: string;
  initialValue: string;
  sendOnEnter: boolean;
  spellcheckEnabled: boolean;
  spellcheckRussian: boolean;
  spellcheckEnglish: boolean;
  onDraftChange: (chatId: string, value: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onStageFile: (file: File | undefined) => void;
};

let nextConfigId = 0;
let sharedWorker: Worker | null = null;
const workerListeners = new Set<(message: WorkerResponse) => void>();

function spellcheckWorker(): Worker {
  if (sharedWorker) return sharedWorker;
  sharedWorker = new Worker(new URL("./spellcheck.worker.ts", import.meta.url), { type: "module" });
  sharedWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    workerListeners.forEach((listener) => listener(event.data));
  };
  return sharedWorker;
}

export function clearSpellcheckMemory() {
  sharedWorker?.terminate();
  sharedWorker = null;
}

function pastedFile(data: DataTransfer | null) {
  if (!data) return undefined;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return data.files[0];
}

function clipboardFilename(mime: string) {
  const extension = mime === "image/png" ? "png"
    : mime === "image/jpeg" ? "jpg"
      : mime === "image/webp" ? "webp"
        : mime === "image/gif" ? "gif"
          : "bin";
  return `clipboard-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

async function readClipboardFile() {
  const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItem[]> };
  if (!clipboard?.read) return undefined;
  const items = await clipboard.read();
  for (const item of items) {
    const type = item.types.find((candidate) => !candidate.startsWith("text/"));
    if (!type) continue;
    const blob = await item.getType(type);
    return new File([blob], clipboardFilename(type), { type });
  }
  return undefined;
}

function MessageComposer({
  chatId,
  initialValue,
  sendOnEnter,
  spellcheckEnabled,
  spellcheckRussian,
  spellcheckEnglish,
  onDraftChange,
  onSend,
  onStageFile,
}: Props) {
  const [value, setValue] = useState(initialValue);
  const [checkedText, setCheckedText] = useState<{ value: string; tokens: SpellToken[] }>({ value: "", tokens: [] });
  const [workerReady, setWorkerReady] = useState(false);
  const [menu, setMenu] = useState<SpellMenu | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const configIdRef = useRef(0);
  const suggestionRequestRef = useRef(0);
  const textRevisionRef = useRef(0);
  const resizeFrameRef = useRef<number | null>(null);
  const activeChatRef = useRef(chatId);
  const initialValueRef = useRef(initialValue);
  const valueRef = useRef(value);
  initialValueRef.current = initialValue;
  valueRef.current = value;
  const dictionariesEnabled = spellcheckEnabled && (spellcheckRussian || spellcheckEnglish);

  const resize = useCallback((target: HTMLTextAreaElement) => {
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 154)}px`;
    if (overlayRef.current) overlayRef.current.style.height = target.style.height;
  }, []);

  const scheduleResize = useCallback((target: HTMLTextAreaElement) => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    resizeFrameRef.current = window.requestAnimationFrame(() => {
      resizeFrameRef.current = null;
      resize(target);
    });
  }, [resize]);

  useEffect(() => {
    activeChatRef.current = chatId;
    const nextValue = initialValueRef.current;
    valueRef.current = nextValue;
    setValue(nextValue);
    textRevisionRef.current += 1;
    setCheckedText({ value: "", tokens: [] });
    setMenu(null);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      resize(textareaRef.current);
      textareaRef.current.focus({ preventScroll: true });
    });
  }, [chatId, resize]);

  useEffect(() => () => {
    if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
  }, []);

  useEffect(() => {
    const handleMessage = (message: WorkerResponse) => {
      if (message.configId !== configIdRef.current) return;
      if (message.type === "ready") {
        setWorkerReady(true);
        return;
      }
      if (message.type === "error") {
        setWorkerReady(false);
        return;
      }
      if (message.type === "checked") {
        if (message.revision !== textRevisionRef.current) return;
        setCheckedText({
          value: valueRef.current,
          tokens: message.results.map((result) => ({ ...result, status: result.correct ? "correct" : "misspelled" })),
        });
        return;
      }
      if (message.requestId !== suggestionRequestRef.current) return;
      setMenu((current) => current?.target?.id === message.tokenId ? { ...current, suggestions: message.suggestions } : current);
    };
    workerListeners.add(handleMessage);
    return () => {
      workerListeners.delete(handleMessage);
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!dictionariesEnabled) {
      workerRef.current = null;
      setWorkerReady(false);
      return;
    }
    workerRef.current = spellcheckWorker();
  }, [dictionariesEnabled]);

  useEffect(() => {
    const configId = ++nextConfigId;
    configIdRef.current = configId;
    setWorkerReady(false);
    setMenu(null);
    setCheckedText({ value: "", tokens: [] });
    workerRef.current?.postMessage({
      type: "configure",
      configId,
      russian: spellcheckEnabled && spellcheckRussian,
      english: spellcheckEnabled && spellcheckEnglish,
    });
  }, [dictionariesEnabled, spellcheckEnabled, spellcheckEnglish, spellcheckRussian]);

  useEffect(() => {
    if (!spellcheckEnabled || !workerReady || !value) return;
    const revision = textRevisionRef.current;
    const timer = window.setTimeout(() => {
      workerRef.current?.postMessage({
        type: "check",
        configId: configIdRef.current,
        revision,
        text: value,
      });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [spellcheckEnabled, value, workerReady]);

  const tokens = checkedText.value === value ? checkedText.tokens : [];

  const decoratedValue = useMemo(() => {
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const token of tokens) {
      if (token.status !== "misspelled") continue;
      if (token.start > cursor) parts.push(value.slice(cursor, token.start));
      parts.push(
        <span
          className="spellcheck-error"
          data-token-id={token.id}
          key={token.id}
        >{token.text}</span>,
      );
      cursor = token.end;
    }
    if (cursor < value.length) parts.push(value.slice(cursor));
    if (value.endsWith("\n")) parts.push("\u200b");
    return parts;
  }, [tokens, value]);

  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    const margin = 8;
    const x = Math.max(margin, Math.min(menu.x, window.innerWidth - element.offsetWidth - margin));
    const y = Math.max(margin, Math.min(menu.y, window.innerHeight - element.offsetHeight - margin));
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
  }, [menu]);

  const misspelledTokenAtPoint = (x: number, y: number) => {
    const elements = overlayRef.current?.querySelectorAll<HTMLElement>(".spellcheck-error") ?? [];
    for (const element of elements) {
      const intersects = Array.from(element.getClientRects()).some((rect) => (
        x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      ));
      if (!intersects) continue;
      const id = Number(element.dataset.tokenId);
      return tokens.find((token) => token.id === id && token.status === "misspelled") ?? null;
    }
    return null;
  };

  const openContextMenu = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const token = misspelledTokenAtPoint(event.clientX, event.clientY);
    setMenu({
      target: token ? { id: token.id, start: token.start, end: token.end } : null,
      x: event.clientX,
      y: event.clientY,
      suggestions: token ? null : [],
    });
    if (!token) return;
    const requestId = ++suggestionRequestRef.current;
    workerRef.current?.postMessage({
      type: "suggest",
      configId: configIdRef.current,
      requestId,
      tokenId: token.id,
      word: token.text,
    });
  };

  const updateValue = (next: string) => {
    textRevisionRef.current += 1;
    valueRef.current = next;
    setValue(next);
    setMenu(null);
    onDraftChange(activeChatRef.current, next);
  };

  const replaceMisspelling = (replacement: string) => {
    if (!menu?.target) return;
    const next = value.slice(0, menu.target.start) + replacement + value.slice(menu.target.end);
    const caret = menu.target.start + replacement.length;
    updateValue(next);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(caret, caret);
      if (textareaRef.current) scheduleResize(textareaRef.current);
    });
  };

  const editAction = (action: "copy" | "paste" | "cut") => {
    textareaRef.current?.focus();
    if (action === "paste") {
      void readClipboardFile().catch(() => undefined).then(async (file) => {
        if (file) {
          onStageFile(file);
          return;
        }
        const text = await navigator.clipboard.readText();
        const target = textareaRef.current;
        if (!target) return;
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? start;
        const next = value.slice(0, start) + text + value.slice(end);
        updateValue(next);
        requestAnimationFrame(() => target.setSelectionRange(start + text.length, start + text.length));
      }).catch(() => {});
    } else {
      document.execCommand(action);
    }
    setMenu(null);
  };

  const submit = async () => {
    const text = value.trim();
    if (!text || sending) return;
    setSending(true);
    const sent = await onSend(text);
    setSending(false);
    if (!sent) return;
    textRevisionRef.current += 1;
    valueRef.current = "";
    setValue("");
    setCheckedText({ value: "", tokens: [] });
    setMenu(null);
    onDraftChange(activeChatRef.current, "");
    requestAnimationFrame(() => {
      if (textareaRef.current) scheduleResize(textareaRef.current);
    });
  };

  return <footer className="composer" onClick={() => setMenu(null)}>
    <div className="compose-row">
      <button className="attach" onClick={() => fileInputRef.current?.click()} title="Прикрепить файл" aria-label="Прикрепить файл"><span className="paperclip-icon" aria-hidden="true" /></button>
      <input ref={fileInputRef} className="file-picker" type="file" onChange={(event) => { onStageFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
      <div className="spellcheck-editor">
        <div ref={overlayRef} className="spellcheck-overlay" aria-hidden="true">{decoratedValue}</div>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          spellCheck={false}
          onChange={(event) => {
            const next = event.target.value;
            updateValue(next);
            scheduleResize(event.target);
          }}
          onScroll={(event) => {
            if (overlayRef.current) {
              overlayRef.current.scrollTop = event.currentTarget.scrollTop;
              overlayRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
          onPaste={(event) => {
            const file = pastedFile(event.clipboardData);
            if (!file) return;
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            onStageFile(file);
          }}
          onContextMenu={openContextMenu}
          onKeyDown={(event) => {
            const sendWithCurrentKey = event.key === "Enter" && (sendOnEnter ? !event.shiftKey : event.shiftKey);
            if (sendWithCurrentKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="Сообщение…"
        />
      </div>
      <button className="send" onClick={() => void submit()} disabled={sending} title="Отправить" aria-label="Отправить"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 3.9 9.7c-1.15.46-1.1 1.12-.2 1.39l4.39 1.37 1.69 5.2c.2.55.1.77.68.77.45 0 .65-.2.9-.45l2.14-2.08 4.46 3.3c.82.45 1.41.22 1.61-.77L22.48 4.5C22.77 3.2 21.98 2.61 21 3Zm-11.6 9.02 9.18-5.79c.46-.28.88-.13.53.18l-7.85 7.1-.31 3.33-1.55-4.82Z" /></svg></button>
    </div>
    {menu && createPortal(<div ref={menuRef} className="spellcheck-context-menu" style={{ left: menu.x, top: menu.y }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.preventDefault()} onClick={(event) => event.stopPropagation()}>
      <button onClick={() => editAction("copy")}>Копировать</button>
      <button onClick={() => editAction("cut")}>Вырезать</button>
      <button onClick={() => editAction("paste")}>Вставить</button>
      {menu.target && <>
        <hr />
        {menu.suggestions === null ? <span>Подбираю варианты…</span> : menu.suggestions.length ? menu.suggestions.map((suggestion) => <button key={suggestion} onClick={() => replaceMisspelling(suggestion)}>{suggestion}</button>) : <span>Вариантов замены нет</span>}
      </>}
    </div>, document.body)}
  </footer>;
}

export default memo(MessageComposer, (previous, next) => (
  previous.chatId === next.chatId
  && previous.sendOnEnter === next.sendOnEnter
  && previous.spellcheckEnabled === next.spellcheckEnabled
  && previous.spellcheckRussian === next.spellcheckRussian
  && previous.spellcheckEnglish === next.spellcheckEnglish
  && previous.onDraftChange === next.onDraftChange
  && previous.onSend === next.onSend
  && previous.onStageFile === next.onStageFile
));
