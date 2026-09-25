"use client";

import { useEffect, useState } from "react";
import { authFetch } from "@/contexts/auth-context";
import { UserIPHistory } from "@/lib/types";

// Both UserIPHistoryTable and UserLocationMap need this same list for the
// same user — without a shared cache each one fired its own GET
// /api/users/{email}/ip-history on every profile page load, doubling that
// endpoint's load for no reason. A tiny in-flight/result cache here means
// whichever component asks first triggers the fetch and the other one just
// gets the same promise/result.
const cache = new Map<string, Promise<UserIPHistory[]>>();

function fetchHistory(email: string): Promise<UserIPHistory[]> {
  let inFlight = cache.get(email);
  if (!inFlight) {
    inFlight = authFetch(`/api/users/${encodeURIComponent(email)}/ip-history`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to fetch IP history");
        return (await res.json()) ?? [];
      })
      .catch((err) => {
        cache.delete(email); // don't pin a failed fetch — the next caller should retry
        throw err;
      });
    cache.set(email, inFlight);
  }
  return inFlight;
}

export function useUserIPHistory(email: string): {
  history: UserIPHistory[];
  loading: boolean;
  error: string | null;
} {
  const [history, setHistory] = useState<UserIPHistory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchHistory(email)
      .then((data) => {
        if (!cancelled) setHistory(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "unknown");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return { history, loading, error };
}
