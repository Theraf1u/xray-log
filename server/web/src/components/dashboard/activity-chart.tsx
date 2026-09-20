"use client";

import { formatRu } from "@/lib/utils/date";
import { useMemo } from "react";
import { HourlyStats, TimeRange } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useTranslations } from "next-intl";
import { Skeleton } from "@/components/ui/skeleton";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface OnlineHistoryPoint {
  hour: string;
  online_users: number;
}

interface ActivityChartProps {
  data: HourlyStats[];
  // Optional overlay of real XTLS online counts per hour (from Remnawave
  // snapshots). When provided the chart uses these for the "Online Users"
  // line instead of hourly_stats.unique_users — the former is the actual
  // session count, the latter is an access-log proxy that dips on WS flaps.
  onlineHistory?: OnlineHistoryPoint[];
  title?: string;
  description?: string;
  loading?: boolean;
  timeRange?: TimeRange;
  className?: string;
}

export function ActivityChart({
  data,
  onlineHistory,
  title,
  description,
  loading = false,
  timeRange = "24h",
  className,
}: ActivityChartProps) {
  const ts = useTranslations("stats");
  const heading = title ?? ts("totalRequests");
  const subheading = description ?? ts("processedLogs");
  // Shared with the tooltip formatter and the legend below.
  const seriesLabels: Record<string, string> = {
    requests: ts("totalRequests"),
    blacklist: ts("blacklistHits"),
    online: ts("onlineUsers"),
  };

  const chartData = useMemo(() => {
    if (!data || data.length === 0) {
      return [];
    }

    // Determine label format based on time range
    const isLongRange = timeRange === "7d" || timeRange === "30d";

    // Hour (UTC floor) → online users lookup, driven by Remnawave snapshots
    // when we have them. Falling back to unique_users keeps old dashboards
    // readable until snapshots have had time to accumulate.
    const overlay = new Map<string, number>();
    if (onlineHistory) {
      for (const p of onlineHistory) {
        const key = new Date(p.hour).toISOString().slice(0, 13); // YYYY-MM-DDTHH
        overlay.set(key, p.online_users);
      }
    }

    // Sort data by hour and format for chart
    return data
      .sort((a, b) => new Date(a.hour).getTime() - new Date(b.hour).getTime())
      .map(d => {
        const date = new Date(d.hour);
        const key = date.toISOString().slice(0, 13);
        const onlineFromSnapshot = overlay.get(key);
        return {
          hour: isLongRange ? formatRu(date, "MMM d") : formatRu(date, "HH:mm"),
          fullDate: formatRu(date, "MMM d, HH:mm"),
          requests: d.total_requests || 0,
          blacklist: d.blacklist_hits || 0,
          online: onlineFromSnapshot !== undefined ? onlineFromSnapshot : (d.unique_users || 0),
        };
      });
  }, [data, onlineHistory, timeRange]);

  // Calculate tick interval based on data length
  const tickInterval = useMemo(() => {
    const len = chartData.length;
    if (len <= 12) return 0; // Show all
    if (len <= 24) return 3;
    if (len <= 48) return 5;
    if (len <= 168) return 23; // 7 days - show daily
    return Math.floor(len / 10);
  }, [chartData.length]);

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{heading}</CardTitle>
          <CardDescription>{subheading}</CardDescription>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[300px] w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm sm:text-base">{heading}</CardTitle>
        <CardDescription className="text-xs">{subheading}</CardDescription>
      </CardHeader>
      {/* The plot grows to whatever height the row gives it. It used to be
          pinned at 300px inside a card the grid stretched to ~900px, which is
          where the enormous black void under the chart came from. */}
      <CardContent className="min-h-0 flex-1 p-2 sm:px-4 sm:pb-4">
        <div className="h-full min-h-[240px] w-full min-w-0">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="colorRequests" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--viz-1))" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="hsl(var(--viz-1))" stopOpacity={0.1}/>
                </linearGradient>
                <linearGradient id="colorBlacklist" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--viz-2))" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="hsl(var(--viz-2))" stopOpacity={0.1}/>
                </linearGradient>
                <linearGradient id="colorOnline" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="hsl(var(--viz-3))" stopOpacity={0.8}/>
                  <stop offset="95%" stopColor="hsl(var(--viz-3))" stopOpacity={0.1}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis 
                dataKey="hour" 
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                className="text-muted-foreground"
                interval={tickInterval}
              />
              <YAxis domain={[0, "dataMax"]}  
                yAxisId="left"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                className="text-muted-foreground"
                tickFormatter={(value) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value}
              />
              <YAxis 
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 12 }}
                tickLine={false}
                axisLine={false}
                className="text-muted-foreground"
                domain={[0, 'auto']}
              />
              <Tooltip 
                contentStyle={{ 
                  backgroundColor: "rgb(24, 24, 27)",
                  border: "1px solid rgb(63, 63, 70)",
                  borderRadius: "8px",
                  fontSize: "12px",
                  color: "rgb(250, 250, 250)",
                  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
                }}
                labelStyle={{ color: "rgb(250, 250, 250)", fontWeight: "bold" }}
                itemStyle={{ color: "rgb(212, 212, 216)" }}
                cursor={{ stroke: "rgba(63, 63, 70, 0.5)", strokeWidth: 1 }}
                labelFormatter={(label) => {
                  const item = chartData.find(d => d.hour === label);
                  return item?.fullDate || label;
                }}
                formatter={(value: number, name: string) => {
                  return [value.toLocaleString(), seriesLabels[name] || name];
                }}
              />
              <Legend 
                verticalAlign="top"
                height={36}
                formatter={(value) => seriesLabels[value] || value}
              />
              <Area
                type="monotone"
                dataKey="requests"
                stroke="hsl(var(--viz-1))"
                fillOpacity={1}
                fill="url(#colorRequests)"
                strokeWidth={2}
                yAxisId="left"
              />
              <Area
                type="monotone"
                dataKey="blacklist"
                stroke="hsl(var(--viz-2))"
                fillOpacity={1}
                fill="url(#colorBlacklist)"
                strokeWidth={2}
                yAxisId="left"
              />
              <Area
                type="monotone"
                dataKey="online"
                stroke="hsl(var(--viz-3))"
                fillOpacity={1}
                fill="url(#colorOnline)"
                strokeWidth={2}
                yAxisId="right"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
