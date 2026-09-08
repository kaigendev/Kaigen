import { useEffect, useRef, useState, type ReactNode } from "react";
import { useI18n } from "./i18n";
import {
  CHAT_REACTION_CODES,
  formattedTextSegments,
  type ChatFormattingKind,
  type ChatFormattingSpan,
  type ChatMessageReactions,
  type ChatQuote,
  type ChatReactionCode,
} from "./chatRichText";
import "./ChatEnhancements.css";

export const REACTION_EMOJI: Readonly<Record<ChatReactionCode, string>> = Object.freeze({
  thumbs_up: "👍",
  thumbs_down: "👎",
  grin: "😀",
  sad: "😢",
  heart: "❤️",
  rocket: "🚀",
});

function wrapFormattedText(node: ReactNode, kind: ChatFormattingKind, key: string) {
  switch (kind) {
    case "bold": return <strong key={key}>{node}</strong>;
    case "underline": return <u key={key}>{node}</u>;
    case "italic": return <em key={key}>{node}</em>;
    case "strikethrough": return <s key={key}>{node}</s>;
  }
}

export function FormattedMessageText({
  text,
  formatting,
  enabled = true,
  className = "",
}: {
  text: string;
  formatting?: readonly Partial<ChatFormattingSpan>[] | null;
  enabled?: boolean;
  className?: string;
}) {
  const segments = formattedTextSegments(text, enabled ? formatting : []);
  return <span className={`formatted-message-text ${className}`.trim()} data-i18n-ignore translate="no">
    {segments.map((segment) => {
      let node: ReactNode = segment.text;
      for (const kind of segment.kinds) node = wrapFormattedText(node, kind, `${segment.offsetUtf16}-${kind}`);
      return <span key={segment.offsetUtf16}>{node}</span>;
    })}
  </span>;
}

export function MessageQuotePreview({
  quote,
  onActivate,
  compact = false,
  className = "",
}: {
  quote: ChatQuote;
  onActivate?: (messageId: string) => void;
  compact?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  const actionable = !!quote.messageId && !!onActivate;
  const author = quote.author.trim();
  const content = <>
    <span className="message-quote-rule" aria-hidden="true" />
    <span className="message-quote-copy">
      <b data-i18n-ignore={author ? true : undefined} translate={author ? "no" : undefined}>
        {author || t("Цитата")}
      </b>
      <span data-i18n-ignore translate="no">{quote.text}</span>
    </span>
  </>;
  const classes = `message-quote-preview ${compact ? "compact" : ""} ${actionable ? "actionable" : ""} ${className}`.trim();
  return actionable
    ? <button type="button" className={classes} onClick={() => onActivate?.(quote.messageId!)} aria-label={t("Перейти к цитируемому сообщению")}>{content}</button>
    : <div className={classes}>{content}</div>;
}

export function ComposerReplyPreview({
  quote,
  onCancel,
}: {
  quote: ChatQuote;
  onCancel?: () => void;
}) {
  const { t } = useI18n();
  return <div className={`composer-reply-preview ${onCancel ? "" : "without-dismiss"}`.trim()}>
    <MessageQuotePreview quote={quote} compact />
    {onCancel && <button type="button" onClick={onCancel} title={t("Отменить цитирование")} aria-label={t("Отменить цитирование")}>×</button>}
  </div>;
}

function sanitizeReactions(values: readonly ChatReactionCode[] | undefined) {
  return [...new Set(values?.filter((value) => CHAT_REACTION_CODES.includes(value)) ?? [])];
}

function reactionLabel(code: ChatReactionCode, translate: (source: string) => string) {
  switch (code) {
    case "thumbs_up": return translate("Нравится");
    case "thumbs_down": return translate("Не нравится");
    case "grin": return translate("Радость");
    case "sad": return translate("Грусть");
    case "heart": return translate("Сердце");
    case "rocket": return translate("Ракета");
  }
}

export function ReactionBar({
  reactions,
  eligible,
  disabledReason,
  statusMessage,
  onToggle,
}: {
  reactions?: ChatMessageReactions | null;
  eligible: boolean;
  disabledReason?: string;
  statusMessage?: string;
  onToggle: (reaction: ChatReactionCode) => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pendingToggle, setPendingToggle] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const mine = sanitizeReactions(reactions?.mine);
  const peer = sanitizeReactions(reactions?.peer);
  const visible = CHAT_REACTION_CODES.filter((code) => mine.includes(code) || peer.includes(code));
  const maximumReached = mine.length >= 3;

  useEffect(() => {
    if (!paletteOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setPaletteOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPaletteOpen(false);
    };
    const closeOnScroll = () => setPaletteOpen(false);
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [paletteOpen]);

  if (!eligible && visible.length === 0) return null;
  const toggle = (code: ChatReactionCode) => {
    if (!eligible || pendingToggle) return;
    const result = onToggle(code);
    if (result && typeof result.then === "function") {
      setPendingToggle(true);
      void result.catch(() => {}).finally(() => setPendingToggle(false));
    }
    setPaletteOpen(false);
  };

  return <div ref={rootRef} className="message-reaction-bar" onClick={(event) => event.stopPropagation()}>
    {visible.map((code) => {
      const mineHas = mine.includes(code);
      const count = Number(mineHas) + Number(peer.includes(code));
      return <button
        type="button"
        className={mineHas ? "mine" : ""}
        key={code}
        disabled={!eligible || pendingToggle}
        title={eligible ? reactionLabel(code, t) : disabledReason ?? t("Реакцию на это сообщение уже нельзя изменить")}
        aria-label={`${reactionLabel(code, t)}: ${count}`}
        aria-pressed={mineHas}
        onClick={() => toggle(code)}
      ><span aria-hidden="true">{REACTION_EMOJI[code]}</span>{count > 1 && <small>{count}</small>}</button>;
    })}
    {eligible && <button
      type="button"
      className="reaction-add"
      aria-label={t("Добавить реакцию")}
      title={t("Добавить реакцию")}
      aria-expanded={paletteOpen}
      onClick={() => setPaletteOpen((open) => !open)}
    >＋</button>}
    {(pendingToggle || reactions?.delivery === "pending") && <i className="reaction-delivery pending" role="status" aria-label={t("Реакция отправляется")} />}
    {reactions?.delivery === "rejected" && <i className="reaction-delivery rejected" role="status" aria-label={t("Реакция не доставлена")}>!</i>}
    {paletteOpen && <div className="reaction-palette" role="menu" aria-label={t("Выберите реакцию")}>
      {CHAT_REACTION_CODES.map((code) => {
        const active = mine.includes(code);
        return <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={active}
          key={code}
          disabled={pendingToggle || (!active && maximumReached)}
          title={!active && maximumReached ? t("Можно выбрать не более трёх реакций") : reactionLabel(code, t)}
          onClick={() => toggle(code)}
        ><span aria-hidden="true">{REACTION_EMOJI[code]}</span><span className="sr-only">{reactionLabel(code, t)}</span></button>;
      })}
    </div>}
    {statusMessage && <small className="reaction-status" role="status" aria-live="polite">{statusMessage}</small>}
  </div>;
}

export function OffscreenReactionNotice({
  reaction,
  removed = false,
  onNavigate,
}: {
  reaction: ChatReactionCode;
  removed?: boolean;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  return <button type="button" className="offscreen-reaction-notice" onClick={onNavigate}>
    <span aria-hidden="true">{REACTION_EMOJI[reaction]}</span>
    <span>{t(removed ? "Собеседник убрал реакцию" : "Получена реакция вне видимой области")}</span>
    <b>{t("Показать сообщение")}</b>
  </button>;
}
