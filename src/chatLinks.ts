export type ChatLinkSegment = Readonly<{ start: number; end: number; text: string; href?: string }>;

/** One normalized address is used for the link, platform opener and clipboard. */
export function normalizeChatLink(value: string): string | null {
  if (!value || /[\s\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u.test(value)) return null;
  const address = /^www\./iu.test(value) ? `https://${value}` : value;
  if (!/^https?:\/\//iu.test(address)) return null;
  try {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    if (/^www\./iu.test(value) && url.hostname.length <= 4) return null;
    return url.href;
  } catch { return null; }
}

function trimLinkPunctuation(value: string, previous: string, standalone: boolean) {
  const delimiters: Record<string, string> = { "(": ")", "[": "]", "{": "}", "«": "»", "“": "”", "‘": "’", "'": "'" };
  const closing = delimiters[previous];
  const boundary = closing ? value.lastIndexOf(closing) : -1;
  if (boundary >= 0 && /^[.,!?;:…]*$/u.test(value.slice(boundary + 1))) {
    const quoted = previous !== "(" && previous !== "[" && previous !== "{";
    const balance = [...value.slice(0, boundary + 1)].reduce((count, character) => count + (character === previous ? 1 : character === closing ? -1 : 0), 0);
    if (quoted || balance < 0) return value.slice(0, boundary);
  }
  // In query/fragment values punctuation is data. Preserve ambiguous tails;
  // only an explicit enclosing delimiter above disambiguates prose punctuation.
  if (standalone || /[?#]/u.test(value)) return value;
  let end = value.length;
  const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const balances: Record<string, number> = { ")": 0, "]": 0, "}": 0 };
  for (const character of value) {
    for (const [close, open] of Object.entries(opening)) {
      if (character === open) balances[close] += 1;
      else if (character === close) balances[close] -= 1;
    }
  }
  while (end > 0) {
    const last = value[end - 1];
    if (/[.,!?;:'"«»“”‘’…]/u.test(last)) { end -= 1; continue; }
    if (opening[last] && balances[last] < 0) { balances[last] += 1; end -= 1; continue; }
    break;
  }
  return value.slice(0, end);
}

export function chatLinkSegments(text: string): ChatLinkSegment[] {
  const segments: ChatLinkSegment[] = [];
  let through = 0;
  for (const match of text.matchAll(/(?:https?:\/\/|www\.)[^\s<>"`]+/giu)) {
    const start = match.index!;
    const previous = text[start - 1] ?? "";
    if (/[\p{L}\p{N}_@]/u.test(previous) || /^www\./iu.test(match[0]) && /[:/]/u.test(previous)) continue;
    const standalone = /^https?:\/\//iu.test(match[0]) && text.trim() === match[0];
    const visible = trimLinkPunctuation(match[0], previous, standalone);
    const href = normalizeChatLink(visible);
    if (!href) continue;
    if (start > through) segments.push({ start: through, end: start, text: text.slice(through, start) });
    through = start + visible.length;
    segments.push({ start, end: through, text: visible, href });
  }
  if (through < text.length) segments.push({ start: through, end: text.length, text: text.slice(through) });
  return segments;
}

/** Nested formatting/search marks count as the link; neighbouring text does not. */
export function chatLinkAtTarget(target: Element): string | undefined {
  const link = target.closest<HTMLAnchorElement>("a.chat-message-link[href]");
  if (!link?.closest(".message-text")) return undefined;
  return normalizeChatLink(link.getAttribute("href") ?? "") ?? undefined;
}
