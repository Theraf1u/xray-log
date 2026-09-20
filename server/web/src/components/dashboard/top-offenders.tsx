"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  AlertTriangle, 
  User, 
  ExternalLink,
  ShieldAlert,
  TrendingUp
} from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface TopOffender {
  user_email: string;
  blacklist_hits: number;
  threat_matches?: number;
  risk_score?: number;
  last_seen?: string;
}

interface TopOffendersProps {
  className?: string;
  users: TopOffender[];
  title?: string;
  maxItems?: number;
}

export function TopOffenders({ users, title, maxItems = 5, className }: TopOffendersProps) {
  const t = useTranslations("topOffenders");
  const heading = title ?? t("title");

  // Risk bands, worded as a verdict rather than a bare adjective: "Критический"
  // alone does not say critical *what*.
  const riskBadge = (score: number) => {
    if (score >= 70) return <Badge variant="destructive" className="text-xs">{t("riskCritical")}</Badge>;
    if (score >= 50) return <Badge className="bg-orange-500 text-white text-xs">{t("riskHigh")}</Badge>;
    if (score >= 30) return <Badge className="bg-yellow-500 text-white text-xs">{t("riskMedium")}</Badge>;
    return <Badge variant="secondary" className="text-xs">{t("riskLow")}</Badge>;
  };

  const topUsers = users.slice(0, maxItems);

  if (users.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-orange-500" />
            {heading}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6 text-muted-foreground">
            <ShieldAlert className="h-8 w-8 mx-auto mb-2 opacity-30" />
            <p className="text-sm">{t("empty")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const maxHits = Math.max(...topUsers.map(u => u.blacklist_hits), 1);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-orange-500" />
          {heading}
        </CardTitle>
        <CardDescription className="text-xs">
          {t("description")}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 space-y-3 overflow-y-auto scrollbar-thin">
        {topUsers.map((user, index) => {
          const percentage = (user.blacklist_hits / maxHits) * 100;
          return (
            <div key={user.user_email} className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="w-5 text-sm font-semibold tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <Link 
                    href={`/users/${encodeURIComponent(user.user_email)}`}
                    className="text-sm font-medium truncate hover:underline text-primary flex items-center gap-1"
                  >
                    {user.user_email}
                    <ExternalLink className="h-3 w-3 opacity-50" />
                  </Link>
                </div>
                <div className="flex items-center gap-2">
                  {user.risk_score !== undefined && riskBadge(user.risk_score)}
                  <Badge variant="destructive" className="font-mono text-xs">
                    {user.blacklist_hits.toLocaleString()}
                  </Badge>
                </div>
              </div>
              <div className="ml-7 h-1 overflow-hidden rounded-full bg-muted-foreground/15">
                <div 
                  // One accent, opacity by rank. A red/orange/yellow ramp
                  // implied three severities where there is only one measure.
                  className="h-full rounded-full bg-destructive transition-all"
                  data-rank={index}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          );
        })}
        
        <Link 
          href="/users?sort=blacklist_hits&order=desc"
          className="block text-center text-xs text-primary hover:underline pt-2"
        >
          View all users →
        </Link>
      </CardContent>
    </Card>
  );
}
