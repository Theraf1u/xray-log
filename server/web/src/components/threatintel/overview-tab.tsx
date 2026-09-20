"use client";

import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ThreatMatch, ThreatStats, FeedStatus, CategoryTopUsers, TimeStats, GeoSummary, AnomalySummary, UserRiskSummary, ReportSummary, ReportConfig } from "@/lib/types";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { threatTypeConfig, sourceLabels } from "./config";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { UserList } from "./user-list";
import { CategoryUsersSheet } from "./category-users-sheet";
import { MatchesTable } from "./matches-table";
import { TimeChart } from "./time-chart";
import { GeoChart } from "./geo-chart";
import { AnomalyPanel } from "./anomaly-panel";
import { RiskProfilePanel } from "./risk-profile-panel";
import { ReportsPanel } from "./reports-panel";
import { StatRail } from "@/components/ui/stat-rail";
import { Shield } from "lucide-react";

interface OverviewTabProps {
  stats: ThreatStats | null;
  feeds: FeedStatus[];
  topUsers: CategoryTopUsers | null;
  threatMatches: ThreatMatch[];
  timeStats: TimeStats | null;
  geoStats: GeoSummary | null;
  anomalies: AnomalySummary | null;
  riskProfiles: UserRiskSummary | null;
  reports: ReportSummary | null;
  onRiskRefresh?: () => void;
  onReportsRefresh?: () => void;
  onGenerateReport?: (config: ReportConfig) => Promise<void>;
  onDeleteReport?: (id: string) => Promise<void>;
}

export function OverviewTab({ stats, feeds, topUsers, threatMatches, timeStats, geoStats, anomalies, riskProfiles, reports, onRiskRefresh, onReportsRefresh, onGenerateReport, onDeleteReport }: OverviewTabProps) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const t = useTranslations("threatIntel");
  const activeFeeds = feeds.filter((f) => f.status === "ok").length;
  
  return (
    <div className="space-y-6">
      {/* Four bordered cards became one rail. */}
      <StatRail
        items={[
          {
            key: "totalIndicators",
            label: t("totalIndicators"),
            value: stats?.total_indicators || 0,
            hint: t("loadedFromFeeds"),
            motif: "database",
          },
          {
            key: "totalMatches",
            label: t("totalMatchesLabel"),
            value: stats?.total_matches || 0,
            hint: t("allTimeDetections"),
            tone: "bad",
            motif: "shield",
          },
          {
            key: "matches24h",
            label: t("matches24h"),
            value: stats?.matches_24h || 0,
            hint: t("last24Hours"),
            tone: (stats?.matches_24h || 0) > 0 ? "warn" : undefined,
            motif: "pulse",
          },
          {
            key: "activeFeeds",
            label: t("activeFeedsLabel"),
            value: `${activeFeeds}/${feeds.length}`,
            hint: t("feedsOnline"),
            dot: activeFeeds < feeds.length ? "warn" : "ok",
            motif: "nodes",
          },
        ]}
      />

      {/* Time-based Charts */}
      <TimeChart data={timeStats} />

      {/* Geographic Analysis */}
      <GeoChart data={geoStats} />

      {/* Feed Status */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-muted-foreground" />
            {t("feedStatus")}
          </CardTitle>
          <CardDescription>{t("feedStatusDesc")}</CardDescription>
        </CardHeader>
        <CardContent className="max-h-[350px] overflow-y-auto overflow-x-auto scrollbar-thin">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">{t("source")}</TableHead>
                <TableHead className="whitespace-nowrap">{t("status")}</TableHead>
                <TableHead className="text-right whitespace-nowrap hidden sm:table-cell">{t("indicators")}</TableHead>
                <TableHead className="whitespace-nowrap hidden md:table-cell">{t("lastUpdate")}</TableHead>
                <TableHead className="whitespace-nowrap hidden lg:table-cell">{t("nextUpdate")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {feeds.map((feed) => (
                <TableRow key={feed.source} className="hover:bg-muted/50 transition-colors">
                  <TableCell className="font-medium text-xs sm:text-sm">
                    {sourceLabels[feed.source] || feed.source}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={feed.status === "ok" ? "secondary" : "destructive"}
                      className={feed.status === "ok" ? "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30" : ""}
                    >
                      {feed.status === "ok" ? `✓ ${t("statusOk")}` : t("statusError")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right hidden sm:table-cell font-mono">
                    {feed.indicators.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell text-sm">
                    {feed.last_update
                      ? formatDistanceToNowRu(new Date(feed.last_update))
                      : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell text-sm">
                    {feed.next_update
                      ? formatDistanceToNowRu(new Date(feed.next_update))
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Recent Users by Content Category */}
      {topUsers && (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {(["porn", "gambling", "social", "fakenews", "torrent", "tor"] as const).map((category) => {
            const users = topUsers[category] || [];
            const config = threatTypeConfig[category];
            const totalCount = users.reduce((sum, u) => sum + u.match_count, 0);
            
            return (
              <Card key={category} className="overflow-hidden">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <div className={`p-1.5 rounded-md ${config.color}`}>
                        <span className="text-white">{config.icon}</span>
                      </div>
                      <CardTitle className="text-sm font-medium">{t(`categories.${config.label}` as Parameters<typeof t>[0])}</CardTitle>
                    </div>
                    {totalCount > 0 && (
                      <span className="text-xl font-bold">{totalCount}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">{t("topUsersCount", { count: 10 })}</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <UserList users={users.slice(0, 10)} maxHeight="320px" />
                  {users.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2 w-full"
                      onClick={() => setOpenCategory(category)}
                    >
                      {t("showAllUsers")}
                    </Button>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {openCategory && (
        <CategoryUsersSheet
          category={openCategory}
          label={t(`categories.${threatTypeConfig[openCategory as keyof typeof threatTypeConfig]?.label ?? openCategory}` as Parameters<typeof t>[0])}
          open={!!openCategory}
          onOpenChange={(next) => !next && setOpenCategory(null)}
        />
      )}

      {/* Anomaly Detection Panel */}
      <AnomalyPanel data={anomalies} />

      {/* User Risk Profiles Panel */}
      <RiskProfilePanel data={riskProfiles} onRefresh={onRiskRefresh} />

      {/* Reports & Exports Panel */}
      <ReportsPanel 
        reports={reports}
        onGenerate={onGenerateReport || (async () => {})}
        onRefresh={onReportsRefresh || (() => {})}
        onDelete={onDeleteReport}
      />

      {/* Recent Matches (all types) */}
      <MatchesTable
        matches={threatMatches}
        title={t("recentMatchesTitle")}
        description={t("recentMatchesDesc", { count: threatMatches?.length || 0 })}
      />
    </div>
  );
}
