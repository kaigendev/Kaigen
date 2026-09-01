import { createContext, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type KaigenTheme = "current" | "softlifegreen";

export const KAIGEN_THEME_STORAGE_KEY = "kaigen-ui-theme";
export const DEFAULT_KAIGEN_THEME: KaigenTheme = "current";

export function normalizeKaigenTheme(value: unknown): KaigenTheme {
  return value === "softlifegreen" ? "softlifegreen" : DEFAULT_KAIGEN_THEME;
}

type ThemeContextValue = {
  theme: KaigenTheme;
  setTheme: (theme: KaigenTheme) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readInitialTheme(): KaigenTheme {
  try {
    return normalizeKaigenTheme(window.localStorage.getItem(KAIGEN_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_KAIGEN_THEME;
  }
}

export function ThemeProvider({ children, initialTheme }: { children: ReactNode; initialTheme?: KaigenTheme }) {
  const [theme, setTheme] = useState<KaigenTheme>(() => initialTheme ?? readInitialTheme());

  useLayoutEffect(() => {
    document.documentElement.dataset.kaigenTheme = theme;
    try {
      window.localStorage.setItem(KAIGEN_THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is a non-secret convenience. A denied storage API
      // must not prevent the UI from using the selected in-memory theme.
    }
  }, [theme]);

  const value = useMemo(() => ({ theme, setTheme }), [theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useKaigenTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useKaigenTheme must be used inside ThemeProvider");
  return value;
}
