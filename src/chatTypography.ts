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

function normalizeSize(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && allowed.includes(value) ? value : fallback;
}

/** Restore saved appearance values against the same choices shown in settings. */
export function normalizeAppearance(value?: Partial<AppearanceSettings> | null): AppearanceSettings {
  return {
    interfaceFont: getTypographyFont(value?.interfaceFont, DEFAULT_APPEARANCE.interfaceFont).id,
    interfaceFontSize: normalizeSize(value?.interfaceFontSize, INTERFACE_FONT_SIZES, DEFAULT_APPEARANCE.interfaceFontSize),
    chatFont: getTypographyFont(value?.chatFont, DEFAULT_APPEARANCE.chatFont).id,
    chatFontSize: normalizeSize(value?.chatFontSize, CHAT_FONT_SIZES, DEFAULT_APPEARANCE.chatFontSize),
    profilePlaceholderFont: getTypographyFont(value?.profilePlaceholderFont, DEFAULT_APPEARANCE.profilePlaceholderFont).id,
    profilePlaceholderFontSize: normalizeSize(value?.profilePlaceholderFontSize, PROFILE_PLACEHOLDER_FONT_SIZES, DEFAULT_APPEARANCE.profilePlaceholderFontSize),
    interfaceScale: normalizeSize(value?.interfaceScale, [80, 90, 100, 110, 125, 150], DEFAULT_APPEARANCE.interfaceScale),
  };
}

/** Resolve a canonical font ID to its CSS family and stretch. */
export function getTypographyFont(value: unknown, fallback: TypographyFontId) {
  return TYPOGRAPHY_FONTS.find((font) => font.id === value)
    ?? TYPOGRAPHY_FONTS.find((font) => font.id === fallback)
    ?? TYPOGRAPHY_FONTS[0];
}
