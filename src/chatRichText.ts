export const CHAT_FORMAT_KINDS = ["bold", "underline", "italic", "strikethrough"] as const;

export type ChatFormattingKind = (typeof CHAT_FORMAT_KINDS)[number];

export type ChatFormattingSpan = Readonly<{
  kind: ChatFormattingKind;
  offsetUtf16: number;
  lengthUtf16: number;
}>;

export type ChatQuote = Readonly<{
  messageId?: string;
  author: string;
  text: string;
  legacy?: boolean;
}>;

export const CHAT_REACTION_CODES = ["thumbs_up", "thumbs_down", "grin", "sad", "heart", "rocket"] as const;
export type ChatReactionCode = (typeof CHAT_REACTION_CODES)[number];

export type ChatMessageReactions = Readonly<{
  mine: readonly ChatReactionCode[];
  peer: readonly ChatReactionCode[];
  mineRevision: number;
  peerRevision: number;
  delivery: "delivered" | "pending" | "rejected";
}>;

export const MAX_CHAT_FORMATTING_SPANS = 128;
const MAX_FORMATTING_INPUT_SPANS = MAX_CHAT_FORMATTING_SPANS * 4;

const FORMAT_KIND_ORDER = new Map<ChatFormattingKind, number>(
  CHAT_FORMAT_KINDS.map((kind, index) => [kind, index]),
);

function isChatFormattingKind(value: unknown): value is ChatFormattingKind {
  return typeof value === "string" && CHAT_FORMAT_KINDS.includes(value as ChatFormattingKind);
}

function clampInteger(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function isHighSurrogate(value: number) {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number) {
  return value >= 0xdc00 && value <= 0xdfff;
}

function safeUtf16Boundary(text: string, requested: number, edge: "start" | "end") {
  const offset = clampInteger(requested, 0, text.length);
  if (
    offset > 0
    && offset < text.length
    && isHighSurrogate(text.charCodeAt(offset - 1))
    && isLowSurrogate(text.charCodeAt(offset))
  ) {
    return edge === "start" ? offset - 1 : offset + 1;
  }
  return offset;
}

/**
 * Clamps untrusted protocol spans to the message's UTF-16 boundaries, merges
 * equivalent intervals and bounds the work a malformed remote message can
 * cause. JavaScript string indexes are UTF-16 indexes, matching the wire
 * contract exactly.
 */
export function normalizeFormattingSpans(
  text: string,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
): ChatFormattingSpan[] {
  if (!text || !Array.isArray(spans) || spans.length === 0) return [];

  const byKind = new Map<ChatFormattingKind, Array<{ start: number; end: number }>>();
  let accepted = 0;
  for (const candidate of spans) {
    if (accepted >= MAX_FORMATTING_INPUT_SPANS) break;
    if (!candidate || !isChatFormattingKind(candidate.kind)) continue;
    const requestedStart = clampInteger(candidate.offsetUtf16, 0, text.length);
    const requestedLength = clampInteger(candidate.lengthUtf16, 0, text.length);
    const requestedEnd = Math.min(text.length, requestedStart + requestedLength);
    const start = safeUtf16Boundary(text, requestedStart, "start");
    const end = safeUtf16Boundary(text, requestedEnd, "end");
    if (end <= start) continue;
    const ranges = byKind.get(candidate.kind) ?? [];
    ranges.push({ start, end });
    byKind.set(candidate.kind, ranges);
    accepted += 1;
  }

  const normalized: ChatFormattingSpan[] = [];
  for (const kind of CHAT_FORMAT_KINDS) {
    const ranges = byKind.get(kind);
    if (!ranges) continue;
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    let current: { start: number; end: number } | null = null;
    for (const range of ranges) {
      if (!current) {
        current = { ...range };
        continue;
      }
      if (range.start <= current.end) {
        current.end = Math.max(current.end, range.end);
        continue;
      }
      normalized.push({ kind, offsetUtf16: current.start, lengthUtf16: current.end - current.start });
      current = { ...range };
    }
    if (current) normalized.push({ kind, offsetUtf16: current.start, lengthUtf16: current.end - current.start });
  }

  return normalized
    .sort((left, right) => (
      left.offsetUtf16 - right.offsetUtf16
      || left.lengthUtf16 - right.lengthUtf16
      || (FORMAT_KIND_ORDER.get(left.kind) ?? 0) - (FORMAT_KIND_ORDER.get(right.kind) ?? 0)
    ))
    .slice(0, MAX_CHAT_FORMATTING_SPANS);
}

export type FormattedTextSegment = Readonly<{
  text: string;
  offsetUtf16: number;
  kinds: readonly ChatFormattingKind[];
}>;

export function searchTextSegments(text: string, matches: readonly { start: number; end: number; resultIndex: number }[], selectedIndex: number) {
  const ranges = matches.slice(0, 100).filter((match) => Number.isInteger(match.start) && Number.isInteger(match.end) && match.start >= 0 && match.end > match.start && match.end <= text.length)
    .map((match) => ({ ...match, start: safeUtf16Boundary(text, match.start, "start"), end: safeUtf16Boundary(text, match.end, "end") }));
  const boundaries = [...new Set([0, text.length, ...ranges.flatMap((range) => [range.start, range.end])])].sort((left, right) => left - right);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const covering = ranges.filter((range) => range.start <= start && range.end >= end);
    const match = covering.find((range) => range.resultIndex === selectedIndex) ?? covering[0];
    return { start, end, text: text.slice(start, end), resultIndex: match?.resultIndex };
  });
}

export function formattedTextSegments(
  text: string,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
): FormattedTextSegment[] {
  if (!text) return [];
  const normalized = normalizeFormattingSpans(text, spans);
  if (!normalized.length) return [{ text, offsetUtf16: 0, kinds: [] }];

  const boundaries = new Set([0, text.length]);
  for (const span of normalized) {
    boundaries.add(span.offsetUtf16);
    boundaries.add(span.offsetUtf16 + span.lengthUtf16);
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  const segments: FormattedTextSegment[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index];
    const end = ordered[index + 1];
    if (end <= start) continue;
    const kinds = CHAT_FORMAT_KINDS.filter((kind) => normalized.some((span) => (
      span.kind === kind
      && span.offsetUtf16 <= start
      && span.offsetUtf16 + span.lengthUtf16 >= end
    )));
    segments.push({ text: text.slice(start, end), offsetUtf16: start, kinds });
  }
  return segments;
}

function kindCoversRange(spans: readonly ChatFormattingSpan[], kind: ChatFormattingKind, start: number, end: number) {
  let cursor = start;
  for (const span of spans) {
    if (span.kind !== kind) continue;
    const spanEnd = span.offsetUtf16 + span.lengthUtf16;
    if (spanEnd <= cursor) continue;
    if (span.offsetUtf16 > cursor) return false;
    cursor = Math.max(cursor, spanEnd);
    if (cursor >= end) return true;
  }
  return false;
}

export function selectionHasFormatting(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kind: ChatFormattingKind,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
) {
  const start = safeUtf16Boundary(text, Math.min(selectionStart, selectionEnd), "start");
  const end = safeUtf16Boundary(text, Math.max(selectionStart, selectionEnd), "end");
  return end > start && kindCoversRange(normalizeFormattingSpans(text, spans), kind, start, end);
}

export function toggleFormattingForSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  kind: ChatFormattingKind,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
): ChatFormattingSpan[] {
  const start = safeUtf16Boundary(text, Math.min(selectionStart, selectionEnd), "start");
  const end = safeUtf16Boundary(text, Math.max(selectionStart, selectionEnd), "end");
  const normalized = normalizeFormattingSpans(text, spans);
  if (end <= start) return normalized;

  if (!kindCoversRange(normalized, kind, start, end)) {
    return normalizeFormattingSpans(text, [
      ...normalized,
      { kind, offsetUtf16: start, lengthUtf16: end - start },
    ]);
  }

  const next: ChatFormattingSpan[] = [];
  for (const span of normalized) {
    if (span.kind !== kind) {
      next.push(span);
      continue;
    }
    const spanStart = span.offsetUtf16;
    const spanEnd = span.offsetUtf16 + span.lengthUtf16;
    if (spanEnd <= start || spanStart >= end) {
      next.push(span);
      continue;
    }
    if (spanStart < start) next.push({ kind, offsetUtf16: spanStart, lengthUtf16: start - spanStart });
    if (spanEnd > end) next.push({ kind, offsetUtf16: end, lengthUtf16: spanEnd - end });
  }
  return normalizeFormattingSpans(text, next);
}

function formattingKindsAtInsertion(
  spans: readonly ChatFormattingSpan[],
  changeStart: number,
  oldChangeEnd: number,
) {
  return CHAT_FORMAT_KINDS.filter((kind) => spans.some((span) => {
    if (span.kind !== kind) return false;
    const start = span.offsetUtf16;
    const end = start + span.lengthUtf16;
    if (oldChangeEnd > changeStart) return start <= changeStart && end >= oldChangeEnd;
    return start < changeStart && end >= changeStart;
  }));
}

/** Keeps styles attached to unchanged text and to replacement text only when
 * the entire replaced range carried that style. */
export function rebaseFormattingAfterTextEdit(
  previousText: string,
  nextText: string,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
): ChatFormattingSpan[] {
  const normalized = normalizeFormattingSpans(previousText, spans);
  if (!normalized.length || previousText === nextText) return normalizeFormattingSpans(nextText, normalized);

  let prefix = 0;
  const prefixLimit = Math.min(previousText.length, nextText.length);
  while (prefix < prefixLimit && previousText.charCodeAt(prefix) === nextText.charCodeAt(prefix)) prefix += 1;
  prefix = safeUtf16Boundary(previousText, prefix, "start");

  let suffix = 0;
  while (
    suffix < previousText.length - prefix
    && suffix < nextText.length - prefix
    && previousText.charCodeAt(previousText.length - 1 - suffix) === nextText.charCodeAt(nextText.length - 1 - suffix)
  ) suffix += 1;

  const oldChangeEnd = previousText.length - suffix;
  const newChangeEnd = nextText.length - suffix;
  const insertedKinds = new Set(formattingKindsAtInsertion(normalized, prefix, oldChangeEnd));
  const nextKindRuns = new Map<ChatFormattingKind, Array<{ start: number; end: number }>>();

  const appendRun = (kind: ChatFormattingKind, start: number, end: number) => {
    if (end <= start) return;
    const ranges = nextKindRuns.get(kind) ?? [];
    ranges.push({ start, end });
    nextKindRuns.set(kind, ranges);
  };

  for (const span of normalized) {
    const spanStart = span.offsetUtf16;
    const spanEnd = spanStart + span.lengthUtf16;
    appendRun(span.kind, spanStart, Math.min(spanEnd, prefix));
    if (spanEnd > oldChangeEnd) {
      const suffixStart = Math.max(spanStart, oldChangeEnd);
      appendRun(
        span.kind,
        newChangeEnd + (suffixStart - oldChangeEnd),
        newChangeEnd + (spanEnd - oldChangeEnd),
      );
    }
  }
  for (const kind of insertedKinds) appendRun(kind, prefix, newChangeEnd);

  const rebased = [...nextKindRuns.entries()].flatMap(([kind, ranges]) => ranges.map((range) => ({
    kind,
    offsetUtf16: range.start,
    lengthUtf16: range.end - range.start,
  })));
  return normalizeFormattingSpans(nextText, rebased);
}

export function prepareFormattedSubmission(
  value: string,
  spans: readonly Partial<ChatFormattingSpan>[] | null | undefined,
) {
  const text = value.trim();
  if (!text) return { text: "", formatting: [] as ChatFormattingSpan[] };
  const leading = value.length - value.trimStart().length;
  const end = leading + text.length;
  const formatting = normalizeFormattingSpans(value, spans).flatMap((span) => {
    const start = Math.max(leading, span.offsetUtf16);
    const spanEnd = Math.min(end, span.offsetUtf16 + span.lengthUtf16);
    if (spanEnd <= start) return [];
    return [{ kind: span.kind, offsetUtf16: start - leading, lengthUtf16: spanEnd - start }];
  });
  return { text, formatting: normalizeFormattingSpans(text, formatting) };
}

export function shouldSubmitComposerKey(
  event: Readonly<{ key: string; shiftKey: boolean; isComposing?: boolean; keyCode?: number }>,
  sendOnEnter: boolean,
) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return false;
  return sendOnEnter ? !event.shiftKey : event.shiftKey;
}

/** Exact plaintext shape produced by qTox GenericChatForm::quoteSelectedText. */
export function serializeQtoxQuote(text: string) {
  if (!text) return "";
  return `> ${text.replace(/\r\n|[\r\n\u2028\u2029]/gu, "\n> ")}\n`;
}

export function parseQtoxQuoteMessage(value: string): { quoteText: string; body: string } | null {
  const normalized = value.replace(/\r\n|[\r\u2028\u2029]/gu, "\n");
  if (!normalized.startsWith("> ")) return null;
  const lines = normalized.split("\n");
  const quoteLines: string[] = [];
  let index = 0;
  while (index < lines.length && lines[index].startsWith("> ")) {
    quoteLines.push(lines[index].slice(2));
    index += 1;
  }
  return {
    quoteText: quoteLines.join("\n"),
    body: lines.slice(index).join("\n"),
  };
}
