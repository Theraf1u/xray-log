"use client";

import { useState, useEffect, useCallback } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ChevronLeft, ChevronRight, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";

import { formatDistanceToNowRu, formatRu } from "@/lib/utils/date";
import { isValidDate } from "@/lib/utils/date";
import { PaginatedAlertsResponse } from "@/lib/types";
import { PageSizeSelect, usePageSize } from "@/components/ui/page-size-select";

interface UserAlertsTableProps {
  email: string;
}

export function UserAlertsTable({ email }: UserAlertsTableProps) {
  const tc = useTranslations("common");
  const [data, setData] = useState<PaginatedAlertsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(25);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/users/${encodeURIComponent(email)}/alerts?page=${page}&page_size=${pageSize}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (error) {
      console.error("Failed to fetch alerts:", error);
    } finally {
      setLoading(false);
    }
  }, [email, page, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  if (!data || data.alerts.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        {tc("noAlertsForUser")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-destructive" />
        <span className="text-sm text-muted-foreground">
          {tc("totalAlertsCount", { count: data.total })}
        </span>
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc("time")}</TableHead>
              <TableHead>{tc("type")}</TableHead>
              <TableHead>{tc("node")}</TableHead>
              <TableHead>{tc("message")}</TableHead>
              <TableHead>{tc("status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.alerts.map((alert) => (
              <TableRow key={alert.id}>
                <TableCell className="text-sm whitespace-nowrap">
                  {isValidDate(alert.created_at) ? (
                    <span title={formatRu(new Date(alert.created_at), "PPpp")}>
                      {formatDistanceToNowRu(new Date(alert.created_at))}
                    </span>
                  ) : "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="destructive">{alert.type}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{alert.node_id}</Badge>
                </TableCell>
                <TableCell className="max-w-[300px] truncate text-sm">
                  {alert.message}
                </TableCell>
                <TableCell>
                  {alert.sent ? (
                    <Badge variant="secondary">{tc("sent")}</Badge>
                  ) : (
                    <Badge variant="outline">{tc("pending")}</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {data.total_pages > 1 && (
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-4">
            <span className="text-sm text-muted-foreground">
              {tc("pageOf", { page: data.page, total: data.total_pages })}
            </span>
            <PageSizeSelect value={pageSize} onChange={(size) => { setPageSize(size); setPage(1); }} disabled={loading} />
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1 || loading}
            >
              <ChevronLeft className="h-4 w-4" />
              {tc("previous")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(p => Math.min(data.total_pages, p + 1))}
              disabled={page >= data.total_pages || loading}
            >
              {tc("next")}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
