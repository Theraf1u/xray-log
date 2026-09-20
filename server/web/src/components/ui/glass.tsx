"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A Liquid Glass surface.
 *
 * Deliberately NOT a Card: no CardHeader/CardTitle/CardContent stack. That
 * pattern spends ~60px of vertical space on a label before any data appears,
 * and repeating it fifteen times is what made the old dashboard read as an
 * admin template. Here the title is an inline rail inside the same surface.
 */
export function Glass({
  className,
  interactive,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) {
  return (
    <div
      className={cn("glass", interactive && "glass-interactive", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

/**
 * Title rail: one line, baseline-aligned, with actions on the right.
 *
 * Actions live here rather than in a toolbar elsewhere on the page, so a
 * control is always adjacent to the object it acts on.
 */
export function GlassRail({
  title,
  hint,
  icon,
  actions,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 px-4 py-2.5 sm:px-5",
        className
      )}
    >
      {icon}
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
      {hint && (
        <span className="truncate text-xs text-muted-foreground">{hint}</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </div>
  );
}

/** Hairline separator — separation without another container. */
export function GlassLine({ className }: { className?: string }) {
  return <div className={cn("glass-hairline h-px w-full", className)} />;
}
