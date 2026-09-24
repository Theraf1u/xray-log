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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FlagIcon } from "@/components/ui/flag-icon";
import { Copy, Check, Plus, Wifi, Loader2, ArrowLeft, KeyRound, X } from "lucide-react";
import { NodeStats, RemnaNodeOption, PairingRequest } from "@/lib/types";

interface InstallCommandResponse {
  node_id: string;
  server_url: string;
  command: string;
  already_connected: boolean;
}

interface PairedResult {
  node_id: string;
}

// Five views rather than a 2x2 matrix of toggles: "already linked" nodes
// are noise for the primary job here (picking a node to become a NEW
// agent), so they're excluded from every filter except the last one,
// which exists purely to look them up (re-fetch a lost command, confirm
// what's already wired up) rather than to pick from.
type NodeFilter = "enabled_unlinked" | "disabled_unlinked" | "all_unlinked" | "all" | "linked";

/**
 * "Add node": pick which Remnawave panel node this new agent physically is,
 * rather than typing an arbitrary name. Picking one immediately links it
 * (see node_remna_map / handleCreateNodeFromPanel) — before any agent
 * exists — so the moment the generated command runs and the agent
 * connects, the tile already shows full panel data (address, traffic,
 * flag) instead of sitting unlinked until someone links it by hand
 * afterward.
 *
 * Generates a copy-paste install command rather than reaching out over SSH
 * itself. A panel that can push root-level install scripts to every VPN
 * node from a button click is a far bigger attack surface than one that
 * hands you a command to paste — see the earlier conversation about this
 * trade-off. You run it, the node dials in over the existing agent
 * WebSocket, and this panel just watches for it to appear.
 */
export function AddNodeDialog({ nodes }: { nodes: NodeStats[] }) {
  const t = useTranslations("addNode");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<RemnaNodeOption[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<NodeFilter>("enabled_unlinked");
  const [picking, setPicking] = useState<string | null>(null);
  const [result, setResult] = useState<InstallCommandResponse | null>(null);
  const [pairedResult, setPairedResult] = useState<PairedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingPairings, setPendingPairings] = useState<PairingRequest[]>([]);
  const [activeCode, setActiveCode] = useState<string | null>(null);
  const [showCommand, setShowCommand] = useState(false);

  // The server already knows at generation time whether an agent for this
  // node_id is live (result.already_connected) — most often because it was
  // deleted and re-picked while its container kept running and retrying in
  // the background, so it reconnects the instant the tombstone lifts,
  // sometimes before the admin even sees the command. Trusting that flag
  // up front avoids ever showing "waiting for connection..." next to a
  // node that's already connected — the two used to render at once and
  // looked like a race/bug rather than the two takes on the same fact
  // they actually are.
  const connectedLive = useMemo(
    () => !!result && nodes.some((n) => n.node_id === result.node_id && n.is_connected),
    [nodes, result]
  );
  const connected = !!result && (result.already_connected || connectedLive);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setStatusFilter("enabled_unlinked");
    setResult(null);
    setPairedResult(null);
    setActiveCode(null);
    setError(null);
    setShowCommand(false);
    setLoadingOptions(true);
    // Refresh remna_nodes from the Remnawave panel before listing options —
    // the background sync runs on its own interval (REMNAWAVE_SYNC_INTERVAL,
    // often a full minute), so without this the picker could show a node
    // list that's already stale by the time someone opens it. Best-effort:
    // if the sync call fails (Remnawave down, timeout), fall through to
    // whatever the last background sync left in remna_nodes rather than
    // blocking the picker on it.
    authFetch("/api/remnawave/nodes/sync", { method: "POST" })
      .catch(() => {})
      .then(() =>
        authFetch("/api/remnawave/nodes/list").then(async (res) => {
          if (!res.ok) throw new Error(await res.text());
          return res.json();
        })
      )
      .then((data: RemnaNodeOption[]) => setOptions(data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : t("genericError")))
      .finally(() => setLoadingOptions(false));
    authFetch("/api/nodes/pair/pending")
      .then(async (res) => (res.ok ? ((await res.json()) as PairingRequest[]) : []))
      .then((data) => setPendingPairings(data ?? []))
      .catch(() => setPendingPairings([]));
  }, [open, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return options.filter((o) => {
      const isLinked = !!o.linked_to;
      switch (statusFilter) {
        case "enabled_unlinked":
          if (o.is_disabled || isLinked) return false;
          break;
        case "disabled_unlinked":
          if (!o.is_disabled || isLinked) return false;
          break;
        case "all_unlinked":
          if (isLinked) return false;
          break;
        case "linked":
          if (!isLinked) return false;
          break;
        case "all":
          break;
      }
      if (!q) return true;
      return (
        o.name.toLowerCase().includes(q) ||
        o.address.toLowerCase().includes(q) ||
        o.country_code.toLowerCase().includes(q)
      );
    });
  }, [options, query, statusFilter]);

  const pick = async (uuid: string) => {
    setPicking(uuid);
    setError(null);
    try {
      if (activeCode) {
        const res = await authFetch("/api/nodes/pair/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: activeCode, remna_uuid: uuid }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data: PairedResult = await res.json();
        setPairedResult(data);
        setPendingPairings((prev) => prev.filter((p) => p.Code !== activeCode));
      } else {
        const res = await authFetch("/api/nodes/create-from-panel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ remna_uuid: uuid }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data: InstallCommandResponse = await res.json();
        setResult(data);
        setShowCommand(!data.already_connected);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("genericError"));
    } finally {
      setPicking(null);
    }
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can be denied (insecure context, permissions); the
      // command is still selectable text in the code block either way.
    }
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t("trigger")}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>
              {result
                ? t("titleResult", { node: result.node_id })
                : pairedResult
                  ? t("titlePaired", { node: pairedResult.node_id })
                  : t("title")}
            </SheetTitle>
            <SheetDescription>
              {result ? t("runHint") : pairedResult ? t("pairedHint") : t("description")}
            </SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4">
            {error && <p className="text-sm text-destructive">{error}</p>}

            {pairedResult ? (
              <div className="space-y-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setPairedResult(null);
                    setActiveCode(null);
                  }}
                  className="h-7 px-2 text-xs"
                >
                  <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                  {t("pickAnother")}
                </Button>
                <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600">
                  <Check className="h-4 w-4 shrink-0" />
                  {t("pairedConfirmed", { node: pairedResult.node_id })}
                </div>
              </div>
            ) : result ? (
              <div className="space-y-3">
                <Button variant="ghost" size="sm" onClick={() => setResult(null)} className="h-7 px-2 text-xs">
                  <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
                  {t("pickAnother")}
                </Button>

                {result.already_connected ? (
                  <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600">
                    <Check className="h-4 w-4 shrink-0" />
                    {t("alreadyConnected", { node: result.node_id })}
                  </div>
                ) : (
                  <div
                    className={
                      connected
                        ? "flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-600"
                        : "flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground"
                    }
                  >
                    {connected ? <Check className="h-4 w-4 shrink-0" /> : <Wifi className="h-4 w-4 shrink-0 animate-pulse" />}
                    {connected ? t("connected", { node: result.node_id }) : t("waitingForConnection")}
                  </div>
                )}

                {result.already_connected && !showCommand ? (
                  <button
                    onClick={() => setShowCommand(true)}
                    className="text-xs text-muted-foreground underline decoration-dotted hover:text-foreground"
                  >
                    {t("showReinstallCommand")}
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    {result.already_connected && (
                      <p className="text-xs text-muted-foreground">{t("reinstallHint")}</p>
                    )}
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-medium text-muted-foreground">{t("commandLabel")}</label>
                      <Button variant="ghost" size="sm" className="h-7 px-2" onClick={copy}>
                        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                        <span className="ml-1.5 text-xs">{copied ? t("copied") : t("copy")}</span>
                      </Button>
                    </div>
                    <pre className="glass-inset overflow-x-auto whitespace-pre-wrap break-all p-3 font-mono text-xs">
                      {result.command}
                    </pre>
                  </div>
                )}
              </div>
            ) : (
              <>
                {pendingPairings.length > 0 && !activeCode && (
                  <div className="space-y-1.5 rounded-lg border border-primary/20 bg-primary/5 p-2.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-primary">
                      <KeyRound className="h-3.5 w-3.5" />
                      {t("pendingCodesTitle")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {pendingPairings.map((p) => (
                        <button
                          key={p.Code}
                          onClick={() => setActiveCode(p.Code)}
                          className="rounded-md bg-white/5 px-2.5 py-1.5 text-left text-xs hover:bg-white/10"
                        >
                          <span className="font-mono font-semibold">{p.Code}</span>
                          {p.Hint && <span className="ml-1.5 text-muted-foreground">{p.Hint}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {activeCode && (
                  <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-sm">
                    <span>
                      {t("approvingCode", { code: activeCode })}
                    </span>
                    <button onClick={() => setActiveCode(null)} className="text-muted-foreground hover:text-foreground">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}

                <Input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                />

                <div className="flex flex-wrap gap-1">
                  {(["enabled_unlinked", "disabled_unlinked", "all_unlinked", "all", "linked"] as const).map((f) => (
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

                {loadingOptions ? (
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
                    {filtered.map((o) => (
                      <button
                        key={o.uuid}
                        disabled={picking !== null}
                        onClick={() => pick(o.uuid)}
                        className="glass-tile flex flex-col gap-2 p-3 text-left transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <div className="flex items-center gap-2">
                          <FlagIcon countryCode={o.country_code} className="h-3.5 w-5 shrink-0" />
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">{o.name}</span>
                          {picking === o.uuid && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />}
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

                        {o.linked_to && (
                          <span className="text-[11px] text-primary/80">
                            {t("alreadyAdded", { node: o.linked_to })}
                          </span>
                        )}
                        {o.is_disabled && (
                          <span className="text-[10px] text-muted-foreground/60">{t("disabledInPanel")}</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
