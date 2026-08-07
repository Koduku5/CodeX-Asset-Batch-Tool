import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import App from "@/App"
import {
  initializeTheme,
  ThemeProvider,
} from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import "@/styles/globals.css"

const root = document.getElementById("root")

initializeTheme("prompt-studio-theme", "system")

if (!root) {
  throw new Error("Missing #root mount element")
}

createRoot(root).render(
  <StrictMode>
    <ThemeProvider defaultTheme="system" storageKey="prompt-studio-theme">
      <TooltipProvider delayDuration={300} skipDelayDuration={100}>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
