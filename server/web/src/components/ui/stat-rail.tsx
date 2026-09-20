"use client";

import type { ReactNode } from "react";
import { Glass } from "@/components/ui/glass";
import { GlassMotif, type MotifName } from "@/components/ui/glass-motif";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { cn } from "@/lib/utils";

export interface StatItem {
  key: string;
  label: string;
  value: number | string;
  /** Small line under the number: units, qualifier, threshold. */
  hint?: ReactNode;
  /** A dot beside the label. Use only when the state actually matters. */
  dot?: "warn" | "bad" | "ok";
  /** Imagery matching what this figure counts. */
  motif?: MotifName;
  /** Tints the figure. Reserved for genuine severity, not decoration. */
  tone?: "bad" | "warn" | "ok";
}

/**
 * A row of separate stat tiles.
 *
 * Each figure is its own glass surface with its own corners and its own motif
 * bleeding off the trailing edge — one continuous strip put a single shape at
 * the far end and left every other cell bare.
 *
 * Still much denser than what this replaces: the old pattern spent a Card,
 * a CardHeader and a CardContent (~140px tall) on one number.
 */
export function StatRail({
  items,
  columns = 4,
  className,
}: {
  items: StatItem[];
  columns?: 3 | 4 | 5 | 6;
  className?: string;
}) {
  const cols = {
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-2 lg:grid-cols-4",
    5: "sm:grid-cols-3 lg:grid-cols-5",
    6: "sm:grid-cols-3 lg:grid-cols-6",
  }[columns];

  return (
    <div className={cn("grid grid-cols-2 gap-2.5", cols, className)}>
      {items.map((item) => (
        <Glass key={item.key} className="relative overflow-hidden px-3.5 py-2.5">
          {item.motif && <GlassMotif name={item.motif} />}

          <div className="relative flex items-center gap-1.5">
            {item.dot && (
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  item.dot === "bad" && "bg-destructive",
                  item.dot === "warn" && "bg-yellow-500",
                  item.dot === "ok" && "bg-green-500"
                )}
              />
            )}
            <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground">
              {item.label}
            </span>
          </div>

          <div
            className={cn(
              "relative mt-1 text-[21px] font-semibold leading-none tabular-nums tracking-tight",
              item.tone === "bad" && "text-destructive",
              item.tone === "warn" && "text-yellow-500",
              item.tone === "ok" && "text-green-500"
            )}
          >
            {typeof item.value === "number" ? <AnimatedNumber value={item.value} /> : item.value}
          </div>

          {item.hint && (
            <p className="relative mt-1 truncate text-[10px] leading-tight text-muted-foreground">{item.hint}</p>
          )}
        </Glass>
      ))}
    </div>
  );
}
