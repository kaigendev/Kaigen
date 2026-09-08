import { useState, type ReactNode } from "react";
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
  statusMessage,
}: {
  reactions?: ChatMessageReactions | null;
  statusMessage?: string;
}) {
  const { t } = useI18n();
  const mine = sanitizeReactions(reactions?.mine);
  const peer = sanitizeReactions(reactions?.peer);
  const visible = CHAT_REACTION_CODES.filter((code) => mine.includes(code) || peer.includes(code));
  const deliveryPending = reactions?.delivery === "pending";
  const deliveryRejected = reactions?.delivery === "rejected";

  if (visible.length === 0 && !deliveryPending && !deliveryRejected && !statusMessage) return null;

  return <div className="message-reaction-bar">
    {visible.map((code) => {
      const mineHas = mine.includes(code);
      const count = Number(mineHas) + Number(peer.includes(code));
      return <span
        className={`reaction-chip ${mineHas ? "mine" : ""}`.trim()}
        key={code}
        title={reactionLabel(code, t)}
        aria-label={`${reactionLabel(code, t)}: ${count}`}
      ><span aria-hidden="true">{REACTION_EMOJI[code]}</span>{count > 1 && <small>{count}</small>}</span>;
    })}
    {deliveryPending && <i className="reaction-delivery pending" role="status" aria-label={t("Реакция отправляется")} />}
    {deliveryRejected && <i className="reaction-delivery rejected" role="status" aria-label={t("Реакция не доставлена")}>!</i>}
    {statusMessage && <small className="reaction-status" role="status" aria-live="polite">{statusMessage}</small>}
  </div>;
}

export function ReactionPicker({
  reactions,
  onToggle,
  disabled = false,
}: {
  reactions?: ChatMessageReactions | null;
  onToggle: (reaction: ChatReactionCode) => void | Promise<void>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const [pendingToggle, setPendingToggle] = useState(false);
  const mine = sanitizeReactions(reactions?.mine);
  const maximumReached = mine.length >= 3;
  const busy = disabled || pendingToggle || reactions?.delivery === "pending";

  const toggle = (code: ChatReactionCode) => {
    const active = mine.includes(code);
    if (busy || (!active && maximumReached)) return;
    const result = onToggle(code);
    if (result && typeof result.then === "function") {
      setPendingToggle(true);
      void result.catch(() => {}).finally(() => setPendingToggle(false));
    }
  };

  return <div className="reaction-palette" role="group" aria-label={t("Выберите реакцию")}>
      {CHAT_REACTION_CODES.map((code) => {
        const active = mine.includes(code);
        return <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={active}
          aria-label={reactionLabel(code, t)}
          key={code}
          disabled={busy || (!active && maximumReached)}
          title={!active && maximumReached ? t("Можно выбрать не более трёх реакций") : reactionLabel(code, t)}
          onClick={() => toggle(code)}
        >{REACTION_EMOJI[code]}</button>;
      })}
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
