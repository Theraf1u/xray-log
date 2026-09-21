"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/contexts/auth-context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { FlagIcon } from "@/components/ui/flag-icon";
import { Loader2, Users, WifiOff, CircleCheck, CircleAlert } from "lucide-react";
import { RemnaNodeOption } from "@/lib/types";

function formatBytes(bytes: number): string {
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString("ru-RU", { maximumFractionDigits: unit >= 3 ? 2 : 1 })} ${units[unit]}`;
}

interface LinkNodeSheetProps {
  nodeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLinked: () => void;
}

/**
 * Manual node_id -> Remnawave panel node linker: one tile per panel node.
 *
 * Requires an explicit pick from the admin every time: the panel holds
 * ~100 nodes (many stale, renamed, or duplicated), and node_id naming has
 * no reliable relationship to the panel's node name (spaces vs hyphens,
 * extra suffixes, and in at least one case a match only by IP, not name at
 * all). Auto-matching risked silently attaching stats to the wrong
 * physical server, which is worse than showing nothing.
 *
 * Each tile shows the panel's own live state (green/red dot) and,
 * separately, whether an agent is actually connected for that panel node
 * right now (linked_agent_connected, from the live WebSocket client map).
 * A DB row saying "linked" is not the same fact as an agent actually
 * talking to us, so the two stay visually distinct instead of being
 * collapsed into one assumed-good badge.
 */
export function LinkNodeSheet({ nodeId, open, onOpenChange, onLinked }: LinkNodeSheetProps) {
  const t = useTranslations("linkNode");
  const [options, setOptions] = useState<RemnaNodeOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"enabled" | "disabled" | "all">("enabled");
  const [linking, setLinking] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStatusFilter("enabled");
    setError(null);
    setLoading(true);
    authFetch("/api/remnawave/nodes/list")
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then((data: RemnaNodeOption[]) => setOptions(data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : t("genericError")))
      .finally(() => setLoading(false));
  }, [open, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => {
      if (statusFilter === "enabled" && o.is_disabled) return false;
      if (statusFilter === "disabled" && !o.is_disabled) return false;
      if (!q) return true;
      return (
        o.name.toLowerCase().includes(q) ||
        o.address.toLowerCase().includes(q) ||
        o.country_code.toLowerCase().includes(q)
      );
    });
  }, [options, query, statusFilter]);

  const link = async (uuid: string) => {
    setLinking(uuid);
    setError(null);
    try {
      const res = await authFetch("/api/nodes/link-remnawave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId, remna_uuid: uuid }),
      });
      if (!res.ok) throw new Error(await res.text());
      onLinked();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("genericError"));
    } finally {
      setLinking(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>{t("title", { node: nodeId })}</SheetTitle>
          <SheetDescription>{t("description")}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
          />

          <div className="flex gap-1">
            {(["enabled", "disabled", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setStatusFilter(f)}
                className={
                  statusFilter === f
                    ? "rounded-md bg-primary/15 px-2.5 py-1 text-xs font-medium text-primary"
                    : "rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
                }
              >
                {t(`filter_${f}`)}
              </button>
            ))}
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {filtered.length === 0 && (
                <p className="col-span-full py-6 text-center text-sm text-muted-foreground">
                  {t("noResults")}
                </p>
              )}
              {filtered.map((o) => {
                const linkedElsewhere = !!o.linked_to && o.linked_to !== nodeId;
                const linkedHere = o.linked_to === nodeId;
                const trafficPct =
                  o.traffic_total > 0 ? Math.min(100, (o.traffic_used / o.traffic_total) * 100) : null;

                return (
                  <button
                    key={o.uuid}
                    disabled={linking !== null || linkedElsewhere}
                    onClick={() => link(o.uuid)}
                    className={
                      linkedHere
                        ? "glass-tile flex flex-col gap-2 p-3 text-left ring-2 ring-primary/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        : "glass-tile flex flex-col gap-2 p-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                    }
                  >
                    <div className="flex items-center gap-2">
                      <FlagIcon countryCode={o.country_code} className="h-3.5 w-5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.name}</span>
                      <span
                        title={o.is_connected ? t("panelOnline") : t("panelOffline")}
                        className={
                          o.is_connected
                            ? "h-2 w-2 shrink-0 rounded-full bg-green-500"
                            : "h-2 w-2 shrink-0 rounded-full bg-red-500"
                        }
                      />
                      {linking === o.uuid && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
                    </div>

                    {o.tags && o.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {o.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="font-mono text-xs text-muted-foreground">
                      {o.address}
                      {o.port ? `:${o.port}` : ""}
                    </div>

                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>
                        {formatBytes(o.traffic_used)}
                        {o.traffic_total > 0 ? ` / ${formatBytes(o.traffic_total)}` : ` / ${t("unlimited")}`}
                      </span>
                      <span className="flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {o.users_online}
                      </span>
                    </div>

                    {trafficPct !== null && (
                      <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full rounded-full bg-primary/70"
                          style={{ width: trafficPct + "%" }}
                        />
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 text-xs">
                      {o.linked_to ? (
                        o.linked_agent_connected ? (
                          <span className="flex items-center gap-1 text-green-500">
                            <CircleCheck className="h-3.5 w-3.5" />
                            {t("agentConnected", { node: o.linked_to })}
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-amber-500">
                            <CircleAlert className="h-3.5 w-3.5" />
                            {t("agentNotResponding", { node: o.linked_to })}
                          </span>
                        )
                      ) : (
                        <span className="flex items-center gap-1 text-muted-foreground/50">
                          <WifiOff className="h-3.5 w-3.5" />
                          {t("noAgentLinked")}
                        </span>
                      )}
                    </div>

                    {o.is_disabled && (
                      <span className="text-[10px] text-muted-foreground/60">{t("disabledInPanel")}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
