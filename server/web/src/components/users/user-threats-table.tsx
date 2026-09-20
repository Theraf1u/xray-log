"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { isValidDate } from "@/lib/utils/date";
import { authFetch } from "@/contexts/auth-context";
import { PageSizeSelect, usePageSize } from "@/components/ui/page-size-select";
import { TimeRange, UserThreatInfo } from "@/lib/types";

interface PaginatedThreatsResponse {
  matches: UserThreatInfo[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

interface UserThreatsTableProps {
  email: string;
  threatType: string;
}

export function UserThreatsTable({ email, threatType }: UserThreatsTableProps) {
  const t = useTranslations("users");
  const tc = useTranslations("common");
  const [data, setData] = useState<PaginatedThreatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<TimeRange>("24h");
  const [pageSize, setPageSize] = usePageSize(25);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/users/${encodeURIComponent(email)}/threats?type=${encodeURIComponent(threatType)}&page=${page}&page_size=${pageSize}&period=${period}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (error) {
      console.error("Failed to fetch threat matches:", error);
    } finally {
      setLoading(false);
    }
  }, [email, threatType, page, period, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setPage(1);
  }, [period, threatType]);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  if (!data || data.matches.length === 0) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <Select value={period} onValueChange={(v) => setPeriod(v as TimeRange)}>
            <SelectTrigger className="w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1h">{tc("period1h")}</SelectItem>
              <SelectItem value="6h">{tc("period6h")}</SelectItem>
              <SelectItem value="24h">{tc("period24h")}</SelectItem>
              <SelectItem value="7d">{tc("period7d")}</SelectItem>
              <SelectItem value="30d">{tc("period30d")}</SelectItem>
              <SelectItem value="all">{tc("periodAll")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <p className="text-sm text-muted-foreground py-4 text-center">{tc("noDataForPeriod")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{tc("matchesCount", { count: data.total })}</span>
        <Select value={period} onValueChange={(v) => setPeriod(v as TimeRange)}>
          <SelectTrigger className="w-[120px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1h">{tc("period1h")}</SelectItem>
            <SelectItem value="6h">{tc("period6h")}</SelectItem>
            <SelectItem value="24h">{tc("period24h")}</SelectItem>
            <SelectItem value="7d">{tc("period7d")}</SelectItem>
            <SelectItem value="30d">{tc("period30d")}</SelectItem>
            <SelectItem value="all">{tc("periodAll")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="max-h-[400px] overflow-y-auto overflow-x-auto scrollbar-thin">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="whitespace-nowrap">{t("threatTime")}</TableHead>
              <TableHead>{t("threatDestination")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("threatSource")}</TableHead>
              <TableHead className="text-right hidden sm:table-cell">{t("threatConf")}</TableHead>
              <TableHead className="hidden lg:table-cell">{t("threatNode")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.matches.map((row, i) => (
              <TableRow key={i}>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {isValidDate(row.matched_at)
                    ? formatDistanceToNowRu(new Date(row.matched_at))
                    : "—"}
                </TableCell>
                <TableCell className="font-mono text-xs max-w-[260px] truncate" title={row.destination}>
                  {row.destination}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground hidden md:table-cell">
                  {row.source}
                </TableCell>
                <TableCell className="text-right hidden sm:table-cell">
                  <span className={row.confidence >= 90 ? "text-destructive" : row.confidence >= 75 ? "text-orange-500" : ""}>
                    {row.confidence}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Badge variant="outline" className="text-xs">{row.node_id}</Badge>
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
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.max(1, p - 1))} disabled={page === 1 || loading}>
              <ChevronLeft className="h-4 w-4" />
              {tc("previous")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPage(p => Math.min(data.total_pages, p + 1))} disabled={page >= data.total_pages || loading}>
              {tc("next")}
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
