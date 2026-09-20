"use client";

import { useMemo, useState } from "react";
import { Download, FileClock, FileSpreadsheet, Loader2, Search } from "lucide-react";
import { useWsUsers } from "@/contexts/websocket-context";
import { authFetch } from "@/contexts/auth-context";
import { UserStats } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Period = "1h" | "12h" | "24h" | "7d" | "14d" | "30d" | "all";
type RequestEvent = {
  timestamp: string; node_id: string; source_ip: string; source_port: number;
  protocol: string; destination: string; inbound: string; outbound: string; status: string;
};

const periods: Array<{ value: Period; label: string }> = [
  { value: "1h", label: "1 час" }, { value: "12h", label: "12 часов" },
  { value: "24h", label: "24 часа" }, { value: "7d", label: "7 дней" },
  { value: "14d", label: "14 дней" }, { value: "30d", label: "30 дней" },
  { value: "all", label: "За всё время" },
];

const timezones = [
  { value: "Europe/Moscow", label: "Москва (UTC+3)" },
  { value: "UTC", label: "UTC (UTC+0)" },
  { value: "Europe/Kaliningrad", label: "Калининград (UTC+2)" },
  { value: "Europe/Samara", label: "Самара (UTC+4)" },
  { value: "Asia/Yekaterinburg", label: "Екатеринбург (UTC+5)" },
  { value: "Asia/Omsk", label: "Омск (UTC+6)" },
  { value: "Asia/Novosibirsk", label: "Новосибирск (UTC+7)" },
  { value: "Asia/Irkutsk", label: "Иркутск (UTC+8)" },
  { value: "Asia/Yakutsk", label: "Якутск (UTC+9)" },
  { value: "Asia/Vladivostok", label: "Владивосток (UTC+10)" },
  { value: "Asia/Magadan", label: "Магадан (UTC+11)" },
  { value: "Asia/Kamchatka", label: "Камчатка (UTC+12)" },
] as const;

export default function ExportPage() {
  const { users, loading } = useWsUsers();
  const [search, setSearch] = useState("");
  const [node, setNode] = useState("all");
  const [selected, setSelected] = useState<UserStats | null>(null);
  const [period, setPeriod] = useState<Period>("24h");
  const [timezone, setTimezone] = useState("Europe/Moscow");
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const nodes = useMemo(() => Array.from(new Set(users.flatMap(u => u.node_id.split(",").map(v => v.trim())).filter(Boolean))).sort(), [users]);
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return users.filter(u => {
      const nodeMatch = node === "all" || u.node_id.split(",").map(v => v.trim()).includes(node);
      const textMatch = !needle || u.username.toLowerCase().includes(needle) || u.node_id.toLowerCase().includes(needle) || (u.last_ip || "").toLowerCase().includes(needle);
      return nodeMatch && textMatch;
    }).slice(0, 100);
  }, [users, search, node]);

  async function loadPreview(user = selected, selectedPeriod = period) {
    if (!user) return;
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ user: user.username, period: selectedPeriod, tz: timezone, limit: "200" });
      const res = await authFetch(`/api/export/user?${query}`);
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      setEvents(body.events || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить журнал");
      setEvents([]);
    } finally { setBusy(false); }
  }

  async function downloadFile(format: "csv" | "xlsx") {
    if (!selected) return;
    setBusy(true); setError("");
    try {
      const query = new URLSearchParams({ user: selected.username, period, tz: timezone, format });
      const res = await authFetch(`/api/export/user?${query}`);
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = match?.[1] || `xray-requests-${period}.${format}`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { setError(e instanceof Error ? e.message : `Не удалось выгрузить ${format.toUpperCase()}`); }
    finally { setBusy(false); }
  }

  return (
    <div className="p-4 md:p-8 space-y-6">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight flex items-center gap-2"><FileClock className="h-6 w-6" />Выгрузка</h2>
        <p className="text-sm text-muted-foreground">Хронология запросов пользователя с точностью до секунды. Срок хранения не ограничен.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>1. Найдите пользователя</CardTitle><CardDescription>Поиск по имени, ноде или последнему IP — как в разделе «Пользователи».</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input className="pl-9" placeholder="Имя, нода или IP..." value={search} onChange={e => setSearch(e.target.value)} /></div>
            <Select value={node} onValueChange={setNode}><SelectTrigger className="w-full sm:w-[220px]"><SelectValue placeholder="Все ноды" /></SelectTrigger><SelectContent><SelectItem value="all">Все ноды</SelectItem>{nodes.map(n => <SelectItem key={n} value={n}>{n}</SelectItem>)}</SelectContent></Select>
          </div>
          {loading ? <div className="text-sm text-muted-foreground">Загрузка пользователей…</div> : (
            <div className="-mx-6 max-h-72 overflow-auto border-t">
              <Table><TableHeader><TableRow><TableHead>Пользователь</TableHead><TableHead>Нода</TableHead><TableHead>IP</TableHead><TableHead /></TableRow></TableHeader>
                <TableBody>{filtered.map(user => <TableRow key={`${user.username}-${user.node_id}`} className={selected?.username === user.username ? "bg-muted" : ""}>
                  <TableCell className="font-medium">{user.username}</TableCell><TableCell className="max-w-[360px] truncate">{user.node_id}</TableCell><TableCell>{user.last_ip || "—"}</TableCell>
                  <TableCell className="text-right"><Button size="sm" variant={selected?.username === user.username ? "default" : "outline"} onClick={() => { setSelected(user); setEvents([]); }}>Выбрать</Button></TableCell>
                </TableRow>)}</TableBody></Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>2. Выберите период и выгрузите</CardTitle><CardDescription>{selected ? <>Выбран: <strong>{selected.username}</strong></> : "Сначала выберите пользователя выше."}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-2">
            <Select value={period} onValueChange={v => { const p = v as Period; setPeriod(p); setEvents([]); }}><SelectTrigger className="w-full sm:w-[180px]"><SelectValue /></SelectTrigger><SelectContent>{periods.map(p => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent></Select>
            <Select value={timezone} onValueChange={v => { setTimezone(v); setEvents([]); }}><SelectTrigger className="w-full sm:w-[230px]"><SelectValue /></SelectTrigger><SelectContent>{timezones.map(zone => <SelectItem key={zone.value} value={zone.value}>{zone.label}</SelectItem>)}</SelectContent></Select>
            <Button variant="outline" disabled={!selected || busy} onClick={() => loadPreview()}>{busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Показать последние 200</Button>
            <Button variant="outline" disabled={!selected || busy} onClick={() => downloadFile("csv")}><Download className="mr-2 h-4 w-4" />Скачать CSV</Button>
            <Button disabled={!selected || busy} onClick={() => downloadFile("xlsx")}><FileSpreadsheet className="mr-2 h-4 w-4" />Скачать XLSX</Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          {selected && events.length === 0 && !busy && <p className="text-sm text-muted-foreground">Для выбранного периода записей пока нет. Новая хронология заполняется с момента установки обновления.</p>}
          {events.length > 0 && <div className="-mx-6 overflow-auto border-t max-h-[600px]"><Table><TableHeader><TableRow><TableHead>Время — {timezones.find(zone => zone.value === timezone)?.label}</TableHead><TableHead>Назначение</TableHead><TableHead>Нода</TableHead><TableHead>IP</TableHead><TableHead>Протокол</TableHead></TableRow></TableHeader><TableBody>
            {events.map((event, i) => <TableRow key={`${event.timestamp}-${i}`}><TableCell className="whitespace-nowrap font-mono">{new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(event.timestamp))}</TableCell><TableCell className="font-medium">{event.destination}</TableCell><TableCell><Badge variant="outline">{event.node_id}</Badge></TableCell><TableCell>{event.source_ip || "—"}</TableCell><TableCell>{event.protocol || "—"}</TableCell></TableRow>)}
          </TableBody></Table></div>}
        </CardContent>
      </Card>
    </div>
  );
}
