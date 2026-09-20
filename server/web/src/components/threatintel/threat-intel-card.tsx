"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ShieldAlert } from "lucide-react";
import { useWsThreatIntel } from "@/contexts/websocket-context";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import Link from "next/link";
import { threatTypeConfig, sourceLabels } from "./config";
import { useTranslations } from "next-intl";

interface ThreatIntelCardProps {
  className?: string;
}

export function ThreatIntelCard({ className }: ThreatIntelCardProps) {
  const t = useTranslations("threatIntel");
  const tc = useTranslations("threatIntelCard");
  const { threatIntel, loading } = useWsThreatIntel();
  const { stats, matches: matchesRaw } = threatIntel;
  const matches = matchesRaw || [];

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[200px]" />
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-muted-foreground" />
            {t("title")}
          </CardTitle>
          <CardDescription>{tc("serviceUnavailable")}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
          {t("title")}
        </CardTitle>
        <CardDescription>
          {tc("summary", { total: stats.total_indicators.toLocaleString(), matches24h: stats.matches_24h })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {matches.length > 0 ? (
          <>
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm font-medium">{tc("recentMatches")}</span>
              <Badge variant="secondary" className="text-xs">
                {tc("latestCount", { count: matches.length })}
              </Badge>
            </div>
            <div className="space-y-2 max-h-[400px] overflow-y-auto scrollbar-thin pr-1">
              {matches.map((match) => {
                const config = threatTypeConfig[match.threat_type] || threatTypeConfig.malware;
                return (
                  <div
                    key={match.id}
                    className="flex items-start gap-3 p-2 rounded-lg bg-muted/50 border border-destructive/20 overflow-hidden"
                  >
                    <div className={`p-1.5 rounded ${config.color} text-white shrink-0`}>
                      {config.icon}
                    </div>
                    <div className="flex-1 min-w-0 overflow-hidden">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="destructive" className="text-xs">
                          {t(`categories.${config.label}` as Parameters<typeof t>[0])}
                        </Badge>
                        <Badge variant="outline" className="text-xs">
                          {match.confidence}%
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {sourceLabels[match.source]}
                        </span>
                      </div>
                      <p className="text-sm font-mono truncate mt-1 max-w-full">{match.destination}</p>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <Link
                          href={`/users/${encodeURIComponent(match.username || match.user_email || '')}`}
                          className="hover:underline truncate"
                        >
                          {match.username || match.user_email || tc("unknownUser")}
                        </Link>
                        <span>•</span>
                        <span className="whitespace-nowrap">{formatDistanceToNowRu(new Date(match.matched_at))}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <ShieldAlert className="h-12 w-12 mx-auto mb-2 opacity-20" />
            <p>{tc("noMatches")}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
