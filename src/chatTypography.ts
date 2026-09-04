export const TYPOGRAPHY_FONTS = [
  { id: "ibm-plex-sans-condensed", label: "IBM Plex Sans Condensed", family: '"IBM Plex Sans Condensed", sans-serif', stretch: "normal" },
  { id: "fira-sans-condensed", label: "Fira Sans Condensed", family: '"Fira Sans Condensed", sans-serif', stretch: "normal" },
  { id: "noto-sans-semi-condensed", label: "Noto Sans SemiCondensed", family: '"Noto Sans Variable", sans-serif', stretch: "87.5%" },
  { id: "source-sans-3", label: "Source Sans 3", family: '"Source Sans 3", sans-serif', stretch: "normal" },
  { id: "golos-text", label: "Golos Text", family: '"Golos Text", sans-serif', stretch: "normal" },
  { id: "martian-mono", label: "Martian Mono", family: '"Martian Mono", monospace', stretch: "normal" },
  { id: "inter", label: "Inter", family: '"Inter", sans-serif', stretch: "normal" },
  { id: "onest", label: "Onest", family: '"Onest", sans-serif', stretch: "normal" },
] as const;

export type TypographyFontId = (typeof TYPOGRAPHY_FONTS)[number]["id"];

export const INTERFACE_FONT_SIZES = [13, 14, 15, 16, 17, 18, 20] as const;
export const CHAT_FONT_SIZES = [13, 14, 15, 16, 18, 20, 22, 24, 26, 28] as const;
export const PROFILE_PLACEHOLDER_FONT_SIZES = [30, 35, 40, 45, 50, 55, 60] as const;

export type AppearanceSettings = {
  interfaceFont: TypographyFontId;
  interfaceFontSize: number;
  chatFont: TypographyFontId;
  chatFontSize: number;
  profilePlaceholderFont: TypographyFontId;
  profilePlaceholderFontSize: number;
  interfaceScale: number;
};

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  interfaceFont: "inter",
  interfaceFontSize: 16,
  chatFont: "golos-text",
  chatFontSize: 15,
  profilePlaceholderFont: "onest",
  profilePlaceholderFontSize: 45,
  interfaceScale: 100,
};

const LEGACY_FONT_IDS: Record<string, TypographyFontId> = {
  "ibm-plex-sans-condensed": "ibm-plex-sans-condensed",
  "IBM Plex Sans Condensed": "ibm-plex-sans-condensed",
  "fira-sans-condensed": "fira-sans-condensed",
  "Fira Sans Condensed": "fira-sans-condensed",
  "noto-sans-semi-condensed": "noto-sans-semi-condensed",
  "Noto Sans SemiCondensed": "noto-sans-semi-condensed",
  "source-sans-3": "source-sans-3",
  "Source Sans 3": "source-sans-3",
  "golos-text": "golos-text",
  "Golos Text": "golos-text",
  '"Golos Text", sans-serif': "golos-text",
  '"Golos Text", Inter, "Segoe UI", Arial, sans-serif': "golos-text",
  "martian-mono": "martian-mono",
  "Martian Mono": "martian-mono",
  '"Martian Mono Kaigen", monospace': "martian-mono",
  "inter": "inter",
  "Inter": "inter",
  "Inter, Segoe UI, Arial, sans-serif": "inter",
  'Inter, "Segoe UI", Arial, sans-serif': "inter",
  "onest": "onest",
  "Onest": "onest",
};

export function normalizeTypographyFontId(value: unknown, fallback: TypographyFontId): TypographyFontId {
  if (typeof value !== "string") return fallback;
  const direct = TYPOGRAPHY_FONTS.find((font) => font.id === value);
  if (direct) return direct.id;
  return LEGACY_FONT_IDS[value] ?? fallback;
}

function normalizeSize(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && allowed.includes(value) ? value : fallback;
}

export function normalizeAppearance(value?: Partial<AppearanceSettings> | null): AppearanceSettings {
  return {
    interfaceFont: normalizeTypographyFontId(value?.interfaceFont, DEFAULT_APPEARANCE.interfaceFont),
    interfaceFontSize: normalizeSize(value?.interfaceFontSize, INTERFACE_FONT_SIZES, DEFAULT_APPEARANCE.interfaceFontSize),
    chatFont: normalizeTypographyFontId(value?.chatFont, DEFAULT_APPEARANCE.chatFont),
    chatFontSize: normalizeSize(value?.chatFontSize, CHAT_FONT_SIZES, DEFAULT_APPEARANCE.chatFontSize),
    profilePlaceholderFont: normalizeTypographyFontId(value?.profilePlaceholderFont, DEFAULT_APPEARANCE.profilePlaceholderFont),
    profilePlaceholderFontSize: normalizeSize(value?.profilePlaceholderFontSize, PROFILE_PLACEHOLDER_FONT_SIZES, DEFAULT_APPEARANCE.profilePlaceholderFontSize),
    interfaceScale: normalizeSize(value?.interfaceScale, [80, 90, 100, 110, 125, 150], DEFAULT_APPEARANCE.interfaceScale),
  };
}

export function getTypographyFont(value: unknown, fallback: TypographyFontId) {
  const id = normalizeTypographyFontId(value, fallback);
  return TYPOGRAPHY_FONTS.find((font) => font.id === id) ?? TYPOGRAPHY_FONTS[0];
}
