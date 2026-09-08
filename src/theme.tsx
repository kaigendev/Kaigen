import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@kaigen/platform";
import {
  hydratePortableLayout,
  resolvePortableLayoutValue,
  retainPortableLayoutPatch,
  savePortableLayoutPatch,
} from "./layoutPersistence";

export type KaigenTheme = "current" | "softlifegreen";

export const KAIGEN_THEME_STORAGE_KEY = "kaigen-ui-theme";
export const DEFAULT_KAIGEN_THEME: KaigenTheme = "current";

export function normalizeKaigenTheme(value: unknown): KaigenTheme {
  return value === "softlifegreen" ? "softlifegreen" : DEFAULT_KAIGEN_THEME;
}

type ThemeContextValue = {
  theme: KaigenTheme;
  setTheme: (theme: KaigenTheme) => void;
  ready: boolean;
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
  const desktop = __KAIGEN_PRODUCT__ === "desktop";
  const explicitInitialTheme = initialTheme !== undefined;
  const [theme, setThemeState] = useState<KaigenTheme>(() => initialTheme ?? (desktop ? DEFAULT_KAIGEN_THEME : readInitialTheme()));
  const [desktopHydrated, setDesktopHydrated] = useState(!desktop || explicitInitialTheme);
  const userChoiceRevision = useRef(explicitInitialTheme ? 1 : 0);
  const submittedTheme = useRef<KaigenTheme | null>(null);
  const desktopLoadFailed = useRef(false);
  const setTheme = useCallback((next: KaigenTheme) => {
    userChoiceRevision.current += 1;
    setThemeState(next);
  }, []);

  useLayoutEffect(() => {
    if (!desktop || explicitInitialTheme) return;
    let mounted = true;
    const revisionAtLoad = userChoiceRevision.current;
    void hydratePortableLayout(() => invoke<Record<string, unknown> | null>("load_layout_state"))
      .then((saved) => {
        if (!mounted) return;
        if (!explicitInitialTheme && userChoiceRevision.current === revisionAtLoad) {
          const resolvedTheme = resolvePortableLayoutValue(saved, "theme", readInitialTheme);
          const hydratedTheme = normalizeKaigenTheme(resolvedTheme.value);
          if (resolvedTheme.persisted) submittedTheme.current = hydratedTheme;
          setThemeState(hydratedTheme);
        }
        setDesktopHydrated(true);
      })
      .catch((error) => {
        desktopLoadFailed.current = true;
        console.error("Не удалось загрузить общую компоновку интерфейса", error);
        if (mounted) setDesktopHydrated(true);
      });
    return () => { mounted = false; };
  }, [desktop, explicitInitialTheme]);

  useLayoutEffect(() => {
    document.documentElement.dataset.kaigenTheme = theme;
    if (desktop) return;
    try {
      window.localStorage.setItem(KAIGEN_THEME_STORAGE_KEY, theme);
    } catch {
      // Theme persistence is a non-secret convenience. A denied storage API
      // must not prevent the UI from using the selected in-memory theme.
    }
  }, [desktop, theme]);

  useEffect(() => {
    if (!desktop || explicitInitialTheme || desktopLoadFailed.current) return;
    if (!desktopHydrated && userChoiceRevision.current === 0) return;
    if (submittedTheme.current === theme) return;
    submittedTheme.current = theme;
    retainPortableLayoutPatch({ theme });
    void savePortableLayoutPatch(
      { theme },
      (state) => invoke("save_layout_state", { state }),
    ).catch((error) => {
      if (submittedTheme.current === theme) submittedTheme.current = null;
      console.error("Не удалось сохранить общую компоновку интерфейса", error);
    });
  }, [desktop, desktopHydrated, explicitInitialTheme, theme]);

  const value = useMemo(() => ({ theme, setTheme, ready: desktopHydrated }), [desktopHydrated, theme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useKaigenTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useKaigenTheme must be used inside ThemeProvider");
  return value;
}
