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
import { IPInfoBadge } from "@/components/ui/ip-info-badge";
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
            <TableRow key={`${ip.ip_address}-${index}`}>
              <TableCell>
                {ip.country_code ? (
                  // Use pre-fetched geo data from backend
                  <span className="inline-flex items-center gap-1.5 font-mono text-sm">
                    <span className="font-flag">{getFlagEmoji(ip.country_code)}</span>
                    <span>{ip.ip_address}</span>
                  </span>
                ) : (
                  // Fallback to IPInfoBadge for IPs without geo data
                  <IPInfoBadge ip={ip.ip_address} />
                )}
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {ip.country_code ? (
                  <div className="flex items-center gap-1 text-sm">
                    <span>{ip.country_name || ip.country_code}</span>
                    {ip.city && (
                      <span className="text-muted-foreground">• {ip.city}</span>
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
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
