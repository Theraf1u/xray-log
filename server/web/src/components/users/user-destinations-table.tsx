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
import { ChevronLeft, ChevronRight, Globe } from "lucide-react";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { isValidDate } from "@/lib/utils/date";
import { authFetch } from "@/contexts/auth-context";
import { PageSizeSelect, usePageSize } from "@/components/ui/page-size-select";
import { UserDestinationsResponse, TimeRange, ThreatType } from "@/lib/types";
import { threatTypeConfig } from "@/components/threatintel/config";

const blacklistBadge = { color: "bg-red-700", label: "блоклист" };  // module-level: no hook access

interface UserDestinationsTableProps {
  email: string;
}

export function UserDestinationsTable({ email }: UserDestinationsTableProps) {
  const tc = useTranslations("common");
  const ti = useTranslations("threatIntel");
  const [data, setData] = useState<UserDestinationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<TimeRange>("24h");
  const [pageSize, setPageSize] = usePageSize(25);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/users/${encodeURIComponent(email)}/destinations?page=${page}&page_size=${pageSize}&period=${period}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (error) {
      console.error("Failed to fetch destinations:", error);
    } finally {
      setLoading(false);
    }
  }, [email, page, period, pageSize]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    setPage(1);
  }, [period]);

  if (loading && !data) {
    return (
      <div className="space-y-3">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  }

  if (!data || data.destinations.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        {tc("noDestinationsForPeriod")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {tc("destinationsCount", { count: data.total })}
          </span>
        </div>
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
          </SelectContent>
        </Select>
      </div>

      <div className="max-h-[400px] overflow-y-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tc("destination")}</TableHead>
              <TableHead>{tc("categories")}</TableHead>
              <TableHead>{tc("node")}</TableHead>
              <TableHead className="text-right">{tc("requests")}</TableHead>
              <TableHead>{tc("lastVisit")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.destinations.map((dest, idx) => (
              <TableRow key={`${dest.destination}-${dest.node_id}-${idx}`}>
                <TableCell className="font-mono text-sm max-w-[300px] truncate">
                  {dest.destination}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {(dest.categories ?? []).map((cat) => {
                      const cfg = cat === "blacklist"
                        ? blacklistBadge
                        : threatTypeConfig[cat as ThreatType];
                      return (
                        <Badge
                          key={cat}
                          className={`${cfg?.color ?? "bg-gray-500"} text-white text-[10px] px-1.5 py-0`}
                        >
                          {cat === "blacklist" ? cfg?.label : ti(`categories.${cfg?.label ?? cat}` as Parameters<typeof ti>[0])}
                        </Badge>
                      );
                    })}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{dest.node_id}</Badge>
                </TableCell>
                <TableCell className="text-right font-medium">
                  {dest.request_count.toLocaleString()}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {isValidDate(dest.last_seen)
                    ? formatDistanceToNowRu(new Date(dest.last_seen))
                    : "—"
                  }
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
