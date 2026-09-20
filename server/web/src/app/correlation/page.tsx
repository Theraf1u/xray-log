"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/contexts/auth-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatRail } from "@/components/ui/stat-rail";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { AnimatedNumber } from "@/components/ui/animated-number";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { PaginationControls, usePagination } from "@/components/ui/data-table";
import { SubscriptionAbuseAnalytics } from "@/components/remnawave/subscription-abuse-analytics";
import { 
  Users, 
  Network, 
  AlertTriangle, 
  RefreshCw,
  Shield,
  Fingerprint,
  Smartphone,
  Globe,
  Search,
  TrendingUp,
  Link2
} from "lucide-react";
import { SubscriptionAbuse, RemnawaveAbuseUser } from "@/lib/types";

interface CorrelationStats {
  shared_ips: number;
  shared_hwids: number;
  total_fingerprints: number;
  users_with_shared_ip: number;
  users_with_shared_hwid: number;
  total_clusters: number;
  users_in_clusters: number;
}

interface UserAIProfile {
  user_email: string;
  remna_username?: string;
  unique_ips: number;
  unique_hwids: number;
  unique_fingerprints: number;
  unique_countries: number;
  unique_nodes: number;
  total_requests: number;
  total_sessions: number;
  total_threat_matches: number;
  threat_categories: Record<string, number>;
  shared_ip_users: number;
  shared_hwid_users: number;
  cluster_ids: string[];
  risk_score: number;
  risk_factors: string[];
  remna_uuid?: string;
  remna_status?: string;
  remna_traffic_used: number;
  remna_traffic_limit: number;
  remna_hwid_devices: number;
  remna_hwid_limit: number;
  first_seen: string;
  last_seen: string;
  active_days: number;
  updated_at: string;
}

interface SharedIPInfo {
  ip_address: string;
  user_count: number;
  last_seen: string;
  total_requests: number;
  users: string[];
}

interface SharedHWIDInfo {
  hwid: string;
  platform: string;
  user_count: number;
  last_seen: string;
  total_requests: number;
  users: string[];
}

export default function CorrelationPage() {
  const tc = useTranslations("correlation");
  const [stats, setStats] = useState<CorrelationStats | null>(null);
  const [profiles, setProfiles] = useState<UserAIProfile[]>([]);
  const [sharedIPs, setSharedIPs] = useState<SharedIPInfo[]>([]);
  const [sharedHWIDs, setSharedHWIDs] = useState<SharedHWIDInfo[]>([]);
  const [ipAbuseUsers, setIpAbuseUsers] = useState<SubscriptionAbuse[]>([]);
  const [hwidAbuseUsers, setHwidAbuseUsers] = useState<RemnawaveAbuseUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [minRiskScore, setMinRiskScore] = useState(0);
  const [statsLoaded, setStatsLoaded] = useState(false);

  // Progressive loading: stats first, then heavy data
  const fetchData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    
    try {
      const token = localStorage.getItem("xray_auth_token");
      const headers: HeadersInit = {};
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      // Phase 1: Load stats first (fast, shows immediately)
      const statsRes = await authFetch("/api/correlation/stats", { headers });
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        setStats(statsData);
        setStatsLoaded(true);
        setLoading(false); // Show page immediately with stats
      }

      // Phase 2: Load heavy data in parallel (background)
      const [profilesRes, sharedIPsRes, sharedHWIDsRes, ipAbuseRes, hwidAbuseRes] = await Promise.all([
        authFetch(`/api/correlation/profiles?limit=100&min_risk=${minRiskScore}`, { headers }),
        authFetch("/api/correlation/shared-ips?limit=50", { headers }),
        authFetch("/api/correlation/shared-hwids?limit=50", { headers }),
        authFetch("/api/blacklist/abuse", { headers }),
        authFetch("/api/remnawave/abuse", { headers })
      ]);

      const [profilesData, sharedIPsData, sharedHWIDsData, ipAbuseData, hwidAbuseData] = await Promise.all([
        profilesRes.ok ? profilesRes.json() : { profiles: [] },
        sharedIPsRes.ok ? sharedIPsRes.json() : { shared_ips: [] },
        sharedHWIDsRes.ok ? sharedHWIDsRes.json() : { shared_hwids: [] },
        ipAbuseRes.ok ? ipAbuseRes.json() : [],
        hwidAbuseRes.ok ? hwidAbuseRes.json() : { enabled: false, users: [] }
      ]);

      setProfiles(profilesData.profiles || []);
      setSharedIPs(sharedIPsData.shared_ips || []);
      setSharedHWIDs(sharedHWIDsData.shared_hwids || []);
      setIpAbuseUsers(ipAbuseData || []);
      setHwidAbuseUsers(hwidAbuseData.users || []);
    } catch (err) {
      console.error("Failed to fetch correlation data:", err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [minRiskScore]);

  useEffect(() => {
    fetchData();
    
    // Auto-refresh every 10 seconds (instant from cache)
    const interval = setInterval(() => {
      fetchData(true);
    }, 10000);
    
    return () => clearInterval(interval);
  }, [fetchData]);

  const getRiskBadge = (score: number) => {
    if (score >= 70) return <Badge variant="destructive">{tc("riskCritical")} ({score})</Badge>;
    if (score >= 50) return <Badge className="bg-orange-500">{tc("riskHigh")} ({score})</Badge>;
    if (score >= 30) return <Badge className="bg-yellow-500">{tc("riskMedium")} ({score})</Badge>;
    if (score >= 10) return <Badge variant="secondary">{tc("riskLow")} ({score})</Badge>;
    return <Badge variant="outline">{tc("riskMinimal")} ({score})</Badge>;
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const filteredProfiles = useMemo(() => 
    profiles.filter(p => p.user_email.toLowerCase().includes(searchTerm.toLowerCase())),
    [profiles, searchTerm]
  );

  // Pagination hooks for each table
  const profilesPagination = usePagination(filteredProfiles, 20);
  const sharedIPsPagination = usePagination(sharedIPs, 20);
  const sharedHWIDsPagination = usePagination(sharedHWIDs, 20);

  if (loading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-12 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{tc("title")}</h2>
          <p className="text-sm text-muted-foreground">{tc("subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchData(true)} disabled={refreshing}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
          {tc("refresh")}
        </Button>
      </div>

      {/* Four separate Cards became one rail: same four numbers, a third of
          the height, one container instead of four. */}
      <StatRail
        items={[
          {
            key: "sharedIps",
            motif: "nodes",
            label: tc("sharedIps"),
            value: stats?.shared_ips || 0,
            hint: tc("usersAffected", { count: stats?.users_with_shared_ip || 0 }),
          },
          {
            key: "sharedHwids",
            motif: "link",
            label: tc("sharedHwids"),
            value: stats?.shared_hwids || 0,
            dot: (stats?.shared_hwids || 0) > 0 ? "warn" : undefined,
            hint: tc("usersAffected", { count: stats?.users_with_shared_hwid || 0 }),
          },
          {
            key: "fingerprints",
            motif: "database",
            label: tc("fingerprints"),
            value: stats?.total_fingerprints || 0,
            hint: tc("fingerprintsHint"),
          },
          {
            key: "clusters",
            motif: "users",
            label: tc("clusters"),
            value: stats?.total_clusters || 0,
            hint: tc("usersLinked", { count: stats?.users_in_clusters || 0 }),
          },
        ]}
      />

      {/* Main Content Tabs */}
      <Tabs defaultValue="abuse" className="space-y-4">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="inline-flex w-auto min-w-full sm:w-auto">
            <TabsTrigger value="abuse" className="flex items-center gap-2 whitespace-nowrap">
              <Shield className="h-4 w-4" />
              <span className="hidden sm:inline">{tc("tabAbuse")}</span>
              <span className="sm:hidden">{tc("tabAbuseShort")}</span>
              {(ipAbuseUsers.length > 0 || hwidAbuseUsers.length > 0) && (
                <Badge variant="destructive" className="ml-1">
                  {ipAbuseUsers.length + hwidAbuseUsers.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="profiles" className="whitespace-nowrap">
              <Users className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{tc("tabProfiles")}</span>
              <span className="sm:hidden">{tc("tabProfilesShort")}</span>
            </TabsTrigger>
            <TabsTrigger value="shared-ips" className="whitespace-nowrap">
              <Network className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{tc("tabSharedIps")}</span>
              <span className="sm:hidden">{tc("tabSharedIpsShort")}</span>
            </TabsTrigger>
            <TabsTrigger value="shared-hwids" className="whitespace-nowrap">
              <Smartphone className="mr-2 h-4 w-4" />
              <span className="hidden sm:inline">{tc("tabSharedHwids")}</span>
              <span className="sm:hidden">{tc("tabSharedHwidsShort")}</span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="abuse" className="space-y-4">
          <SubscriptionAbuseAnalytics
            ipAbuseData={ipAbuseUsers}
            hwidAbuseData={hwidAbuseUsers}
            onHwidCleared={() => fetchData(true)}
          />
        </TabsContent>

        <TabsContent value="profiles" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{tc("aiProfiles")}</CardTitle>
              <CardDescription>{tc("aiProfilesDesc")}</CardDescription>
              <div className="flex gap-4 mt-4">
                <div className="relative flex-1">
                  <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder={tc("searchByEmail")}
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <select
                  className="border rounded-md px-3"
                  value={minRiskScore}
                  onChange={(e) => setMinRiskScore(Number(e.target.value))}
                >
                  <option value={0}>{tc("allRiskLevels")}</option>
                  <option value={10}>{tc("riskAtLeast", { score: 10 })}</option>
                  <option value={30}>{tc("riskAtLeast", { score: 30 })}</option>
                  <option value={50}>{tc("riskAtLeast", { score: 50 })}</option>
                  <option value={70}>{tc("riskAtLeast", { score: 70 })}</option>
                </select>
              </div>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto max-h-[600px] border rounded-md">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead>{tc("user")}</TableHead>
                    <TableHead>{tc("riskCol")}</TableHead>
                    <TableHead>{tc("ipsCol")}</TableHead>
                    <TableHead>{tc("hwidsCol")}</TableHead>
                    <TableHead>{tc("sharedWith")}</TableHead>
                    <TableHead>{tc("threatsCol")}</TableHead>
                    <TableHead>{tc("countriesCol")}</TableHead>
                    <TableHead>{tc("statusCol")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profilesPagination.paginatedData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center text-muted-foreground">
                        {tc("noProfilesFound")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    profilesPagination.paginatedData.map((profile) => (
                      <TableRow key={profile.user_email}>
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span>{profile.remna_username || profile.user_email}</span>
                            {profile.remna_username && profile.remna_username !== profile.user_email && (
                              <span className="text-xs text-muted-foreground">ID: {profile.user_email}</span>
                            )}
                          </div>
                          {profile.risk_factors && profile.risk_factors.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {profile.risk_factors.slice(0, 3).map((factor, i) => (
                                <Badge key={i} variant="outline" className="text-xs">
                                  {factor.replace(/_/g, " ")}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{getRiskBadge(profile.risk_score)}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{profile.unique_ips}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={profile.unique_hwids > 3 ? "destructive" : "outline"}>
                            {profile.unique_hwids}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            {profile.shared_ip_users > 0 && (
                              <Badge variant="secondary">
                                {tc("ipCount", { count: profile.shared_ip_users })}
                              </Badge>
                            )}
                            {profile.shared_hwid_users > 0 && (
                              <Badge variant="destructive">
                                {tc("hwidCount", { count: profile.shared_hwid_users })}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant={profile.total_threat_matches > 10 ? "destructive" : "outline"}>
                            {profile.total_threat_matches}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">
                            <Globe className="h-3 w-3 mr-1" />
                            {profile.unique_countries}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {profile.remna_status && (
                            <Badge variant={profile.remna_status === "ACTIVE" ? "default" : "secondary"}>
                              {profile.remna_status}
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              </div>
              <PaginationControls {...profilesPagination} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="shared-ips" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>{tc("sharedIpAddresses")}</CardTitle>
              <CardDescription>{tc("sharedIpAddressesDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto max-h-[600px] border rounded-md">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead>{tc("ipAddressCol")}</TableHead>
                    <TableHead>{tc("usersCol")}</TableHead>
                    <TableHead>{tc("totalRequestsCol")}</TableHead>
                    <TableHead>{tc("lastSeenCol")}</TableHead>
                    <TableHead>{tc("userListCol")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sharedIPsPagination.paginatedData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        {tc("noSharedIps")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    sharedIPsPagination.paginatedData.map((ip) => (
                      <TableRow key={ip.ip_address}>
                        <TableCell className="font-mono">{ip.ip_address}</TableCell>
                        <TableCell>
                          <Badge variant={ip.user_count > 5 ? "destructive" : "secondary"}>
                            {tc("usersCount", { count: ip.user_count })}
                          </Badge>
                        </TableCell>
                        <TableCell>{ip.total_requests.toLocaleString()}</TableCell>
                        <TableCell>{ip.last_seen}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-md">
                            {ip.users?.slice(0, 5).map((user, i) => (
                              <Badge key={i} variant="outline" className="text-xs">
                                {user}
                              </Badge>
                            ))}
                            {ip.users?.length > 5 && (
                              <Badge variant="outline" className="text-xs">
                                {tc("moreCountPlain", { count: ip.users.length - 5 })}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              </div>
              <PaginationControls {...sharedIPsPagination} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="shared-hwids" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center">
                <AlertTriangle className="h-5 w-5 mr-2 text-orange-500" />
                {tc("sharedHardwareIds")}
              </CardTitle>
              <CardDescription>{tc("sharedHardwareIdsDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-auto max-h-[600px] border rounded-md">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead>{tc("hwidCol")}</TableHead>
                    <TableHead>{tc("platformCol")}</TableHead>
                    <TableHead>{tc("usersCol")}</TableHead>
                    <TableHead>{tc("totalRequestsCol")}</TableHead>
                    <TableHead>{tc("lastSeenCol")}</TableHead>
                    <TableHead>{tc("userListCol")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sharedHWIDsPagination.paginatedData.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground">
                        {tc("noSharedHwids")}
                      </TableCell>
                    </TableRow>
                  ) : (
                    sharedHWIDsPagination.paginatedData.map((hwid) => (
                      <TableRow key={hwid.hwid} className="bg-orange-50 dark:bg-orange-950/20">
                        <TableCell className="font-mono text-xs">
                          {hwid.hwid.substring(0, 16)}...
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{hwid.platform || tc("unknownPlatform")}</Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="destructive">
                            {tc("usersCount", { count: hwid.user_count })}
                          </Badge>
                        </TableCell>
                        <TableCell>{hwid.total_requests.toLocaleString()}</TableCell>
                        <TableCell>{hwid.last_seen}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-md">
                            {hwid.users?.map((user, i) => (
                              <Badge key={i} variant="destructive" className="text-xs">
                                {user}
                              </Badge>
                            ))}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
              </div>
              <PaginationControls {...sharedHWIDsPagination} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
