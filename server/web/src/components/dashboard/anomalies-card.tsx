"use client";

import { useRef, useEffect, useState } from "react";
import { StatsAnomaly } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, TrendingUp, User } from "lucide-react";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { isValidDate } from "@/lib/utils/date";

interface AnomaliesCardProps {
  anomalies: StatsAnomaly[];
  loading?: boolean;
  className?: string;
}

const anomalyIcons = {
  blacklist_spike: AlertTriangle,
  traffic_spike: TrendingUp,
  user_spike: User,
};

// Generate a unique key for an anomaly
function getAnomalyKey(anomaly: StatsAnomaly): string {
  return `${anomaly.type}-${anomaly.hour}-${anomaly.user_email || "global"}-${anomaly.deviation}`;
}

export function AnomaliesCard({ anomalies, loading, className }: AnomaliesCardProps) {
  const t = useTranslations("anomalies");
  const prevAnomaliesRef = useRef<Set<string>>(new Set());
  const [newAnomalyKeys, setNewAnomalyKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const currentKeys = new Set(anomalies.map(getAnomalyKey));
    const newKeys = new Set<string>();

    // Find new anomalies
    currentKeys.forEach((key) => {
      if (!prevAnomaliesRef.current.has(key)) {
        newKeys.add(key);
      }
    });

    if (newKeys.size > 0) {
      setNewAnomalyKeys(newKeys);

      // Remove highlight after 2 seconds
      const timer = setTimeout(() => {
        setNewAnomalyKeys(new Set());
      }, 2000);

      return () => clearTimeout(timer);
    }

    // Update previous state
    prevAnomaliesRef.current = currentKeys;
  }, [anomalies]);

  // Update ref after each render
  useEffect(() => {
    prevAnomaliesRef.current = new Set(anomalies.map(getAnomalyKey));
  }, [anomalies]);

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            {t("title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-12 bg-muted rounded" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          {t("title")}
          {anomalies.length > 0 && (
            <Badge variant="destructive" className="ml-auto">
              {anomalies.length}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {anomalies.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            {t("noAnomalies")}
          </p>
        ) : (
          // Hairline-separated rows on the card's own surface. Each entry used
          // to be its own rounded, bordered, background-filled box inside an
          // already-bordered card — three container edges deep for one line.
          <div className="-mx-5 h-full overflow-y-auto scrollbar-thin">
            {anomalies.map((anomaly) => {
              const Icon = anomalyIcons[anomaly.type] || AlertTriangle;
              const key = getAnomalyKey(anomaly);
              const isNew = newAnomalyKeys.has(key);
              
              return (
                <div
                  key={key}
                  className={`glass-row flex items-start gap-3 px-5 py-2.5 ${
                    isNew ? "animate-fade-in-row" : ""
                  }`}
                >
                  <div className="flex-shrink-0 mt-0.5">
                    <span className={`flex h-6 w-6 items-center justify-center rounded-full bg-destructive/10 text-destructive ${
                      isNew ? "animate-pulse" : ""
                    }`}>
                      <Icon className="h-3 w-3" />
                    </span>
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="text-xs sm:text-sm font-medium truncate max-w-full">
                      {anomaly.message}
                    </p>
                    <div className="flex items-center gap-2 mt-1">
                      {anomaly.user_email && (
                        <Link
                          href={`/users/${encodeURIComponent(anomaly.user_email)}`}
                          className="text-xs text-primary hover:underline"
                        >
                          {anomaly.user_email}
                        </Link>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {isValidDate(anomaly.hour)
                          ? formatDistanceToNowRu(new Date(anomaly.hour))
                          : "—"
                        }
                      </span>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-sm font-semibold tabular-nums text-destructive">
                      {anomaly.deviation.toFixed(1)}x
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("vsBaseline")}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
