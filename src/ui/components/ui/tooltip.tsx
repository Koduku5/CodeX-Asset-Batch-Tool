import * as React from "react"
import * as TooltipPrimitive from "@radix-ui/react-tooltip"

import { cn } from "@/lib/utils"

const TooltipProvider = TooltipPrimitive.Provider
const Tooltip = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> & {
    showArrow?: boolean
  }
>(({ className, sideOffset = 6, showArrow = true, children, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      data-slot="tooltip-content"
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs origin-[var(--radix-tooltip-content-transform-origin)] rounded-md bg-foreground px-2.5 py-1.5 text-xs leading-snug text-background shadow-overlay data-[state=closed]:animate-overlay-out data-[state=delayed-open]:animate-tooltip-in data-[state=instant-open]:animate-tooltip-in",
        className,
      )}
      {...props}
    >
      {children}
      {showArrow ? (
        <TooltipPrimitive.Arrow className="fill-foreground" width={8} height={4} />
      ) : null}
    </TooltipPrimitive.Content>
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }
