"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { authFetch } from "@/contexts/auth-context";
import { useWebSocket, useWsThreatIntel } from "@/contexts/websocket-context";
import { useThreatIntelData } from "@/hooks/use-threat-intel-data";
import { VitalsRail } from "@/components/dashboard/vitals-rail";
import { ActivityChart } from "@/components/dashboard/activity-chart";
import { AnomaliesCard } from "@/components/dashboard/anomalies-card";
import { RecentBlocks } from "@/components/dashboard/recent-blocks";
import { NodesTable } from "@/components/nodes/nodes-table";
import { ThreatIntelCard } from "@/components/threatintel/threat-intel-card";
import { ActivityHeatmap } from "@/components/dashboard/activity-heatmap";
import { GeoMap, CityData } from "@/components/dashboard/geo-map";
import { TopOffenders } from "@/components/dashboard/top-offenders";
import { RealTimeFeed, FeedEvent, EventType } from "@/components/dashboard/real-time-feed";
import { TrafficDistribution } from "@/components/dashboard/traffic-distribution";
import { AlertsSummary, Alert } from "@/components/dashboard/alerts-summary";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { RefreshCw, ShieldAlert, Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { BlacklistMatchInfo, StatsAnomaly } from "@/lib/types";

export default function DashboardPage() {
  const t = useTranslations();
  const tThreat = useTranslations("threatIntel");
  const tQuick = useTranslations("quickActions");
  const { stats, nodes, hourly, anomalies, blacklist, loading } = useWebSocket();
  const { threatIntel } = useWsThreatIntel();
  // HTTP-polled copy as a fallback: WS may take up to 10s to push the first
  // threatintel frame after (re)connect, and the feed loader itself can be
  // slow on cold start. The HTTP endpoint reads the same stats and
  // guarantees the threat-intel views see live numbers within a refresh interval.
  const { stats: tiStatsHTTP } = useThreatIntelData();
  
  // State for additional data
  const [geoData, setGeoData] = useState<Array<{ country: string; country_code: string; count: number; users: number }>>([]);
  const [cityData, setCityData] = useState<CityData[]>([]);
  const [topOffenders, setTopOffenders] = useState<Array<{ user_email: string; blacklist_hits: number; risk_score?: number }>>([]);
  const [feedEvents, setFeedEvents] = useState<FeedEvent[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [dbAlerts, setDbAlerts] = useState<Alert[]>([]);
  const [remnawaveStatus, setRemnawaveStatus] = useState<"online" | "offline" | "unknown">("unknown");
  const [remnawaveEnabled, setRemnawaveEnabled] = useState<boolean>(true);
  const [remnawaveLastSync, setRemnawaveLastSync] = useState<string | undefined>();
  const [onlineHistory, setOnlineHistory] = useState<Array<{hour: string; online_users: number}>>([]);
  // HTTP fallback for core stats. WS broadcast skips ticks under SQLite
  // write contention; falling back to /api/stats (which is Redis-cached)
  // keeps the Dashboard cards populated even while the WS queue drains.
  const [statsHTTP, setStatsHTTP] = useState<typeof stats | null>(null);
  
  // Fetch additional dashboard data.
  // All 6 endpoints are independent → Promise.all. Previously they ran
  // sequentially so a single slow one (usually threatintel/geo-stats on a
  // cold cache) bottlenecked every other card's first paint.
  useEffect(() => {
    const safeJson = async (url: string) => {
      try {
        const res = await authFetch(url);
        if (!res.ok) return null;
        return await res.json();
      } catch {
        return null;
      }
    };

    const fetchDashboardData = async () => {
      const [geo, cities, offenders, online, remna, alerts, coreStats] = await Promise.all([
        safeJson("/api/threatintel/geo-stats?type=connections&limit=50"),
        safeJson("/api/threatintel/geo-stats?type=cities&limit=200"),
        safeJson("/api/users"),
        safeJson("/api/online-history?since=24h"),
        safeJson("/api/remnawave/stats"),
        safeJson("/api/alerts?limit=20"),
        safeJson("/api/stats"),
      ]);
      if (coreStats) {
        setStatsHTTP(coreStats);
      }

      if (geo?.top_countries) {
        setGeoData(
          geo.top_countries.map((c: { country_code: string; country_name: string; total_matches: number; unique_users: number }) => ({
            country: c.country_name || c.country_code,
            country_code: c.country_code,
            count: c.total_matches,
            users: c.unique_users,
          })),
        );
      }

      if (cities?.cities) {
        setCityData(
          cities.cities.map((c: { city: string; country_code: string; country_name: string; latitude: number; longitude: number; connections: number; unique_users: number }) => ({
            city: c.city,
            country: c.country_name || c.country_code,
            country_code: c.country_code,
            count: c.connections,
            users: c.unique_users,
            latitude: c.latitude,
            longitude: c.longitude,
          })),
        );
      }

      if (Array.isArray(offenders)) {
        const topUsers = offenders
          .filter((u: { blacklist_hits: number }) => u.blacklist_hits > 0)
          .slice(0, 5)
          .map((u: { username: string; blacklist_hits: number }) => ({
            user_email: u.username,
            blacklist_hits: u.blacklist_hits,
          }));
        setTopOffenders(topUsers);
      }

      if (online?.points) {
        setOnlineHistory(online.points);
      }

      if (remna) {
        setRemnawaveEnabled(remna.enabled ?? false);
        if (remna.enabled) {
          // Trust the server's own health verdict. The old check was
          // `totalUsers > 0`, which reported the panel as offline for the whole
          // first sync after every restart, when the cache is simply not filled
          // yet. "loading" maps to "unknown" so the tile shows "Проверка...".
          setRemnawaveStatus(
            remna.status === "online"
              ? "online"
              : remna.status === "loading"
                ? "unknown"
                : "offline"
          );
          setRemnawaveLastSync(remna.lastSync);
        } else {
          setRemnawaveStatus("offline");
        }
      } else {
        setRemnawaveEnabled(false);
        setRemnawaveStatus("offline");
      }

      if (Array.isArray(alerts)) {
        const mappedAlerts: Alert[] = alerts.map((a: { id: number; type: string; user_email: string; destination: string; count: number; message: string; created_at: string; sent: boolean }) => ({
          id: `db-${a.id}`,
          title: a.type === "blacklist_threshold" ? `🚨 ${t("nav.blacklist")}: ${a.user_email}` : `⚠️ ${a.type}`,
          description: a.destination ? `${a.count}x → ${a.destination}` : `${a.count} ${t("blacklist.hits").toLowerCase()}`,
          severity: a.count >= 10 ? "critical" as const : a.count >= 5 ? "high" as const : "medium" as const,
          timestamp: a.created_at,
          read: a.sent,
          link: `/users/${encodeURIComponent(a.user_email)}`,
        }));
        setDbAlerts(mappedAlerts);
      }
    };

    fetchDashboardData();
    const interval = setInterval(fetchDashboardData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Convert blacklist matches to feed events
  useEffect(() => {
    const newEvents: FeedEvent[] = [];
    
    // Add blacklist events
    blacklist?.recent_matches?.slice(0, 10).forEach((match: BlacklistMatchInfo, index: number) => {
      newEvents.push({
        id: `bl-${match.timestamp}-${index}`,
        type: "blacklist_hit" as EventType,
        message: `Blocked: ${match.destination}`,
        details: match.display_name || match.user_email,
        timestamp: match.timestamp,
        severity: "warning",
      });
    });
    
    // Add threat intel events
    threatIntel.matches?.slice(0, 10).forEach((match) => {
      newEvents.push({
        id: `ti-${match.id}`,
        type: "threat_match" as EventType,
        message: `Threat: ${match.destination}`,
        details: `${match.threat_type} - ${match.username || match.user_email}`,
        timestamp: match.matched_at,
        severity: "error",
      });
    });
    
    // Add anomaly events
    anomalies?.slice(0, 5).forEach((anomaly: StatsAnomaly) => {
      newEvents.push({
        id: `an-${anomaly.hour}-${anomaly.type}`,
        type: "anomaly" as EventType,
        message: anomaly.message,
        details: anomaly.user_email,
        timestamp: anomaly.hour,
        severity: "warning",
      });
    });
    
    // Sort by timestamp
    newEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    setFeedEvents(newEvents.slice(0, 50));
  }, [blacklist?.recent_matches, threatIntel.matches, anomalies]);

  // Generate alerts from threat intel categories + merge with database alerts
  useEffect(() => {
    const newAlerts: Alert[] = [];
    const topUsers = threatIntel.topUsers;

    // Category labels and severity config
    const categoryConfig: Record<string, { label: string; severity: "critical" | "high" | "medium"; icon: string }> = {
      tor: { label: "🌐 Tor", severity: "critical", icon: "🌐" },
      torrent: { label: "📥 Torrent", severity: "high", icon: "📥" },
      porn: { label: `🔞 ${tThreat("categories.porn")}`, severity: "high", icon: "🔞" },
      gambling: { label: `🎰 ${tThreat("categories.gambling")}`, severity: "high", icon: "🎰" },
      malware: { label: "🦠 Malware", severity: "critical", icon: "🦠" },
    };

    // Generate alerts for recent users in each category (if topUsers available)
    if (topUsers) {
      const categories = ["tor", "torrent", "porn", "gambling", "malware"] as const;
      
      categories.forEach(category => {
        const users = topUsers[category] || [];
        const config = categoryConfig[category];
        
        // Take last 3 users from each category
        users.slice(0, 3).forEach((user, idx) => {
          const displayName = user.username || user.user_email;
          const domains = user.domains?.slice(0, 2).join(", ") || "";
          
          newAlerts.push({
            id: `threat-${category}-${user.user_email}-${idx}`,
            title: `${config.label}: ${displayName}`,
            description: domains ? `→ ${domains}` : `${user.match_count} ${t("blacklist.hits").toLowerCase()}`,
            severity: config.severity,
            timestamp: new Date().toISOString(), // Recent activity
            read: false,
            link: `/users/${encodeURIComponent(user.user_email)}`,
          });
        });
      });
    }

    // Add database alerts
    newAlerts.push(...dbAlerts);
    
    // Sort by severity (critical first, then high), then by timestamp
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    newAlerts.sort((a, b) => {
      const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
      if (sevDiff !== 0) return sevDiff;
      return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
    });
    
    // Remove duplicates by id and limit
    const seen = new Set<string>();
    const uniqueAlerts = newAlerts.filter(a => {
      if (seen.has(a.id)) return false;
      seen.add(a.id);
      return true;
    });
    
    setAlerts(uniqueAlerts.slice(0, 20));
  }, [threatIntel.topUsers, dbAlerts]);

  // Quick action handlers
  const handleSyncRemnawave = useCallback(async () => {
    try {
      const token = localStorage.getItem("xray_auth_token");
      await authFetch("/api/remnawave/sync", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (error) {
      console.error("Sync failed:", error);
    }
  }, []);

  const handleRefreshBlacklist = useCallback(async () => {
    try {
      const token = localStorage.getItem("xray_auth_token");
      await authFetch("/api/threatintel/refresh", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
    } catch (error) {
      console.error("Refresh failed:", error);
    }
  }, []);

  const handleExportReport = useCallback(async () => {
    window.open("/api/threatintel/reports?format=html&type=summary", "_blank");
  }, []);

  const handleMarkAlertRead = useCallback((id: string) => {
    setAlerts(prev => prev.map(a => a.id === id ? { ...a, read: true } : a));
  }, []);

  const handleMarkAllAlertsRead = useCallback(() => {
    setAlerts(prev => prev.map(a => ({ ...a, read: true })));
  }, []);

  // Filter only online nodes for dashboard
  const onlineNodes = useMemo(() => nodes.filter(n => n.is_connected), [nodes]);

  if (loading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          {[...Array(5)].map((_, i) => (
            <Skeleton key={i} className="h-[120px]" />
          ))}
        </div>
        <Skeleton className="h-[280px]" />
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          <Skeleton className="h-[300px]" />
          <Skeleton className="h-[300px]" />
          <Skeleton className="h-[300px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      {/* Title rail.
          The old header carried a Live/Disconnected badge that now duplicates
          the WebSocket tile in the global header, so it is gone. The three
          Quick Actions that used to occupy a whole card in row 2 sit here
          instead: same reach, one container less, and no heading repeating
          the word "actions" above buttons that already say what they do. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("dashboard.title")}</h2>
          <p className="text-sm text-muted-foreground">{t("dashboard.description")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleSyncRemnawave}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {tQuick("syncRemnawave")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefreshBlacklist}>
            <ShieldAlert className="mr-1.5 h-3.5 w-3.5" />
            {tQuick("refreshBlacklist")}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleExportReport}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {tQuick("exportReport")}
          </Button>
        </div>
      </div>

      {/* Vital signs: five stat cards + the period-comparison card collapsed
          into one instrument. */}
      <VitalsRail
        stats={{
          total_requests: stats?.total_requests || statsHTTP?.total_requests || 0,
          total_blacklist: stats?.total_blacklist || statsHTTP?.total_blacklist || 0,
          nodes_total: stats?.nodes_total || statsHTTP?.nodes_total || 0,
          nodes_connected: stats?.nodes_connected ?? statsHTTP?.nodes_connected ?? 0,
          total_unique_users: stats?.total_unique_users || statsHTTP?.total_unique_users || 0,
          online_users: stats?.online_users || statsHTTP?.online_users || 0,
        }}
      />

      {/* Row 3: Activity Chart + Anomalies */}
      {/* One row, one height. Every card fills it and scrolls internally,
          so the plot grows into the space instead of leaving the black void
          the stretched card used to produce. */}
      <div className="grid grid-cols-1 gap-4 lg:h-[30rem] lg:grid-cols-3">
        <ActivityChart
          className="lg:col-span-2 h-[22rem] lg:h-full"
          data={hourly}
          onlineHistory={onlineHistory}
          title={t("dashboard.activityTitle")}
          description={t("dashboard.activityDesc")}
          loading={false}
          timeRange="24h"
        />
        <div className="grid min-h-0 gap-4 lg:grid-rows-2">
          <AnomaliesCard className="min-h-0" anomalies={anomalies} loading={false} />
          <AlertsSummary
            className="min-h-0"
            alerts={alerts}
            onMarkRead={handleMarkAlertRead}
            onMarkAllRead={handleMarkAllAlertsRead}
          />
        </div>
      </div>

      {/* Row 4: Heatmap + Traffic Distribution + Top Offenders */}
      {/* The heatmap is 24 columns wide and two rows tall — wide and short by
          nature. Boxed into a third of the row it left a tall gap beneath it
          and squeezed its own cells, so it gets the full width and the two
          genuinely tall cards share an equal-height row below. */}
      <ActivityHeatmap
        data={hourly}
        title={t("activityHeatmap.title")}
        description={t("activityHeatmap.description")}
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:h-[24rem]">
        <TrafficDistribution className="min-h-0" nodes={nodes} title={t("trafficDistribution.title")} />
        <TopOffenders className="min-h-0" users={topOffenders} title={t("topOffenders.title")} />
      </div>

      {/* Row 5: Geo Distribution (larger) + Real-time Feed */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:h-[34rem]">
        <GeoMap data={geoData} cityData={cityData} title={t("geoMap.title")} mode="cities" />
        <RealTimeFeed events={feedEvents} title={t("realTimeFeed.title")} />
      </div>

      {/* Row 6: Threat Intel (full width) */}
      <div className="grid gap-6">
        <ThreatIntelCard />
      </div>

      {/* Row 7: Nodes + Blacklist Alerts */}
      <div className="grid items-start gap-4 grid-cols-1 md:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle>{t("dashboard.activeNodes")}</CardTitle>
            <CardDescription>
              {t("dashboard.activeNodesDesc", { online: onlineNodes.length, total: nodes.length })}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[400px] overflow-y-auto scrollbar-thin">
            <NodesTable nodes={onlineNodes} />
          </CardContent>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle>{t("dashboard.blacklistAlerts")}</CardTitle>
            <CardDescription>
              {t("dashboard.recentBlocked")}
            </CardDescription>
          </CardHeader>
          <CardContent className="max-h-[400px] overflow-y-auto scrollbar-thin">
            <RecentBlocks 
              matches={blacklist?.recent_matches || []} 
              loading={false}
              limit={10}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
