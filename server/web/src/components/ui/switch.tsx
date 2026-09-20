"use client";

import { cn } from "@/lib/utils";

/**
 * A minimal on/off switch.
 *
 * No @radix-ui/react-switch is installed in this project, and pulling in a
 * new dependency for one control is not worth the npm-install/rebuild cycle.
 * A native <button role="switch"> with the standard ARIA attributes gets the
 * same keyboard and screen-reader behaviour Radix would give for a fraction
 * of the surface area.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-background shadow transition-transform",
          checked && "translate-x-4"
        )}
      />
    </button>
  );
}
