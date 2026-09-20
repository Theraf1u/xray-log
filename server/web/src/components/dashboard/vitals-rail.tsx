"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/contexts/auth-context";
import { Glass } from "@/components/ui/glass";
import { GlassMotif, type MotifName } from "@/components/ui/glass-motif";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { cn } from "@/lib/utils";
import { Stats } from "@/lib/types";

interface HourPoint {
  hour: string;
  total_requests: number;
  blacklist_hits: number;
  unique_users: number;
}

/**
 * The page's vital signs, on one surface.
 *
 * Replaces five separate stat cards plus the "period comparison" card: six
 * containers, ~420px of vertical space and three repeated headings, for eleven
 * numbers. Here they share one piece of glass and read as a single instrument.
 *
 * Deltas are shown ONLY where the arithmetic is honest. Summing hourly
 * `unique_users` would double-count anyone active in two hours, so the users
 * cell carries no delta rather than a plausible-looking wrong one. The card
 * this replaces invented its comparisons outright (`previous = current * 0.85`).
 */
export function VitalsRail({ stats }: { stats: Stats }) {
  const t = useTranslations("stats");
  const tv = useTranslations("vitals");
  const [series, setSeries] = useState<HourPoint[] | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const res = await authFetch("/api/hourly?hours=48");
        if (!res.ok) return;
        const data = (await res.json()) as HourPoint[];
        if (active && Array.isArray(data)) setSeries(data);
      } catch {
        // Deltas simply stay hidden; the totals above are unaffected.
      }
    };
    load();
    const timer = window.setInterval(load, 300_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const windows = useMemo(() => {
    if (!series || series.length < 4) return null;
    const recent = series.slice(-24);
    const previous = series.slice(-48, -24);
    if (previous.length === 0) return null;
    const sum = (rows: HourPoint[], key: keyof HourPoint) =>
      rows.reduce((acc, row) => acc + (Number(row[key]) || 0), 0);
    return {
      requests: { now: sum(recent, "total_requests"), before: sum(previous, "total_requests") },
      blacklist: { now: sum(recent, "blacklist_hits"), before: sum(previous, "blacklist_hits") },
      spark: recent.map((r) => r.total_requests),
    };
  }, [series]);

  const delta = (pair?: { now: number; before: number }) => {
    if (!pair || pair.before <= 0) return null;
    return ((pair.now - pair.before) / pair.before) * 100;
  };

  const cells: Array<{
    key: string;
    label: string;
    value: number;
    delta?: number | null;
    tone: "neutral" | "inverse";
    suffix?: React.ReactNode;
    dot?: "warn";
    spark?: number[];
    motif?: MotifName;
  }> = [
    {
      key: "requests",
      motif: "stream",
      label: t("totalRequests"),
      value: stats.total_requests,
      delta: delta(windows?.requests),
      // More requests is normal traffic, not an improvement — stay neutral.
      tone: "neutral" as const,
      spark: windows?.spark,
    },
    {
      key: "blacklist",
      motif: "shield",
      label: t("blacklistHits"),
      value: stats.total_blacklist,
      delta: delta(windows?.blacklist),
      // Here a rise genuinely is worse — but that belongs on the delta tag,
      // not on the number. A permanently red figure says "alarm" even when
      // nothing changed.
      tone: "inverse" as const,
    },
    {
      key: "nodes",
      motif: "nodes",
      label: t("nodes"),
      value: stats.nodes_connected,
      suffix: <span className="text-base font-normal text-muted-foreground">/{stats.nodes_total}</span>,
      // A dot marks a shortfall; the number itself stays neutral like the rest.
      dot: stats.nodes_connected < stats.nodes_total ? ("warn" as const) : undefined,
      tone: "neutral" as const,
    },
    {
      key: "online",
      motif: "pulse",
      label: t("onlineUsers"),
      value: stats.online_users || 0,
      tone: "neutral" as const,
    },
    {
      key: "users",
      motif: "users",
      label: t("totalUsers"),
      value: stats.total_unique_users || 0,
      tone: "neutral" as const,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      {cells.map((cell) => (
        <Glass key={cell.key} className="relative overflow-hidden px-3.5 py-2.5">
          {cell.motif && <GlassMotif name={cell.motif} />}

          <div className="relative flex items-center gap-1.5">
            {cell.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-yellow-500" />}
            <span className="truncate text-[11px] font-medium tracking-wide text-muted-foreground">
              {cell.label}
            </span>
            {cell.delta != null && <DeltaTag value={cell.delta} tone={cell.tone} label={tv("window")} />}
          </div>

          <div className="relative mt-1 flex items-baseline gap-1">
            <span className="text-[21px] font-semibold leading-none tabular-nums tracking-tight">
              <AnimatedNumber value={cell.value} />
            </span>
            {cell.suffix}
          </div>

          {cell.spark && cell.spark.length > 1 && <Sparkline points={cell.spark} />}
        </Glass>
      ))}
    </div>
  );
}

function DeltaTag({
  value,
  tone,
  label,
}: {
  value: number;
  tone: "neutral" | "inverse";
  label: string;
}) {
  const rising = value >= 0;
  const bad = tone === "inverse" && rising;
  const good = tone === "inverse" && !rising;
  return (
    <span
      title={label}
      className={cn(
        "rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums",
        bad
          ? "bg-destructive/10 text-destructive"
          : good
            ? "bg-green-500/10 text-green-600"
            : "bg-muted-foreground/10 text-muted-foreground"
      )}
    >
      {rising ? "+" : ""}
      {value.toFixed(0)}%
    </span>
  );
}

/** 24 hourly points, drawn small enough to sit inside a stat cell. */
function Sparkline({ points }: { points: number[] }) {
  const max = Math.max(...points, 1);
  const path = points
    .map((p, i) => `${(i / (points.length - 1)) * 100},${20 - (p / max) * 18}`)
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="mt-1 h-4 w-full text-primary/45"
      aria-hidden="true"
    >
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
