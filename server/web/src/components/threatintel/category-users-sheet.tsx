"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { authFetch } from "@/contexts/auth-context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CategoryUserStats } from "@/lib/types";

const PAGE_SIZE = 50;

/**
 * Full per-category user list.
 *
 * The card behind this shows the top ten, which is the right amount for a
 * glance. Everything beyond that lives here rather than turning each of the
 * six category cards into its own long scroller.
 */
export function CategoryUsersSheet({
  category,
  label,
  open,
  onOpenChange,
}: {
  category: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("threatIntel");
  const tCommon = useTranslations("common");
  const [users, setUsers] = useState<CategoryUserStats[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (nextPage: number) => {
      setLoading(true);
      try {
        const res = await authFetch(
          `/api/threatintel/top-users?category=${encodeURIComponent(category)}&page=${nextPage}&page_size=${PAGE_SIZE}`
        );
        if (!res.ok) return;
        const data = await res.json();
        const batch: CategoryUserStats[] = data.users ?? [];
        setTotal(data.total ?? 0);
        setUsers((prev) => (nextPage === 1 ? batch : [...prev, ...batch]));
        setPage(nextPage);
      } catch {
        // Leave whatever is already listed in place.
      } finally {
        setLoading(false);
      }
    },
    [category]
  );

  useEffect(() => {
    if (!open) return;
    setUsers([]);
    setTotal(0);
    load(1);
  }, [open, load]);

  const hasMore = users.length < total;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{label}</SheetTitle>
          <SheetDescription>
            {total > 0 ? t("allUsersCount", { count: total.toLocaleString("ru-RU") }) : tCommon("loading")}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin px-4 pb-4">
          {users.length === 0 && !loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">{tCommon("noData")}</p>
          ) : (
            <div className="-mx-4">
              {users.map((user, index) => (
                <div key={`${user.user_email}-${index}`} className="glass-row flex items-start gap-3 px-4 py-2">
                  <span className="w-7 shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                    {index + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <Link
                        href={`/users/${encodeURIComponent(user.username || user.user_email || "")}`}
                        className="truncate text-sm hover:underline"
                        title={user.username || user.user_email}
                      >
                        {user.username || user.user_email}
                      </Link>
                      <Badge variant="secondary" className="shrink-0 font-mono text-xs">
                        {user.match_count}
                      </Badge>
                    </div>
                    {user.domains && user.domains.length > 0 && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={user.domains.join(", ")}>
                        {user.domains.slice(0, 3).join(", ")}
                        {user.domains.length > 3 && ` +${user.domains.length - 3}`}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {hasMore && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              disabled={loading}
              onClick={() => load(page + 1)}
            >
              {loading ? tCommon("loading") : t("loadMore")}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
