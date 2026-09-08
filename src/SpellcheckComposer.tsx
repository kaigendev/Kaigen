import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ComposerReplyPreview } from "./ChatMessageEnhancements";
import {
  CHAT_FORMAT_KINDS,
  normalizeFormattingSpans,
  prepareFormattedSubmission,
  rebaseFormattingAfterTextEdit,
  selectionHasFormatting,
  shouldSubmitComposerKey,
  toggleFormattingForSelection,
  type ChatFormattingSpan,
  type ChatQuote,
} from "./chatRichText";
import { KAIGEN_PASTE_FILES_EVENT } from "./textEditCommands";
import { registerTextEditFormatting } from "./textEditFormatting";
import { useI18n } from "./i18n";
import spellcheckWorkerUrl from "./spellcheck.worker.ts?worker&url";

type TokenStatus = "pending" | "correct" | "misspelled";

type SpellToken = {
  id: number;
  start: number;
  end: number;
  text: string;
  status: TokenStatus;
};

type SpellMenu = {
  target: Pick<SpellToken, "id" | "start" | "end">;
  x: number;
  y: number;
  suggestions: string[] | null;
};

type WorkerResponse =
  | { type: "ready"; configId: number }
  | { type: "error"; configId: number; message: string }
  | { type: "checked"; configId: number; revision: number; results: Array<{ id: number; start: number; end: number; text: string; correct: boolean }> }
  | { type: "suggestions"; configId: number; requestId: number; tokenId: number; suggestions: string[] };

export type MessageComposerProps = {
  chatId: string;
  initialValue: string;
  initialFormatting?: readonly ChatFormattingSpan[];
  formattingEnabled?: boolean;
  reply?: ChatQuote | null;
  sendOnEnter: boolean;
  spellcheckEnabled: boolean;
  spellcheckRussian: boolean;
  spellcheckEnglish: boolean;
  onDraftChange: (chatId: string, value: string) => void;
  onDraftFormattingChange?: (chatId: string, formatting: readonly ChatFormattingSpan[]) => void;
  onCancelReply?: () => void;
  onSend: (text: string, formatting?: readonly ChatFormattingSpan[], reply?: ChatQuote | null) => Promise<boolean>;
  onStageFiles: (files: Iterable<File>) => void;
  onPasteFiles?: (files: Iterable<File>) => void;
  onPickFile?: () => void;
  fileActionsEnabled: boolean;
};

let nextConfigId = 0;
let sharedWorker: Worker | null = null;
const workerListeners = new Set<(message: WorkerResponse) => void>();

type KaigenTrustedTypePolicy = {
  createScriptURL: (value: string) => unknown;
};

type KaigenTrustedTypePolicyFactory = {
  createPolicy: (name: string, rules: { createScriptURL: (value: string) => string }) => KaigenTrustedTypePolicy;
};

let spellcheckWorkerPolicy: KaigenTrustedTypePolicy | null = null;

function spellcheckWorkerScriptUrl() {
  const trustedTypes = (globalThis as typeof globalThis & { trustedTypes?: KaigenTrustedTypePolicyFactory }).trustedTypes;
  if (!trustedTypes) return spellcheckWorkerUrl;
  const exactWorkerUrl = new URL(spellcheckWorkerUrl, location.href).href;
  spellcheckWorkerPolicy ??= trustedTypes.createPolicy("kaigen-spellcheck-worker", {
    createScriptURL: (value) => {
      if (new URL(value, location.href).href !== exactWorkerUrl) throw new TypeError("Unexpected spellcheck worker URL");
      return exactWorkerUrl;
    },
  });
  return spellcheckWorkerPolicy.createScriptURL(exactWorkerUrl) as string;
}

function spellcheckWorker(): Worker | null {
  if (sharedWorker) return sharedWorker;
  try {
    sharedWorker = new Worker(spellcheckWorkerScriptUrl(), { type: "module" });
    sharedWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      workerListeners.forEach((listener) => listener(event.data));
    };
    return sharedWorker;
  } catch {
    // Spellcheck is optional. A browser that rejects worker creation must not
    // unmount the messenger or end the authenticated workspace session.
    sharedWorker = null;
    return null;
  }
}

export function clearSpellcheckMemory() {
  sharedWorker?.terminate();
  sharedWorker = null;
}

function pastedFiles(data: DataTransfer | null) {
  if (!data) return [];
  const files = Array.from(data.items)
    .filter((item) => item.kind === "file")
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  return files.length ? files : Array.from(data.files);
}

function MessageComposer({
  chatId,
  initialValue,
  initialFormatting = [],
  formattingEnabled = false,
  reply = null,
  sendOnEnter,
  spellcheckEnabled,
  spellcheckRussian,
  spellcheckEnglish,
  onDraftChange,
  onDraftFormattingChange,
  onCancelReply,
  onSend,
  onStageFiles,
  onPasteFiles,
  onPickFile,
  fileActionsEnabled,
}: MessageComposerProps) {
  const { t } = useI18n();
  const [value, setValue] = useState(initialValue);
  const [formatting, setFormatting] = useState<ChatFormattingSpan[]>(() => normalizeFormattingSpans(initialValue, initialFormatting));
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
  const formattingRef = useRef(formatting);
  const composingRef = useRef(false);
  const sendingRef = useRef(false);
  const sendGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const activeChatRef = useRef(chatId);
  const initialValueRef = useRef(initialValue);
  const initialFormattingRef = useRef(initialFormatting);
  const draftFormattingChangeRef = useRef(onDraftFormattingChange);
  const valueRef = useRef(value);
  initialValueRef.current = initialValue;
  initialFormattingRef.current = initialFormatting;
  draftFormattingChangeRef.current = onDraftFormattingChange;
  valueRef.current = value;
  formattingRef.current = formatting;
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
    const nextFormatting = normalizeFormattingSpans(nextValue, initialFormattingRef.current);
    valueRef.current = nextValue;
    formattingRef.current = nextFormatting;
    setValue(nextValue);
    setFormatting(nextFormatting);
    sendGenerationRef.current += 1;
    sendingRef.current = false;
    setSending(false);
    textRevisionRef.current += 1;
    setCheckedText({ value: "", tokens: [] });
    setMenu(null);
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      resize(textareaRef.current);
      textareaRef.current.focus({ preventScroll: true });
    });
  }, [chatId, resize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sendGenerationRef.current += 1;
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
    };
  }, []);

  useEffect(() => {
    if (formattingEnabled || formattingRef.current.length === 0) return;
    formattingRef.current = [];
    setFormatting([]);
    onDraftFormattingChange?.(activeChatRef.current, []);
  }, [formattingEnabled, onDraftFormattingChange]);

  useLayoutEffect(() => {
    const target = textareaRef.current;
    if (!target || !formattingEnabled) return;
    return registerTextEditFormatting(target, (selection) => {
      const revision = textRevisionRef.current;
      const isCurrent = () => target.isConnected
        && activeChatRef.current === chatId
        && textRevisionRef.current === revision
        && target.value === selection.value
        && valueRef.current === selection.value;
      if (!isCurrent() || selection.start >= selection.end) return null;
      return {
        activeKinds: CHAT_FORMAT_KINDS.filter((kind) => selectionHasFormatting(
          selection.value, selection.start, selection.end, kind, formattingRef.current,
        )),
        isCurrent,
        apply: (kind) => {
          if (!isCurrent()) return false;
          const next = toggleFormattingForSelection(
            selection.value, selection.start, selection.end, kind, formattingRef.current,
          );
          formattingRef.current = next;
          setFormatting(next);
          draftFormattingChangeRef.current?.(chatId, next);
          return true;
        },
      };
    });
  }, [chatId, formattingEnabled]);

  useEffect(() => {
    const target = textareaRef.current;
    if (!target) return;
    const handleCustomPaste = (event: Event) => {
      if (!fileActionsEnabled) return;
      const detail = (event as CustomEvent<{ files?: unknown }>).detail;
      if (!Array.isArray(detail?.files)) return;
      const files = detail.files.filter((item): item is File => item instanceof File);
      if (!files.length) return;
      setMenu(null);
      (onPasteFiles ?? onStageFiles)(files);
    };
    target.addEventListener(KAIGEN_PASTE_FILES_EVENT, handleCustomPaste);
    return () => target.removeEventListener(KAIGEN_PASTE_FILES_EVENT, handleCustomPaste);
  }, [fileActionsEnabled, onPasteFiles, onStageFiles]);

  useEffect(() => {
    if (!menu) return;
    const closeOutside = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      setMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const closeOnScroll = () => setMenu(null);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [menu]);

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
    if (event.currentTarget.selectionStart !== event.currentTarget.selectionEnd) {
      setMenu(null);
      return;
    }
    const token = misspelledTokenAtPoint(event.clientX, event.clientY);
    if (!token) {
      setMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setMenu({
      target: { id: token.id, start: token.start, end: token.end },
      x: event.clientX,
      y: event.clientY,
      suggestions: null,
    });
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
    const nextFormatting = formattingEnabled
      ? rebaseFormattingAfterTextEdit(valueRef.current, next, formattingRef.current)
      : [];
    textRevisionRef.current += 1;
    valueRef.current = next;
    formattingRef.current = nextFormatting;
    setValue(next);
    setFormatting(nextFormatting);
    setMenu(null);
    onDraftChange(activeChatRef.current, next);
    onDraftFormattingChange?.(activeChatRef.current, nextFormatting);
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

  const submit = async () => {
    const submission = prepareFormattedSubmission(
      valueRef.current,
      formattingEnabled ? formattingRef.current : [],
    );
    if (!submission.text || sendingRef.current) return;
    const targetChat = activeChatRef.current;
    const targetReply = reply;
    const generation = ++sendGenerationRef.current;
    sendingRef.current = true;
    setSending(true);
    textRevisionRef.current += 1;
    valueRef.current = "";
    formattingRef.current = [];
    setValue("");
    setFormatting([]);
    setCheckedText({ value: "", tokens: [] });
    setMenu(null);
    onDraftChange(targetChat, "");
    onDraftFormattingChange?.(targetChat, []);
    if (targetReply) onCancelReply?.();
    requestAnimationFrame(() => {
      if (textareaRef.current) scheduleResize(textareaRef.current);
    });
    try {
      await onSend(submission.text, submission.formatting, targetReply);
    } catch {
      // The submission is already an immutable send operation owned by the
      // caller. A failed operation must never be restored over a newer draft.
    } finally {
      if (!mountedRef.current || generation !== sendGenerationRef.current) return;
      sendingRef.current = false;
      setSending(false);
    }
  };

  return <footer className="composer" onClick={() => setMenu(null)}>
    {reply && <ComposerReplyPreview quote={reply} onCancel={onCancelReply} />}
    <div className="compose-row">
      <button className="attach" disabled={!fileActionsEnabled} onClick={() => onPickFile ? onPickFile() : fileInputRef.current?.click()} title={t("Прикрепить файл")} aria-label={t("Прикрепить файл")}><span className="paperclip-icon" aria-hidden="true" /></button>
      <input ref={fileInputRef} className="file-picker" type="file" multiple disabled={!fileActionsEnabled} onChange={(event) => { if (event.target.files) onStageFiles(event.target.files); event.currentTarget.value = ""; }} />
      <div className="spellcheck-editor">
        <div ref={overlayRef} className="spellcheck-overlay" aria-hidden="true">{decoratedValue}</div>
        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          spellCheck={false}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
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
            if (!fileActionsEnabled) return;
            const files = pastedFiles(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            event.stopPropagation();
            setMenu(null);
            (onPasteFiles ?? onStageFiles)(files);
          }}
          onContextMenu={openContextMenu}
          onKeyDown={(event) => {
            const sendWithCurrentKey = shouldSubmitComposerKey({
              key: event.key,
              shiftKey: event.shiftKey,
              isComposing: composingRef.current || event.nativeEvent.isComposing,
              keyCode: event.keyCode,
            }, sendOnEnter);
            if (sendWithCurrentKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t("Сообщение…")}
        />
      </div>
      <button className="send" onClick={() => void submit()} disabled={sending} title={t("Отправить")} aria-label={t("Отправить")}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 3 3.9 9.7c-1.15.46-1.1 1.12-.2 1.39l4.39 1.37 1.69 5.2c.2.55.1.77.68.77.45 0 .65-.2.9-.45l2.14-2.08 4.46 3.3c.82.45 1.41.22 1.61-.77L22.48 4.5C22.77 3.2 21.98 2.61 21 3Zm-11.6 9.02 9.18-5.79c.46-.28.88-.13.53.18l-7.85 7.1-.31 3.33-1.55-4.82Z" /></svg></button>
    </div>
    {menu && createPortal(<div ref={menuRef} className="spellcheck-context-menu" style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.preventDefault()} onClick={(event) => event.stopPropagation()}>
      {menu.suggestions === null ? <span>{t("Подбираю варианты…")}</span> : menu.suggestions.length ? menu.suggestions.map((suggestion) => <button key={suggestion} onClick={() => replaceMisspelling(suggestion)}>{suggestion}</button>) : <span>{t("Вариантов замены нет")}</span>}
    </div>, document.body)}
  </footer>;
}

export default memo(MessageComposer, (previous, next) => (
  previous.chatId === next.chatId
  && previous.sendOnEnter === next.sendOnEnter
  && previous.formattingEnabled === next.formattingEnabled
  && previous.spellcheckEnabled === next.spellcheckEnabled
  && previous.spellcheckRussian === next.spellcheckRussian
  && previous.spellcheckEnglish === next.spellcheckEnglish
  && previous.onDraftChange === next.onDraftChange
  && previous.onDraftFormattingChange === next.onDraftFormattingChange
  && previous.onCancelReply === next.onCancelReply
  && previous.onSend === next.onSend
  && previous.onStageFiles === next.onStageFiles
  && previous.onPasteFiles === next.onPasteFiles
  && previous.onPickFile === next.onPickFile
  && previous.fileActionsEnabled === next.fileActionsEnabled
  && previous.reply?.messageId === next.reply?.messageId
  && previous.reply?.author === next.reply?.author
  && previous.reply?.text === next.reply?.text
  && previous.reply?.legacy === next.reply?.legacy
));
