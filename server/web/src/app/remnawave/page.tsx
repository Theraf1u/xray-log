"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { authFetch } from "@/contexts/auth-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StatRail } from "@/components/ui/stat-rail";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { PaginationControls, usePagination } from "@/components/ui/data-table";
import { RemnawaveUsersTable } from "@/components/remnawave/remnawave-users-table";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { 
  Users, 
  Smartphone, 
  AlertTriangle, 
  Activity, 
  RefreshCw,
  Server,
  TrendingUp,
  Wifi,
  Clock,
  Globe
} from "lucide-react";
import { useTranslations } from "next-intl";
import { RemnawaveStats, RemnawaveOnlineStats } from "@/lib/types";

export default function RemnavewavePage() {
  const t = useTranslations("remnawave");
  const tCommon = useTranslations("common");
  const [stats, setStats] = useState<RemnawaveStats | null>(null);
  const [onlineStats, setOnlineStats] = useState<RemnawaveOnlineStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    
    setError(null);
    
    try {
      const token = localStorage.getItem("xray_auth_token");
      const headers: HeadersInit = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const [statsRes, onlineRes] = await Promise.all([
        authFetch("/api/remnawave/stats", { headers }),
        authFetch("/api/remnawave/online", { headers })
      ]);

      // All endpoints now return JSON even when Remnawave is not configured
      const [statsData, onlineData] = await Promise.all([
        statsRes.ok ? statsRes.json() : { enabled: false },
        onlineRes.ok ? onlineRes.json() : { enabled: false, onlineUsers: [] }
      ]);

      setStats(statsData);
      setOnlineStats(onlineData);
      setLastUpdate(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("fetchError"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    // Auto-refresh every 10 seconds (instant from cache)
    const interval = setInterval(() => fetchData(true), 10 * 1000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // Pagination for online users - must be called before any early returns
  const onlineUsersPagination = usePagination(onlineStats?.onlineUsers ?? []);

  if (loading) {
    return (
      <div className="container mx-auto py-6 px-4 space-y-6">
        <div className="flex justify-between items-center">
          <div>
            <Skeleton className="h-8 w-48 mb-2" />
            <Skeleton className="h-4 w-64" />
          </div>
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
        <Card>
          <CardContent className="p-6">
            <Skeleton className="h-96 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-6 px-4">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              {t("errorTitle")}
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => fetchData()}>
              <RefreshCw className="h-4 w-4 mr-2" />
              {t("retry")}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto py-6 px-4 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            {t("title")}
          </h1>
          <p className="text-muted-foreground">
            {t("description")}
            {lastUpdate && (
              <span className="ml-2 text-xs">
                • {t("updated")} {lastUpdate.toLocaleTimeString()}
              </span>
            )}
            {onlineStats?.lastSync && (
              <span className="ml-2 text-xs text-green-500">
                • {t("syncEveryMinute")}
              </span>
            )}
          </p>
        </div>
        <Button 
          variant="outline" 
          onClick={() => fetchData(true)}
          disabled={refreshing}
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
          {t("refresh")}
        </Button>
      </div>

      {/* Five bordered cards (one of them oversized as a "featured" card)
          became one rail. Online-now keeps its colour via `tone` instead of a
          differently-sized card that broke the row's rhythm. */}
      <StatRail
        columns={5}
        items={[
          {
            key: "onlineNow",
            label: t("onlineNow"),
            value: onlineStats?.now ?? 0,
            tone: "ok",
            dot: (onlineStats?.now ?? 0) > 0 ? "ok" : undefined,
            hint: `${t("mins15")} ${onlineStats?.recent ?? 0} · ${t("hour1")} ${onlineStats?.lastHour ?? 0}`,
            motif: "pulse",
          },
          {
            key: "totalUsers",
            label: t("totalUsers"),
            value: stats?.totalUsers ?? 0,
            hint: `${t("activeShort")}: ${stats?.activeUsers ?? 0}`,
            motif: "users",
          },
          {
            key: "hwidDevices",
            label: t("hwidDevices"),
            value: stats?.hwidStats?.totalDevices ?? 0,
            hint: `${t("unique")} ${stats?.hwidStats?.uniqueUsers ?? 0}`,
            motif: "link",
          },
          {
            key: "platforms",
            label: t("platforms"),
            value:
              stats?.hwidStats?.platformBreakdown && Object.keys(stats.hwidStats.platformBreakdown).length > 0
                ? Object.entries(stats.hwidStats.platformBreakdown).sort(([, a], [, b]) => b - a)[0][0] || t("unknownPlatform")
                : t("noData"),
            hint:
              stats?.hwidStats?.platformBreakdown && Object.keys(stats.hwidStats.platformBreakdown).length > 1
                ? Object.entries(stats.hwidStats.platformBreakdown)
                    .sort(([, a], [, b]) => b - a)
                    .slice(1, 3)
                    .map(([platform, count]) => `${platform || t("unknownPlatform")}: ${count}`)
                    .join(" · ")
                : undefined,
            motif: "globe",
          },
        ]}
      />

      {/* Main Content */}
      <Tabs defaultValue="online" className="space-y-4">
        <TabsList>
          <TabsTrigger value="online" className="flex items-center gap-2">
            <Wifi className="h-4 w-4" />
            {t("tabOnline")}
            {onlineStats && onlineStats.now > 0 && (
              <Badge variant="default" className="ml-1 bg-green-500">
                {onlineStats.now}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="users" className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            {t("tabUsers")}
          </TabsTrigger>
          <TabsTrigger value="analytics" className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            {t("tabAnalytics")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="online" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Wifi className="h-5 w-5 text-green-500" />
                {t("onlineUsersTitle")}
              </CardTitle>
              <CardDescription>
                {t("onlineUsersDesc")}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {/* Same five figures as a rail instead of five centred blocks
                  each spending its own rounded background. */}
              <StatRail
                columns={5}
                className="mb-6"
                items={[
                  {
                    key: "now5min",
                    label: t("now5min"),
                    value: onlineStats?.now ?? 0,
                    tone: "ok",
                    motif: "pulse",
                  },
                  { key: "last15min", label: t("last15min"), value: onlineStats?.recent ?? 0, motif: "stream" },
                  { key: "lastHour", label: t("lastHour"), value: onlineStats?.lastHour ?? 0, motif: "database" },
                  { key: "last24h", label: t("last24h"), value: onlineStats?.last24h ?? 0, motif: "globe" },
                  { key: "neverOnline", label: t("neverOnline"), value: onlineStats?.neverOnline ?? 0, motif: "users" },
                ]}
              />

              {/* Online Users Table */}
              {onlineStats?.onlineUsers && onlineStats.onlineUsers.length > 0 ? (
                <>
                <div className="max-h-[600px] overflow-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("userColumn")}</TableHead>
                      <TableHead>{t("statusColumn")}</TableHead>
                      <TableHead>{t("lastActivityColumn")}</TableHead>
                      <TableHead>{t("nodeColumn")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {onlineUsersPagination.paginatedData.map((user) => (
                      <TableRow key={user.uuid}>
                        <TableCell>
                          <div className="space-y-1">
                            <div className="font-medium flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
                              {user.username}
                            </div>
                            {user.email && (
                              <div className="text-xs text-muted-foreground">{user.email}</div>
                            )}
                            {user.parsedRealName && (
                              <div className="text-xs text-muted-foreground">{user.parsedRealName}</div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={user.status === "ACTIVE" ? "default" : "secondary"}
                                 className={user.status === "ACTIVE" ? "bg-green-500" : ""}>
                            {user.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Clock className="h-3 w-3 text-muted-foreground" />
                            <span className="text-sm">
                              {user.minutesAgo === 0 ? tCommon("justNow") : tCommon("minutesAgo", { count: user.minutesAgo })}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          {user.lastConnectedNode ? (
                            <div className="flex items-center gap-2">
                              <Globe className="h-3 w-3 text-muted-foreground" />
                              <span className="text-sm">{user.lastConnectedNode}</span>
                              {user.countryCode && (
                                <Badge variant="outline" className="text-xs">
                                  {user.countryCode}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                </div>
                <PaginationControls {...onlineUsersPagination} />
                </>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Wifi className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>{t("noOnlineUsers")}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="users" className="space-y-4">
          {/* RemnawaveUsersTable brings its own stat rail, filters and table
              surface; wrapping it in another Card nested a whole page inside
              one card header. A plain heading carries the same context. */}
          <div>
            <h3 className="flex items-center gap-2 text-base font-semibold">
              <Users className="h-4 w-4 text-muted-foreground" />
              {t("remnawaveUsers")}
            </h3>
            <p className="text-sm text-muted-foreground">{t("remnawaveUsersDesc")}</p>
          </div>
          <RemnawaveUsersTable />
        </TabsContent>

        <TabsContent value="analytics" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Traffic Stats */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("trafficUsage")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("totalTraffic")}</span>
                    <span className="font-medium">
                      {stats?.totalTrafficUsed
                        ? `${(stats.totalTrafficUsed / (1024 * 1024 * 1024)).toFixed(2)} GB`
                        : tCommon("notAvailable")
                      }
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("avgPerUser")}</span>
                    <span className="font-medium">
                      {stats?.totalTrafficUsed && stats?.activeUsers
                        ? `${(stats.totalTrafficUsed / stats.activeUsers / (1024 * 1024 * 1024)).toFixed(2)} GB`
                        : tCommon("notAvailable")
                      }
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Status Distribution */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("statusDistribution")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex justify-between items-center">
                    <Badge variant="default" className="bg-green-500">{t("statusActive")}</Badge>
                    <span className="font-medium">{stats?.activeUsers ?? 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <Badge variant="secondary">{t("statusDisabled")}</Badge>
                    <span className="font-medium">{stats?.disabledUsers ?? 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <Badge variant="default" className="bg-orange-500">{t("statusLimited")}</Badge>
                    <span className="font-medium">{stats?.limitedUsers ?? 0}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <Badge variant="destructive">{t("statusExpired")}</Badge>
                    <span className="font-medium">{stats?.expiredUsers ?? 0}</span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Online Activity */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("onlineActivity")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("lastHourLabel")}</span>
                    <span className="font-medium text-green-500">
                      {stats?.onlineLastHour ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("last24hLabel")}</span>
                    <span className="font-medium">
                      {stats?.onlineLast24h ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("neverOnlineLabel")}</span>
                    <span className="font-medium text-muted-foreground">
                      {stats?.neverOnline ?? "—"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Device Limits */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">{t("deviceLimits")}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("withHwidLimit")}</span>
                    <span className="font-medium">
                      {stats?.usersWithHwidLimit ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("totalDevices")}</span>
                    <span className="font-medium">
                      {stats?.hwidStats?.totalDevices ?? "—"}
                    </span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">{t("avgDevices")}</span>
                    <span className="font-medium">
                      {stats?.hwidStats?.totalDevices && stats?.hwidStats?.uniqueUsers
                        ? (stats.hwidStats.totalDevices / stats.hwidStats.uniqueUsers).toFixed(1)
                        : "—"
                      }
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
