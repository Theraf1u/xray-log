"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bell, AlertTriangle, ShieldAlert, Info, X, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import Link from "next/link";

export type AlertSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface Alert {
  id: string;
  title: string;
  description?: string;
  severity: AlertSeverity;
  timestamp: string;
  read: boolean;
  link?: string;
}

interface AlertsSummaryProps {
  alerts: Alert[];
  onMarkRead?: (id: string) => void;
  onMarkAllRead?: () => void;
  className?: string;
}

const severityConfig: Record<AlertSeverity, { 
  icon: React.ReactNode; 
  color: string;
  label: string;
}> = {
  critical: {
    icon: <ShieldAlert className="h-4 w-4" />,
    color: "text-red-600 bg-red-500/10 border-red-500/30",
    label: "Critical",
  },
  high: {
    icon: <AlertTriangle className="h-4 w-4" />,
    color: "text-orange-600 bg-orange-500/10 border-orange-500/30",
    label: "High",
  },
  medium: {
    icon: <AlertTriangle className="h-4 w-4" />,
    color: "text-yellow-600 bg-yellow-500/10 border-yellow-500/30",
    label: "Medium",
  },
  low: {
    icon: <Info className="h-4 w-4" />,
    color: "text-blue-600 bg-blue-500/10 border-blue-500/30",
    label: "Low",
  },
  info: {
    icon: <Info className="h-4 w-4" />,
    color: "text-muted-foreground bg-muted border-border",
    label: "Info",
  },
};

export function AlertsSummary({ alerts, onMarkRead, onMarkAllRead, className }: AlertsSummaryProps) {
  const t = useTranslations("alerts");
  const unreadCount = alerts.filter(a => !a.read).length;
  const criticalCount = alerts.filter(a => a.severity === "critical" && !a.read).length;
  const highCount = alerts.filter(a => a.severity === "high" && !a.read).length;
  
  const displayAlerts = alerts.slice(0, 5);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-0">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Bell className="h-4 w-4 text-yellow-500" />
            {t("title")}
            {unreadCount > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5 text-xs">
                {unreadCount}
              </Badge>
            )}
          </CardTitle>
          {unreadCount > 0 && onMarkAllRead && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-7 text-xs"
              onClick={onMarkAllRead}
            >
              <CheckCircle className="h-3 w-3 mr-1" />
              {t("markAllRead")}
            </Button>
          )}
        </div>
        
        {/* Severity summary badges */}
        {(criticalCount > 0 || highCount > 0) && (
          <div className="flex gap-2 mt-2">
            {criticalCount > 0 && (
              <Badge variant="outline" className={severityConfig.critical.color}>
                {criticalCount} {t("critical")}
              </Badge>
            )}
            {highCount > 0 && (
              <Badge variant="outline" className={severityConfig.high.color}>
                {highCount} {t("high")}
              </Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {alerts.length === 0 ? (
          <div className="text-center py-6 text-muted-foreground">
            <CheckCircle className="h-8 w-8 mx-auto mb-2 opacity-30 text-green-500" />
            <p className="text-sm">{t("noAlerts")}</p>
            <p className="text-xs mt-1">{t("allRunning")}</p>
          </div>
        ) : (
          // Rows, not a stack of tinted boxes. Severity was being said three
          // times at once — border colour, fill colour and text colour — so
          // five alerts produced five competing rectangles. Now the icon
          // carries severity and the row carries the text.
          <div className="-mx-5 h-full overflow-y-auto scrollbar-thin">
            {displayAlerts.map((alert) => {
              const config = severityConfig[alert.severity];
              const baseClassName = `glass-row flex items-start gap-2.5 px-5 py-2 ${
                alert.read ? "opacity-55" : ""
              }`;
              
              const content = (
                <>
                  <div className="mt-0.5">{config.icon}</div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-medium ${!alert.read ? "" : "text-muted-foreground"}`}>
                      {alert.title}
                    </p>
                    {alert.description && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                        {alert.description}
                      </p>
                    )}
                  </div>
                  {onMarkRead && !alert.read && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-5 w-5 shrink-0"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onMarkRead(alert.id);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </>
              );
              
              if (alert.link) {
                return (
                  <Link
                    key={alert.id}
                    href={alert.link}
                    className={`${baseClassName} hover:opacity-80 cursor-pointer block`}
                  >
                    {content}
                  </Link>
                );
              }
              
              return (
                <div key={alert.id} className={baseClassName}>
                  {content}
                </div>
              );
            })}
          </div>
        )}
        
        {alerts.length > 5 && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            +{alerts.length - 5} {t("title").toLowerCase()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
