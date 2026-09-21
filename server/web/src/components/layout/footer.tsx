"use client";

import { useTranslations } from "next-intl";
import { Activity } from "lucide-react";

/**
 * Page footer.
 *
 * Deliberately quiet: it closes the page and says what the build is, without
 * competing with the data above it.
 */
export function Footer() {
  const t = useTranslations("footer");
  const tNav = useTranslations("nav");
  const year = new Date().getFullYear();

  return (
    <footer className="mx-auto mt-8 max-w-[1600px] px-4 pb-6 md:px-8">
      <div className="glass flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <div className="leading-tight">
            <p className="text-sm font-medium">{tNav("appName")}</p>
            <p className="text-xs text-muted-foreground">{t("tagline")}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{t("readOnly")}</span>
          <span className="hidden sm:inline">·</span>
          <span>{t("copyright", { year })}</span>
        </div>
      </div>
    </footer>
  );
}
