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
import { Copy, Check, Plus, Wifi, Loader2 } from "lucide-react";
import { NodeStats } from "@/lib/types";

interface InstallCommandResponse {
  node_id: string;
  server_url: string;
  command: string;
  already_connected: boolean;
}

/**
 * "Add node": generates the one-line install command rather than reaching
 * out over SSH itself. A panel that can push root-level install scripts to
 * every VPN node from a button click is a far bigger attack surface than one
 * that hands you a command to paste — see the earlier conversation about
 * this trade-off. You run it, the node dials in over the existing agent
 * WebSocket, and this panel just watches for it to appear.
 */
export function AddNodeDialog({ nodes }: { nodes: NodeStats[] }) {
  const t = useTranslations("addNode");
  const [open, setOpen] = useState(false);
  const [nodeId, setNodeId] = useState("");
  const [result, setResult] = useState<InstallCommandResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const connected = useMemo(
    () => !!result && nodes.some((n) => n.node_id === result.node_id && n.is_connected),
    [nodes, result]
  );

  const generate = async () => {
    const id = nodeId.trim().toLowerCase();
    if (!id) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await authFetch(`/api/nodes/install-command?node_id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(await res.text());
      const data: InstallCommandResponse = await res.json();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("genericError"));
    } finally {
      setLoading(false);
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

  // Reset the form each time the panel is (re)opened.
  useEffect(() => {
    if (open) {
      setNodeId("");
      setResult(null);
      setError(null);
    }
  }, [open]);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" />
        {t("trigger")}
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>{t("description")}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("nodeIdLabel")}</label>
              <div className="flex gap-2">
                <Input
                  value={nodeId}
                  onChange={(e) => setNodeId(e.target.value)}
                  placeholder="germany-2"
                  className="font-mono"
                  onKeyDown={(e) => e.key === "Enter" && generate()}
                />
                <Button onClick={generate} disabled={loading || !nodeId.trim()}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : t("generate")}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t("nodeIdHint")}</p>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {result && (
              <div className="space-y-3">
                {result.already_connected && (
                  <p className="text-xs text-yellow-600">{t("alreadyConnectedWarning")}</p>
                )}

                <div className="space-y-1.5">
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

                <p className="text-[11px] text-muted-foreground">{t("runHint")}</p>

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
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
