"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Activity, ShieldAlert, LogOut, Menu, X, Smartphone, Network, Route, FileClock, Database, Sparkles, Settings, HardDrive, HardDriveDownload, Clock, Users } from "lucide-react";
import { ServiceStatusTiles } from "@/components/layout/service-status-tiles";
import { useAiChatVisibility } from "@/lib/ai-chat-visibility";
import { authFetch, useAuth } from "@/contexts/auth-context";
import { useWsStats } from "@/contexts/websocket-context";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";

export function Header() {
  const pathname = usePathname();
  const { isAuthenticated, logout } = useAuth();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const t = useTranslations("nav");
  const tTiles = useTranslations("serviceTiles");
  const { hidden: aiHidden, setHidden: setAiHidden } = useAiChatVisibility();
  const [storage, setStorage] = useState<{
    database_bytes: number;
    wal_bytes: number;
    chronology_bytes: number;
    analyzer_bytes: number;
    disk_total_bytes: number;
    disk_free_bytes: number;
    percent: number;
    disk_used_percent: number;
    uptime_seconds: number;
  } | null>(null);
  const { stats: dashboardStats } = useWsStats();

  useEffect(() => {
    if (!isAuthenticated) return;

    let active = true;
    const loadStorage = async () => {
      try {
        const response = await authFetch("/api/storage");
        if (!response.ok) return;
        const data = await response.json();
        if (active) setStorage(data);
      } catch {
        // The header remains usable if storage statistics are temporarily unavailable.
      }
    };

    loadStorage();
    const timer = window.setInterval(loadStorage, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isAuthenticated]);

  const formatBytes = (bytes: number, fractionDigits?: number) => {
    const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
      value /= 1000;
      unit++;
    }
    const digits = fractionDigits ?? (unit >= 3 ? 2 : 1);
    return `${value.toLocaleString("ru-RU", { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${units[unit]}`;
  };

  const formatUptime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
  };

  const diskPercentColor = (pct: number) =>
    pct >= 90 ? "text-red-500" : pct >= 70 ? "text-yellow-500" : "text-green-500";

  const navItems = [
    { href: "/dashboard", label: t("dashboard") },
    { href: "/nodes", label: t("nodes") },
    { href: "/users", label: t("users") },
    { href: "/export", label: t("export"), icon: FileClock },
    { href: "/blacklist", label: t("blacklist") },
    { href: "/threatintel", label: t("threatIntel"), icon: ShieldAlert },
    { href: "/remnawave", label: t("remnawave"), icon: Smartphone },
    { href: "/correlation", label: t("correlation"), icon: Network },
    { href: "/bridge-users", label: t("bridgeUsers"), icon: Route },
    { href: "/admin", label: t("admin"), icon: Settings },
  ];

  // Don't show header on login page
  if (pathname === "/login") {
    return null;
  }

  return (
    <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="flex h-14 items-center px-4 md:px-8">
        <Link href="/dashboard" className="flex items-center gap-2 font-bold">
          <Activity className="h-5 w-5 text-primary" />
          <span className="hidden sm:inline">{t("appName")}</span>
          <span className="sm:hidden">XRAY</span>
        </Link>

        <div className="ml-auto flex items-center gap-2">
          {/* Subsystem readings and disk usage share one piece of glass with
              hairline separators, so the header carries a single object
              instead of five pills of five different widths. */}
          <div className="glass hidden items-center gap-1 p-1 xl:flex">
            <ServiceStatusTiles />
            {storage && (
              <span
                className={cn(
                  "ml-1 flex items-center gap-1 border-l pl-2.5 pr-1.5 text-xs font-medium tabular-nums",
                  diskPercentColor(storage.disk_used_percent)
                )}
                style={{ borderColor: "rgb(var(--glass-hairline) / var(--glass-hairline-opacity))" }}
                title={t("diskUsedTooltip", {
                  percent: storage.disk_used_percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 }),
                  analyzer: formatBytes(storage.analyzer_bytes),
                  db: formatBytes(storage.database_bytes),
                  wal: formatBytes(storage.wal_bytes),
                  free: formatBytes(storage.disk_free_bytes),
                })}
              >
                <HardDrive className="h-3.5 w-3.5" />
                {storage.disk_used_percent.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}%
              </span>
            )}
            {storage && (
              <span
                className="flex items-center gap-1 border-l pl-2.5 pr-1.5 text-xs font-medium tabular-nums text-muted-foreground"
                style={{ borderColor: "rgb(var(--glass-hairline) / var(--glass-hairline-opacity))" }}
                title={t("dbSizeTooltip")}
              >
                <Database className="h-3.5 w-3.5" />
                {formatBytes(storage.database_bytes, 1)}
              </span>
            )}
            {storage && (
              <span
                className="flex items-center gap-1 border-l pl-2.5 pr-1.5 text-xs font-medium tabular-nums text-muted-foreground"
                style={{ borderColor: "rgb(var(--glass-hairline) / var(--glass-hairline-opacity))" }}
                title={t("diskFreeTooltip")}
              >
                <HardDriveDownload className="h-3.5 w-3.5" />
                {formatBytes(storage.disk_free_bytes, 1)}
              </span>
            )}
            {storage && (
              <span
                className="flex items-center gap-1 border-l pl-2.5 pr-1.5 text-xs font-medium tabular-nums text-muted-foreground"
                style={{ borderColor: "rgb(var(--glass-hairline) / var(--glass-hairline-opacity))" }}
                title={t("uptimeTooltip")}
              >
                <Clock className="h-3.5 w-3.5" />
                {formatUptime(storage.uptime_seconds)}
              </span>
            )}
            <span
              className="flex items-center gap-1 border-l pl-2.5 pr-1.5 text-xs font-medium tabular-nums text-muted-foreground"
              style={{ borderColor: "rgb(var(--glass-hairline) / var(--glass-hairline-opacity))" }}
              title={t("onlineUsersTooltip")}
            >
              <Users className="h-3.5 w-3.5" />
              {dashboardStats.online_users.toLocaleString("ru-RU")}
            </span>
          </div>
          {storage && (
            <span
              className={cn(
                "hidden sm:inline-flex xl:hidden items-center gap-2 whitespace-nowrap rounded-full bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground"
              )}
              title={t("diskUsedTooltipFull", {
                percent: storage.disk_used_percent.toLocaleString("ru-RU", { maximumFractionDigits: 1 }),
                analyzer: formatBytes(storage.analyzer_bytes),
                db: formatBytes(storage.database_bytes),
                chronology: formatBytes(storage.chronology_bytes),
                wal: formatBytes(storage.wal_bytes),
                free: formatBytes(storage.disk_free_bytes),
                uptime: formatUptime(storage.uptime_seconds),
              })}
            >
              <span className={cn("flex items-center gap-1", diskPercentColor(storage.disk_used_percent))}>
                <HardDrive className="h-3.5 w-3.5" />
                {storage.disk_used_percent.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}%
              </span>
              <span className="flex items-center gap-1">
                <Database className="h-3.5 w-3.5" />
                {formatBytes(storage.database_bytes, 1)}
              </span>
              <span className="flex items-center gap-1">
                <HardDriveDownload className="h-3.5 w-3.5" />
                {formatBytes(storage.disk_free_bytes, 1)}
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {formatUptime(storage.uptime_seconds)}
              </span>
              <span className="flex items-center gap-1">
                <Users className="h-3.5 w-3.5" />
                {dashboardStats.online_users.toLocaleString("ru-RU")}
              </span>
            </span>
          )}
          <LanguageSwitcher />
          <ThemeToggle />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAiHidden(!aiHidden)}
            title={aiHidden ? tTiles("showAiChat") : tTiles("hideAiChat")}
            aria-pressed={!aiHidden}
            className={aiHidden ? "text-muted-foreground" : "text-purple-500"}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
          {isAuthenticated && (
            <Button
              variant="ghost"
              size="sm"
              onClick={logout}
              className="text-muted-foreground hover:text-foreground hidden md:flex"
            >
              <LogOut className="h-4 w-4 mr-1" />
              {t("logout")}
            </Button>
          )}

          {/* Mobile menu button */}
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          >
            {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
        </div>
      </div>

      {/* Desktop navigation: two balanced rows of independent buttons */}
      {/* One segmented control on a single piece of glass.
          The old 5-column grid forced nine items into ten cells and left the
          tenth visibly empty, and gave every destination an identical bordered
          box — no hierarchy, maximum chrome. Pills wrap naturally, so the row
          is always full whatever the item count. */}
      <nav className="hidden px-4 pb-3 md:block md:px-8">
        <div className="glass flex flex-wrap items-center gap-1 p-1">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              data-active={pathname === item.href}
              className={cn(
                "seg-item flex h-8 flex-1 items-center justify-center gap-1.5 px-3 text-[13px] font-medium whitespace-nowrap",
                pathname === item.href ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {item.icon && <item.icon className="h-3.5 w-3.5 shrink-0" />}
              {item.label}
            </Link>
          ))}
        </div>
      </nav>

      {/* Mobile navigation */}
      {mobileMenuOpen && (
        <div className="md:hidden border-t bg-background">
          <nav className="flex flex-col p-4 space-y-3">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(
                  "text-sm font-medium transition-colors hover:text-primary flex items-center gap-2 py-2",
                  pathname === item.href
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {item.icon && <item.icon className="h-4 w-4" />}
                {item.label}
              </Link>
            ))}
            <ServiceStatusTiles className="flex-wrap" />
            {storage && (
              <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <span className={cn("flex items-center gap-1", diskPercentColor(storage.disk_used_percent))}>
                  <HardDrive className="h-4 w-4" />
                  {storage.disk_used_percent.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}%
                </span>
                <span className="flex items-center gap-1">
                  <Database className="h-4 w-4" />
                  {formatBytes(storage.database_bytes, 1)}
                </span>
                <span className="flex items-center gap-1">
                  <HardDriveDownload className="h-4 w-4" />
                  {formatBytes(storage.disk_free_bytes, 1)}
                </span>
                <span className="flex items-center gap-1">
                  <Clock className="h-4 w-4" />
                  {formatUptime(storage.uptime_seconds)}
                </span>
                <span className="flex items-center gap-1">
                  <Users className="h-4 w-4" />
                  {dashboardStats.online_users.toLocaleString("ru-RU")}
                </span>
              </div>
            )}
            <div className="pt-2 border-t">
              {isAuthenticated && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    logout();
                    setMobileMenuOpen(false);
                  }}
                  className="text-muted-foreground hover:text-foreground w-full justify-start"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  {t("logout")}
                </Button>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
