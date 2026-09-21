"use client";

import { useState, useEffect } from "react";
import { authFetch } from "@/contexts/auth-context";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Globe, Wifi } from "lucide-react";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { UserIPHistory } from "@/lib/types";
import { isValidDate } from "@/lib/utils/date";
import { useIPInfo, prefetchIPInfoBatch } from "@/components/ui/ip-info-badge";
import { useTranslations } from "next-intl";

// Country flag emoji from country code
function getFlagEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "";
  return String.fromCodePoint(
    ...[...countryCode.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0))
  );
}

interface UserIPHistoryTableProps {
  email: string;
}

export function UserIPHistoryTable({ email }: UserIPHistoryTableProps) {
  const tc = useTranslations("common");
  const [history, setHistory] = useState<UserIPHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchHistory() {
      try {
        setLoading(true);
        const res = await authFetch(`/api/users/${encodeURIComponent(email)}/ip-history`);
        if (!res.ok) throw new Error("Failed to fetch IP history");
        const data = await res.json();
        setHistory(data || []);
        // One batched lookup for every IP on the page instead of each
        // HistoryRow firing its own slow single-IP request in sequence.
        if (data && data.length > 0) {
          prefetchIPInfoBatch(data.map((ip: UserIPHistory) => ip.ip_address));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : tc("unknown"));
      } finally {
        setLoading(false);
      }
    }
    fetchHistory();
  }, [email]);

  if (loading) {
    return (
      <div className="space-y-2">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <p>{tc("ipHistoryLoadError")}: {error}</p>
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <Wifi className="h-8 w-8 opacity-30 mb-2" />
        <p>{tc("noIpHistory")}</p>
      </div>
    );
  }

  return (
    <div className="max-h-[400px] overflow-y-auto overflow-x-auto scrollbar-thin">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{tc("ipAddress")}</TableHead>
            <TableHead className="hidden sm:table-cell">{tc("location")}</TableHead>
            <TableHead className="hidden md:table-cell">{tc("node")}</TableHead>
            <TableHead className="text-right">{tc("requests")}</TableHead>
            <TableHead className="hidden lg:table-cell">{tc("firstSeen")}</TableHead>
            <TableHead>{tc("lastSeen")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {history.map((ip, index) => (
            <HistoryRow key={`${ip.ip_address}-${index}`} ip={ip} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// One row's IP address, geo lookup and everything else. A single
// useIPInfo() call here is shared by both the IP-address cell (always the
// literal address, never replaced by the city - IPInfoBadge's compact mode
// does that on purpose for space-constrained columns, which is wrong here)
// and the Location cell, instead of each cell re-fetching or duplicating
// IPInfoBadge's own internal fetch.
function HistoryRow({ ip }: { ip: UserIPHistory }) {
  const { info, loading } = useIPInfo(ip.ip_address);
  const flag = info?.country_code ? getFlagEmoji(info.country_code) : "";

  return (
    <TableRow>
      <TableCell>
        <span className="inline-flex items-center gap-1.5 font-mono text-sm">
          {flag && <span className="font-flag">{flag}</span>}
          <span>{ip.ip_address}</span>
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        {loading ? (
          <span className="text-muted-foreground text-sm">...</span>
        ) : info && info.country !== "Private" ? (
          <div className="flex items-center gap-1 text-sm">
            <span>{info.city || info.country}</span>
            {info.city && info.country && (
              <span className="text-muted-foreground">- {info.country}</span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">—</span>
        )}
      </TableCell>
      <TableCell className="hidden md:table-cell">
        {ip.node_id ? (
          <Badge variant="outline" className="text-xs">{ip.node_id}</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right">
        <Badge variant="secondary">{ip.request_count.toLocaleString()}</Badge>
      </TableCell>
      <TableCell className="hidden lg:table-cell text-muted-foreground text-sm">
        {isValidDate(ip.first_seen)
          ? formatDistanceToNowRu(new Date(ip.first_seen))
          : "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-sm whitespace-nowrap">
        {isValidDate(ip.last_seen)
          ? formatDistanceToNowRu(new Date(ip.last_seen))
          : "—"}
      </TableCell>
    </TableRow>
  );
}
