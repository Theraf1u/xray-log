"use client";

import React, { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch, useAuth } from "@/contexts/auth-context";
import { useWebSocket } from "@/contexts/websocket-context";
import { cn } from "@/lib/utils";

type ServiceState = "online" | "offline" | "warning" | "loading" | "disabled";

interface ServiceInfo {
  status: ServiceState;
  indicators?: number;
  total_users?: number;
  last_sync?: string;
}

interface ServicesHealth {
  remnawave: ServiceInfo;
  threat_intel: ServiceInfo;
  database: ServiceInfo;
}

const POLL_MS = 15_000;

/** Keyframe durations, in ms — must match the keyframes in globals.css. */
const HALO_MS = 3000;
const ALARM_MS = 2800;

/**
 * Phase offset for an animation on the shared page clock.
 *
 * Returns a negative delay so the element joins an animation already in
 * progress rather than starting its own.
 */
function phaseDelay(durationMs: number): string {
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  return `-${((now % durationMs) / 1000).toFixed(3)}s`;
}


export function ServiceStatusTiles({ className }: { className?: string }) {
  const t = useTranslations("serviceTiles");
  const { isAuthenticated } = useAuth();
  // The dashboard socket lives in the browser, so its state comes from the
  // context rather than the server.
  const { connected } = useWebSocket();
  const [health, setHealth] = useState<ServicesHealth | null>(null);

  useEffect(() => {
    if (!isAuthenticated) return;

    let active = true;
    const load = async () => {
      try {
        const response = await authFetch("/api/services/health");
        if (!response.ok) {
          // Server reachable but unhappy: show the tiles as down rather than
          // freezing the last good values.
          if (active) setHealth(null);
          return;
        }
        const data = (await response.json()) as ServicesHealth;
        if (active) setHealth(data);
      } catch {
        if (active) setHealth(null);
      }
    };

    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isAuthenticated]);

  const tiles: Array<{ key: string; label: string; status: ServiceState; detail: string }> = [
    {
      key: "websocket",
      label: t("websocket"),
      status: connected ? "online" : "offline",
      detail: connected ? t("wsOnline") : t("wsOffline"),
    },
    {
      key: "remnawave",
      label: t("remnawave"),
      status: health ? health.remnawave.status : "loading",
      detail:
        health && health.remnawave.status === "online"
          ? t("remnaUsers", { count: (health.remnawave.total_users ?? 0).toLocaleString("ru-RU") })
          : t("noData"),
    },
    {
      key: "threatIntel",
      label: t("threatIntel"),
      status: health ? health.threat_intel.status : "loading",
      detail:
        health && (health.threat_intel.indicators ?? 0) > 0
          ? t("threatIndicators", { count: (health.threat_intel.indicators ?? 0).toLocaleString("ru-RU") })
          : t("noData"),
    },
    {
      key: "database",
      label: t("database"),
      status: health ? health.database.status : "loading",
      detail: health ? t(health.database.status) : t("noData"),
    },
  ];

  return (
    <>
      {tiles.map((tile) => {
        const down = tile.status === "offline";
        const warn = tile.status === "warning";
        const pending = tile.status === "loading";

        return (
          <span
            key={tile.key}
            title={`${tile.label}: ${t(tile.status)}${tile.detail ? ` — ${tile.detail}` : ""}`}
            className={cn(
              // No border and no fill of its own: these are readings on one
              // instrument, not five separately-sized chips. A failure is the
              // only thing that earns its own colour.
              "status-appear inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
              down ? "bg-red-500/15 text-red-500 animate-status-alarm" : "text-muted-foreground",
              className
            )}
            style={down ? { animationDelay: phaseDelay(ALARM_MS) } : undefined}
          >
            <span
              className={cn(
                "status-dot h-1.5 w-1.5 shrink-0",
                // The halo only means something while the service is live.
                (pending || tile.status === "disabled") && "status-dot--idle",
                down
                  ? "text-red-500"
                  : warn
                    ? "text-yellow-500"
                    : pending || tile.status === "disabled"
                      ? "text-muted-foreground/40"
                      : "text-green-500"
              )}
              style={{ ["--phase" as string]: phaseDelay(HALO_MS) } as React.CSSProperties}
            />
            {tile.label}
          </span>
        );
      })}
    </>
  );
}
