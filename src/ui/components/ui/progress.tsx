import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

type ProgressProps = React.ComponentPropsWithoutRef<
  typeof ProgressPrimitive.Root
> & {
  indicatorClassName?: string
}

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  ProgressProps
>(
  (
    {
      className,
      indicatorClassName,
      value,
      max = 100,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      ...props
    },
    ref,
  ) => {
    const safeMax = Math.max(max, 1)
    const safeValue =
      value == null ? null : Math.min(Math.max(value, 0), safeMax)
    const percentage = safeValue == null ? null : (safeValue / safeMax) * 100

    return (
      <ProgressPrimitive.Root
        ref={ref}
        data-slot="progress"
        value={safeValue}
        max={safeMax}
        aria-label={ariaLabel ?? (ariaLabelledBy ? undefined : "进度")}
        aria-labelledby={ariaLabelledBy}
        className={cn(
          "relative h-2 w-full overflow-hidden rounded-full bg-primary/15",
          className,
        )}
        {...props}
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className={cn(
            "h-full rounded-full bg-primary transition-transform duration-300 ease-standard",
            percentage == null && "w-1/2 animate-progress",
            indicatorClassName,
          )}
          style={
            percentage == null
              ? undefined
              : { transform: `translateX(-${100 - percentage}%)` }
          }
        />
      </ProgressPrimitive.Root>
    )
  },
)
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress }
export type { ProgressProps }
