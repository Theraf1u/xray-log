"use client";

import { useState, useCallback } from "react";
import { authFetch } from "@/contexts/auth-context";
import { useWsNodes } from "@/contexts/websocket-context";
import { NodesTable } from "@/components/nodes/nodes-table";
import { AddNodeDialog } from "@/components/nodes/add-node-dialog";
import { StatRail } from "@/components/ui/stat-rail";
import { Skeleton } from "@/components/ui/skeleton";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export default function NodesPage() {
  const t = useTranslations("nodesPage");
  const { nodes, loading } = useWsNodes();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const deleteNode = useCallback(async (nodeId: string) => {
    try {
      const res = await authFetch("/api/nodes/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: nodeId }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteNode(deleteTarget);
    setDeleting(false);
    setDeleteTarget(null);
  };

  const onlineNodes = nodes.filter(n => n.is_connected);
  const offlineNodes = nodes.filter(n => !n.is_connected);

  if (loading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* The Live/Disconnected badge that used to sit here duplicated the
          WebSocket tile already in the header, so it is gone. */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <AddNodeDialog nodes={nodes} />
      </div>

      <StatRail
        columns={3}
        items={[
          { key: "total", label: t("totalNodes"), value: nodes.length, motif: "nodes" },
          {
            key: "online",
            label: t("online"),
            value: onlineNodes.length,
            tone: "ok",
            dot: onlineNodes.length > 0 ? "ok" : undefined,
            motif: "pulse",
          },
          {
            key: "offline",
            label: t("offline"),
            value: offlineNodes.length,
            dot: offlineNodes.length > 0 ? "warn" : undefined,
            motif: "globe",
          },
        ]}
      />

      {nodes.length > 0 && (
        <NodesTable nodes={nodes} showActions onDelete={setDeleteTarget} />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteNodeTitle", { node: deleteTarget ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteNodeDesc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? t("deleting") : t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
