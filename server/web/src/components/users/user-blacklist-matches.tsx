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
import { ChevronLeft, ChevronRight, ShieldAlert } from "lucide-react";

import { isValidDate, formatRu } from "@/lib/utils/date";
import { authFetch } from "@/contexts/auth-context";
import { PageSizeSelect, usePageSize } from "@/components/ui/page-size-select";
import { BlacklistMatchInfo, TimeRange } from "@/lib/types";

interface PaginatedBlacklistResponse {
  matches: BlacklistMatchInfo[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

interface UserBlacklistMatchesProps {
  email: string;
}

export function UserBlacklistMatches({ email }: UserBlacklistMatchesProps) {
  const tc = useTranslations("common");
  const [data, setData] = useState<PaginatedBlacklistResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [period, setPeriod] = useState<TimeRange>("24h");
  const [pageSize, setPageSize] = usePageSize(25);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(
        `/api/users/${encodeURIComponent(email)}/blacklist?page=${page}&page_size=${pageSize}&period=${period}`
      );
      if (res.ok) {
        const json = await res.json();
        setData(json);
      }
    } catch (error) {
      console.error("Failed to fetch blacklist matches:", error);
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

  if (!data || data.matches.length === 0) {
    return (
      <div className="text-center text-muted-foreground py-8">
        {tc("noBlacklistMatchesForPeriod")}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-destructive" />
          <span className="text-sm text-muted-foreground">
            {tc("blockedRequestsCount", { count: data.total })}
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
              <TableHead>{tc("time")}</TableHead>
              <TableHead>{tc("node")}</TableHead>
              <TableHead>{tc("sourceIp")}</TableHead>
              <TableHead>{tc("destination")}</TableHead>
              <TableHead>{tc("matchedRule")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.matches.map((match, idx) => (
              <TableRow key={`${match.timestamp}-${match.destination}-${idx}`}>
                <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
                  {isValidDate(match.timestamp)
                    ? formatRu(new Date(match.timestamp), "MMM d, HH:mm:ss")
                    : "—"
                  }
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{match.node_id}</Badge>
                </TableCell>
                <TableCell className="font-mono text-sm">
                  {match.source_ip}
                </TableCell>
                <TableCell className="max-w-[200px] truncate font-mono text-sm text-destructive">
                  {match.destination}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {match.matched_rule}
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
