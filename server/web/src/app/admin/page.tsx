"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/contexts/auth-context";
import { Glass, GlassRail, GlassLine } from "@/components/ui/glass";
import { GlassMotif } from "@/components/ui/glass-motif";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Radio, Send, ShieldCheck, TriangleAlert } from "lucide-react";

interface IntegrationView {
  enabled: boolean;
  url?: string;
  token_set: boolean;
  token_masked?: string;
  chat_id?: string;
  topic_id?: string;
  sync_interval_seconds?: number;
  live: boolean;
}

interface AdminSettings {
  remnawave: IntegrationView;
  telegram: IntegrationView;
  updated_at?: string;
  restart_needed?: boolean;
  restart_message?: string;
}

export default function AdminPage() {
  const t = useTranslations("admin");
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<"remnawave" | "telegram" | null>(null);
  const [banner, setBanner] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  // Remnawave form state
  const [rwEnabled, setRwEnabled] = useState(false);
  const [rwUrl, setRwUrl] = useState("");
  const [rwToken, setRwToken] = useState(""); // empty = keep current
  const [rwIntervalMin, setRwIntervalMin] = useState(1);

  // Telegram form state
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgToken, setTgToken] = useState(""); // empty = keep current
  const [tgChatId, setTgChatId] = useState("");
  const [tgTopicId, setTgTopicId] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await authFetch("/api/admin/settings");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: AdminSettings = await res.json();
      setSettings(data);
      setRwEnabled(data.remnawave.enabled);
      setRwUrl(data.remnawave.url ?? "");
      setRwIntervalMin(Math.max(1, Math.round((data.remnawave.sync_interval_seconds ?? 60) / 60)));
      setTgEnabled(data.telegram.enabled);
      setTgChatId(data.telegram.chat_id ?? "");
      setTgTopicId(data.telegram.topic_id ?? "");
    } catch {
      setBanner({ kind: "error", text: t("loadError") });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const saveRemnawave = async () => {
    setSaving("remnawave");
    setBanner(null);
    try {
      const res = await authFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remnawave: {
            enabled: rwEnabled,
            url: rwUrl,
            api_token: rwToken || undefined,
            sync_interval_seconds: rwIntervalMin * 60,
          },
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data: AdminSettings = await res.json();
      setSettings(data);
      setRwToken("");
      setBanner({
        kind: "ok",
        text: data.restart_needed ? data.restart_message || t("restartNeeded") : t("saved"),
      });
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : t("saveError") });
    } finally {
      setSaving(null);
    }
  };

  const saveTelegram = async (sendTest = false) => {
    setSaving("telegram");
    setBanner(null);
    try {
      const res = await authFetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          telegram: {
            enabled: tgEnabled,
            token: tgToken || undefined,
            chat_id: tgChatId,
            topic_id: tgTopicId,
          },
          send_test_message: sendTest,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const testError = res.headers.get("X-Test-Message-Error");
      const data: AdminSettings = await res.json();
      setSettings(data);
      setTgToken("");
      if (sendTest && testError) {
        setBanner({ kind: "error", text: `${t("testMessageFailed")}: ${testError}` });
      } else if (sendTest) {
        setBanner({ kind: "ok", text: t("testMessageSent") });
      } else {
        setBanner({
          kind: "ok",
          text: data.restart_needed ? data.restart_message || t("restartNeeded") : t("saved"),
        });
      }
    } catch (e) {
      setBanner({ kind: "error", text: e instanceof Error ? e.message : t("saveError") });
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">{t("title")}</h2>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {banner && (
        <div
          className={
            banner.kind === "ok"
              ? "flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2.5 text-sm text-green-600"
              : "flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-2.5 text-sm text-destructive"
          }
        >
          {banner.kind === "ok" ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <TriangleAlert className="h-4 w-4 shrink-0" />}
          {banner.text}
        </div>
      )}

      {/* Remnawave */}
      <Glass className="relative overflow-hidden">
        <GlassMotif name="link" />
        <GlassRail
          title={t("remnawaveTitle")}
          hint={settings?.remnawave.live ? t("liveHint") : t("notRunningHint")}
        />
        <GlassLine />
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("enabledLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("remnawaveEnabledDesc")}</p>
            </div>
            <Switch checked={rwEnabled} onCheckedChange={setRwEnabled} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("panelUrlLabel")}</label>
              <Input value={rwUrl} onChange={(e) => setRwUrl(e.target.value)} placeholder="https://panel.example.com" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("syncIntervalLabel")}</label>
              <Input
                type="number"
                min={1}
                value={rwIntervalMin}
                onChange={(e) => setRwIntervalMin(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t("apiTokenLabel")}</label>
            <Input
              value={rwToken}
              onChange={(e) => setRwToken(e.target.value)}
              placeholder={settings?.remnawave.token_set ? settings.remnawave.token_masked : t("noTokenSet")}
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">{t("tokenFieldHint")}</p>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={saveRemnawave} disabled={saving === "remnawave"}>
              {saving === "remnawave" ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      </Glass>

      {/* Telegram */}
      <Glass className="relative overflow-hidden">
        <GlassMotif name="stream" />
        <GlassRail
          title={t("telegramTitle")}
          hint={settings?.telegram.live ? t("liveHint") : t("notRunningHint")}
        />
        <GlassLine />
        <div className="space-y-4 px-5 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{t("enabledLabel")}</p>
              <p className="text-xs text-muted-foreground">{t("telegramEnabledDesc")}</p>
            </div>
            <Switch checked={tgEnabled} onCheckedChange={setTgEnabled} />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">{t("botTokenLabel")}</label>
            <Input
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              placeholder={settings?.telegram.token_set ? settings.telegram.token_masked : t("noTokenSet")}
              className="font-mono"
            />
            <p className="text-[11px] text-muted-foreground">{t("tokenFieldHint")}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("chatIdLabel")}</label>
              <Input value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} placeholder="-1001234567890" className="font-mono" />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">{t("topicIdLabel")}</label>
              <Input value={tgTopicId} onChange={(e) => setTgTopicId(e.target.value)} placeholder={t("topicIdPlaceholder")} className="font-mono" />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("topicIdHint")}</p>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="outline" onClick={() => saveTelegram(true)} disabled={saving === "telegram"}>
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {t("saveAndTest")}
            </Button>
            <Button size="sm" onClick={() => saveTelegram(false)} disabled={saving === "telegram"}>
              {saving === "telegram" ? t("saving") : t("save")}
            </Button>
          </div>
        </div>
      </Glass>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Radio className="h-3.5 w-3.5" />
        {t("footerNote")}
      </div>
    </div>
  );
}
