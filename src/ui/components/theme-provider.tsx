import * as React from "react"

type Theme = "dark" | "light" | "system"
type ResolvedTheme = Exclude<Theme, "system">

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const ThemeProviderContext = React.createContext<ThemeProviderState | undefined>(
  undefined,
)

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

function getStoredTheme(storageKey: string, fallback: Theme): Theme {
  if (typeof window === "undefined") return fallback

  try {
    const storedTheme = window.localStorage.getItem(storageKey)
    return storedTheme === "light" ||
      storedTheme === "dark" ||
      storedTheme === "system"
      ? storedTheme
      : fallback
  } catch {
    return fallback
  }
}

function applyResolvedTheme(theme: ResolvedTheme) {
  const root = document.documentElement
  root.classList.remove("light", "dark")
  root.classList.add(theme)
  root.dataset.theme = theme
}

export function initializeTheme(
  storageKey = "prompt-studio-theme",
  defaultTheme: Theme = "system",
) {
  const theme = getStoredTheme(storageKey, defaultTheme)
  applyResolvedTheme(theme === "system" ? getSystemTheme() : theme)
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "prompt-studio-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(() =>
    getStoredTheme(storageKey, defaultTheme),
  )
  const [systemTheme, setSystemTheme] =
    React.useState<ResolvedTheme>(getSystemTheme)

  const resolvedTheme = theme === "system" ? systemTheme : theme

  React.useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const updateSystemTheme = () =>
      setSystemTheme(mediaQuery.matches ? "dark" : "light")

    updateSystemTheme()
    mediaQuery.addEventListener("change", updateSystemTheme)
    return () => mediaQuery.removeEventListener("change", updateSystemTheme)
  }, [])

  React.useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  const setTheme = React.useCallback(
    (nextTheme: Theme) => {
      try {
        window.localStorage.setItem(storageKey, nextTheme)
      } catch {
        // Theme selection still applies for the current session.
      }
      setThemeState(nextTheme)
    },
    [storageKey],
  )

  const value = React.useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  )

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme() {
  const context = React.useContext(ThemeProviderContext)

  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider")
  }

  return context
}

export type { ResolvedTheme, Theme }
