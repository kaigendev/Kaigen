type ChatDateStyle = "time" | "receipt" | "day" | "dayYear" | "shortDay" | "shortYear" | "shortFullYear";
const options: Record<ChatDateStyle, Intl.DateTimeFormatOptions> = {
  time: { hour: "2-digit", minute: "2-digit" },
  receipt: { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" },
  day: { day: "2-digit", month: "long" },
  dayYear: { day: "2-digit", month: "long", year: "numeric" },
  shortDay: { day: "2-digit", month: "2-digit" },
  shortYear: { day: "2-digit", month: "2-digit", year: "2-digit" },
  shortFullYear: { day: "2-digit", month: "2-digit", year: "numeric" },
};
// Only two languages and seven fixed styles; message text/IDs never enter this cache.
const formatters = new Map<string, Intl.DateTimeFormat>();
export function formatChatDate(date: Date, language: "ru" | "en", style: ChatDateStyle): string {
  const key = `${language}:${style}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language === "en" ? "en-US" : "ru-RU", options[style]);
    formatters.set(key, formatter);
  }
  return formatter.format(date);
}
