"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import MapboxMap, { Source, Layer, Marker, Popup } from "react-map-gl/mapbox";
import type { MapRef } from "react-map-gl/mapbox";
import type { LayerProps } from "react-map-gl/mapbox";
import type { Feature, LineString } from "geojson";
import "mapbox-gl/dist/mapbox-gl.css";
import { authFetch } from "@/contexts/auth-context";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MapPin, Ruler, X } from "lucide-react";
import { UserIPHistory } from "@/lib/types";
import { prefetchIPInfoBatch, getCachedIPInfo } from "@/components/ui/ip-info-badge";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

interface LocationPoint {
  key: string;
  latitude: number;
  longitude: number;
  city: string;
  country: string;
  ips: string[];
  requestCount: number;
}

// Great-circle distance (haversine) — good enough for "how far apart are
// these two exit IPs", not meant to be geodesy-grade.
function haversineKm(a: LocationPoint, b: LocationPoint): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
  const lat1 = (a.latitude * Math.PI) / 180;
  const lat2 = (b.latitude * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function formatDistance(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} м`;
  return `${km.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
}

const lineLayer: LayerProps = {
  id: "distance-line",
  type: "line",
  paint: {
    "line-color": "#f59e0b",
    "line-width": 2.5,
    "line-dasharray": [2, 1.5],
  },
};

function pointsFromHistory(history: UserIPHistory[]): LocationPoint[] {
  const byKey = new Map<string, LocationPoint>();
  for (const h of history) {
    const info = getCachedIPInfo(h.ip_address);
    if (!info || (info.lat === 0 && info.lon === 0) || info.country === "Private") continue;
    const key = `${info.lat.toFixed(2)},${info.lon.toFixed(2)}`;
    const existing = byKey.get(key);
    if (existing) {
      if (!existing.ips.includes(h.ip_address)) existing.ips.push(h.ip_address);
      existing.requestCount += h.request_count;
    } else {
      byKey.set(key, {
        key,
        latitude: info.lat,
        longitude: info.lon,
        city: info.city,
        country: info.country,
        ips: [h.ip_address],
        requestCount: h.request_count,
      });
    }
  }
  return Array.from(byKey.values());
}

interface UserLocationMapProps {
  email: string;
}

// One marker per distinct location (IPs resolving to the same city/coords
// are merged, so repeated logins from the same place render one pin, not a
// stack of identical ones). Click one marker, then another, to draw a line
// between them and read the great-circle distance — click a third to start
// a fresh pair.
export function UserLocationMap({ email }: UserLocationMapProps) {
  const t = useTranslations("users");
  const mapRef = useRef<MapRef>(null);
  const [points, setPoints] = useState<LocationPoint[] | null>(null);
  const [selected, setSelected] = useState<LocationPoint[]>([]);
  const [hovered, setHovered] = useState<LocationPoint | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPoints(null);
    setSelected([]);
    async function run() {
      try {
        const res = await authFetch(`/api/users/${encodeURIComponent(email)}/ip-history`);
        if (!res.ok) throw new Error("failed");
        const data: UserIPHistory[] = (await res.json()) || [];
        if (cancelled) return;
        if (data.length > 0) {
          await prefetchIPInfoBatch(data.map((ip) => ip.ip_address));
        }
        if (cancelled) return;
        setPoints(pointsFromHistory(data));
      } catch {
        if (!cancelled) setPoints([]);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [email]);

  const lineFeature: Feature<LineString> | null = useMemo(() => {
    if (selected.length !== 2) return null;
    return {
      type: "Feature",
      properties: {},
      geometry: {
        type: "LineString",
        coordinates: [
          [selected[0].longitude, selected[0].latitude],
          [selected[1].longitude, selected[1].latitude],
        ],
      },
    };
  }, [selected]);

  const distanceKm = selected.length === 2 ? haversineKm(selected[0], selected[1]) : null;

  const initialView = useMemo(() => {
    if (!points || points.length === 0) return { longitude: 40, latitude: 55, zoom: 2.5 };
    const avgLon = points.reduce((s, p) => s + p.longitude, 0) / points.length;
    const avgLat = points.reduce((s, p) => s + p.latitude, 0) / points.length;
    return { longitude: avgLon, latitude: avgLat, zoom: points.length === 1 ? 6 : 3.5 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points?.length]);

  const pickPoint = (p: LocationPoint) => {
    setSelected(
      selected.length === 0
        ? [p]
        : selected.length === 1
          ? selected[0].key === p.key
            ? []
            : [selected[0], p]
          : [p]
    );
  };

  if (!MAPBOX_TOKEN) return null;

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <CardTitle className="text-base sm:text-lg flex items-center gap-2">
          <MapPin className="h-4 w-4 text-blue-500" />
          {t("locationMapTitle")}
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">{t("locationMapDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {distanceKm !== null && selected.length === 2 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm">
            <Ruler className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="font-medium">{selected[0].city || selected[0].country}</span>
            <span className="text-muted-foreground">↔</span>
            <span className="font-medium">{selected[1].city || selected[1].country}</span>
            <span className="font-mono text-amber-600 dark:text-amber-400">
              {formatDistance(distanceKm)}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 shrink-0"
              onClick={() => setSelected([])}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {points === null ? (
          <div className="flex h-[360px] items-center justify-center text-muted-foreground text-sm">
            {t("locationMapLoading")}
          </div>
        ) : points.length === 0 ? (
          <div className="flex h-[200px] flex-col items-center justify-center text-muted-foreground">
            <MapPin className="h-8 w-8 opacity-30 mb-2" />
            <p className="text-sm">{t("locationMapEmpty")}</p>
          </div>
        ) : (
          <div className="relative h-[360px] overflow-hidden rounded-[var(--radius)]">
            <MapboxMap
              ref={mapRef}
              mapboxAccessToken={MAPBOX_TOKEN}
              initialViewState={initialView}
              style={{ width: "100%", height: "100%" }}
              mapStyle="mapbox://styles/mapbox/dark-v11"
              attributionControl={false}
            >
              {lineFeature && (
                <Source id="distance-line-src" type="geojson" data={lineFeature}>
                  <Layer {...lineLayer} />
                </Source>
              )}

              {points.map((p) => {
                const isSelected = selected.some((s) => s.key === p.key);
                return (
                  <Marker
                    key={p.key}
                    longitude={p.longitude}
                    latitude={p.latitude}
                    onClick={(e) => {
                      e.originalEvent.stopPropagation();
                      pickPoint(p);
                    }}
                  >
                    <button
                      type="button"
                      onMouseEnter={() => setHovered(p)}
                      onMouseLeave={() => setHovered(null)}
                      className="flex items-center justify-center rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        width: isSelected ? 18 : 14,
                        height: isSelected ? 18 : 14,
                        background: isSelected ? "rgba(245, 158, 11, 0.9)" : "rgba(59, 130, 246, 0.75)",
                        borderColor: "rgba(255,255,255,0.85)",
                        cursor: "pointer",
                      }}
                    />
                  </Marker>
                );
              })}

              {hovered && !selected.some((s) => s.key === hovered.key) && (
                <Popup
                  longitude={hovered.longitude}
                  latitude={hovered.latitude}
                  anchor="bottom"
                  closeButton={false}
                  closeOnClick={false}
                  className="geo-popup"
                >
                  <div className="p-2 min-w-[120px] bg-zinc-900 text-white rounded-lg text-sm">
                    <div className="font-medium">{hovered.city || hovered.country}</div>
                    {hovered.city && hovered.country && (
                      <div className="text-xs text-zinc-400">{hovered.country}</div>
                    )}
                    <div className="mt-1 text-xs text-zinc-400">
                      {hovered.ips.length} IP · {hovered.requestCount.toLocaleString()} {t("requests")}
                    </div>
                  </div>
                </Popup>
              )}
            </MapboxMap>

            <div className="absolute bottom-2 left-2 rounded-md bg-background/90 px-2 py-1.5 text-xs text-muted-foreground backdrop-blur-sm">
              {selected.length === 0 && t("locationMapHintPickFirst")}
              {selected.length === 1 && t("locationMapHintPickSecond")}
              {selected.length === 2 && t("locationMapHintReset")}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
