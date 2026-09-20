"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ShieldAlert, RefreshCw, Download, Globe, Swords } from "lucide-react";
import { useWsThreatIntel } from "@/contexts/websocket-context";
import { useThreatIntelData } from "@/hooks/use-threat-intel-data";
import { useTranslations } from "next-intl";
import { OverviewTab } from "./overview-tab";
import { TorrentTab } from "./torrent-tab";
import { TorTab } from "./tor-tab";
import { AttacksPanel } from "./attacks-panel";

export function ThreatIntelPage() {
  const t = useTranslations("threatIntel");
  const { threatIntel, loading: wsLoading } = useWsThreatIntel();
  const {
    feeds,
    timeStats,
    geoStats,
    anomalies,
    riskProfiles,
    reports,
    loading: apiLoading,
    refreshRiskProfiles,
    refreshReports,
    generateReport,
    deleteReport,
  } = useThreatIntelData();
  
  const [activeTab, setActiveTab] = useState("overview");

  const stats = threatIntel.stats;
  const matches = threatIntel.matches || [];
  const topUsers = threatIntel.topUsers;
  const loading = wsLoading && apiLoading;

  if (loading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-[100px]" />
          ))}
        </div>
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* The connected/disconnected badge duplicated the WebSocket tile
          already in the header, so it is gone; the feed cadence became a
          plain hint under the title instead of competing chrome. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight sm:text-2xl">
            <ShieldAlert className="h-5 w-5 text-destructive sm:h-6 sm:w-6" />
            {t("title")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <RefreshCw className="h-3 w-3" />
          {t("feedsEvery")} 6 {t("hoursShort")}
        </span>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="grid w-full grid-cols-4 max-w-xl">
          <TabsTrigger value="overview" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
            <ShieldAlert className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {t("tabOverview")}
          </TabsTrigger>
          <TabsTrigger value="attacks" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
            <Swords className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {t("tabAttacks")}
          </TabsTrigger>
          <TabsTrigger value="torrent" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
            <Download className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            <span className="hidden xs:inline">{t("tabTorrent")}</span>
          </TabsTrigger>
          <TabsTrigger value="tor" className="flex items-center gap-1 sm:gap-2 text-xs sm:text-sm">
            <Globe className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
            {t("tabTor")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6">
          <OverviewTab 
            stats={stats}
            feeds={feeds}
            topUsers={topUsers}
            threatMatches={matches}
            timeStats={timeStats}
            geoStats={geoStats}
            anomalies={anomalies}
            riskProfiles={riskProfiles}
            reports={reports}
            onRiskRefresh={refreshRiskProfiles}
            onReportsRefresh={refreshReports}
            onGenerateReport={generateReport}
            onDeleteReport={deleteReport}
          />
        </TabsContent>

        <TabsContent value="attacks" className="mt-6">
          <AttacksPanel />
        </TabsContent>

        <TabsContent value="torrent" className="mt-6">
          <TorrentTab 
            topUsers={topUsers?.torrent || []}
            feeds={feeds.filter(f => 
              f.source === "torrent-trackers" || 
              f.source === "blocklist-torrent" || 
              f.source === "blocklist-piracy"
            )}
          />
        </TabsContent>

        <TabsContent value="tor" className="mt-6">
          <TorTab 
            topUsers={topUsers?.tor || []}
            feeds={feeds.filter(f => f.source === "tor-exit-nodes")}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
