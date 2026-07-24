import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";
const STORAGE_KEY = "openworkspace-theme";
const themes: Theme[] = ["system", "light", "dark"];
const listeners = new Set<() => void>();

function readTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return themes.includes(stored as Theme) ? (stored as Theme) : "system";
}

function applyTheme(theme: Theme) {
  const dark =
    theme === "dark" ||
    (theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const media = matchMedia("(prefers-color-scheme: dark)");
  const onMedia = () => {
    if (readTheme() === "system") applyTheme("system");
    listener();
  };
  media.addEventListener("change", onMedia);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onMedia);
  };
}

function snapshot() {
  return readTheme();
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, snapshot, () => "system" as Theme);
  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem(STORAGE_KEY, next);
    applyTheme(next);
    listeners.forEach((listener) => listener());
  }, []);
  return { theme, setTheme };
}
