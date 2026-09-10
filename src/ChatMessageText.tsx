import { Fragment, useMemo, useRef, type MouseEvent } from "react";
import { FormattedMessageText } from "./ChatMessageEnhancements";
import { chatLinkSegments } from "./chatLinks";
import { normalizeFormattingSpans, searchTextSegments, type ChatFormattingSpan } from "./chatRichText";

const noMatches: readonly { start: number; end: number; resultIndex: number }[] = [];

export function ChatMessageText({ text, formatting, matches = noMatches, selectedMatch = -1, onOpenLink }: {
  text: string;
  formatting?: readonly Partial<ChatFormattingSpan>[] | null;
  matches?: readonly { start: number; end: number; resultIndex: number }[];
  selectedMatch?: number;
  onOpenLink: (url: string) => void;
}) {
  const openLinkRef = useRef(onOpenLink);
  openLinkRef.current = onOpenLink;
  // Quote/menu state changes must not tokenize every visible message again.
  // Keeping the callback in a ref still uses the current profile/language owner.
  return useMemo(() => {
  const spans = normalizeFormattingSpans(text, formatting);
  const highlighted = searchTextSegments(text, matches, selectedMatch);
  const activate = (event: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (event.defaultPrevented || event.type === "auxclick" && event.button !== 1) return;
    event.preventDefault();
    openLinkRef.current(href);
  };
  return <>{chatLinkSegments(text).map((range) => {
    const content = highlighted.flatMap((segment) => {
      const start = Math.max(range.start, segment.start);
      const end = Math.min(range.end, segment.end);
      if (end <= start) return [];
      const clipped = spans.flatMap((span) => {
        const left = Math.max(start, span.offsetUtf16);
        const right = Math.min(end, span.offsetUtf16 + span.lengthUtf16);
        return right > left ? [{ kind: span.kind, offsetUtf16: left - start, lengthUtf16: right - left }] : [];
      });
      const formatted = <FormattedMessageText text={text.slice(start, end)} formatting={clipped} />;
      return [segment.resultIndex === undefined ? <Fragment key={start}>{formatted}</Fragment> : <mark
        className={`message-search-hit ${segment.resultIndex === selectedMatch ? "current" : ""}`}
        data-search-result={segment.resultIndex} key={start}
      >{formatted}</mark>];
    });
    return range.href ? <a
      className="chat-message-link" href={range.href} title={range.href} aria-label={range.href}
      target="_blank" rel="noopener noreferrer" key={range.start}
      onClick={(event) => activate(event, range.href!)} onAuxClick={(event) => activate(event, range.href!)}
    ><span className="chat-message-link-label">{content}</span></a> : <Fragment key={range.start}>{content}</Fragment>;
  })}</>;
  }, [text, formatting, matches, selectedMatch]);
}
