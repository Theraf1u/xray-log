'use client'

import { useRef, useEffect, useState } from 'react'
import {
  Trash2,
  Link2,
  Unlink,
  Users,
  ShieldAlert,
  Zap,
  Copy,
  Check,
  Globe,
  Activity,
  MoreVertical,
  ArrowDown,
  ArrowUp,
} from 'lucide-react'
import { useTranslations } from 'next-intl'
import { isValidDate, formatRelativeTime } from '@/lib/utils/date'
import { NodeStats, NodeLiveView } from '@/lib/types'
import { LinkNodeSheet } from './link-node-sheet'
import { authFetch } from '@/contexts/auth-context'
import { FlagIcon } from '@/components/ui/flag-icon'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'

const LIVE_POLL_MS = 1000

// One fixed column template shared by every row, so a value in one tile
// lands in exactly the same horizontal position as the same field in every
// other tile — the whole point of a grid over a wrapping flex row. Widths
// are sized with headroom for the largest realistic value in each column
// (see formatCompact/formatBitsPerSec), not the current content, so a
// number growing a digit doesn't reflow the column.
const GRID_COLS =
  'grid-cols-[minmax(180px,1.4fr)_128px_56px_84px_104px_80px_68px_150px_92px_28px]'

function formatBytesShort(bytes: number): string {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ']
  let value = Math.max(0, bytes)
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: unit >= 3 ? 2 : 1 })} ${units[unit]}`
}

// Bandwidth is conventionally shown in bits, not bytes, per second.
function formatBitsPerSec(bytesPerSec: number): string {
  const bits = Math.max(0, bytesPerSec) * 8
  const units = ['bit/s', 'Kb/s', 'Mb/s', 'Gb/s']
  let value = bits
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toLocaleString('ru-RU', { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`
}

// Gamer/trader-style compact counts (10 000 -> "10к", 1 377 737 -> "1,4кк"):
// two significant figures — one decimal under 10 of the unit, whole number
// at or above it. Keeps every count on this dense a row to at most 4-5
// characters regardless of how large the underlying number gets.
function formatCompact(n: number): string {
  if (n < 1000) return n.toLocaleString('ru-RU')
  const tiers: Array<{ threshold: number; divisor: number; suffix: string }> = [
    { threshold: 1_000_000, divisor: 1_000_000, suffix: 'кк' },
    { threshold: 1_000, divisor: 1_000, suffix: 'к' },
  ]
  for (const tier of tiers) {
    if (n >= tier.threshold) {
      const value = n / tier.divisor
      const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
      return `${rounded.toLocaleString('ru-RU')}${tier.suffix}`
    }
  }
  return n.toLocaleString('ru-RU')
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

interface NodesTableProps {
  nodes: NodeStats[]
  onDeleteNode?: (nodeId: string) => void
  onDelete?: (nodeId: string) => void
  showActions?: boolean
}

// Store previous values for change tracking
interface PrevNodeState {
  is_connected: boolean
  blacklist_hits: number
  online_users: number
}

export function NodesTable({ nodes, onDeleteNode, onDelete, showActions }: NodesTableProps) {
  const t = useTranslations('nodesTable')
  // Support both variants: onDeleteNode and onDelete
  const handleDelete = onDeleteNode || onDelete
  const showDeleteButton = showActions || !!handleDelete

  const prevNodesRef = useRef<Map<string, PrevNodeState>>(new Map())
  const [changedNodes, setChangedNodes] = useState<Map<string, {
    statusChanged: boolean
    blacklistIncreased: boolean
    onlineChanged: boolean
  }>>(new Map())

  const [linkTarget, setLinkTarget] = useState<string | null>(null)
  const [unlinking, setUnlinking] = useState<string | null>(null)
  const [copiedNodeId, setCopiedNodeId] = useState<string | null>(null)
  const [live, setLive] = useState<Map<string, NodeLiveView>>(new Map())

  // Live telemetry (speed, xray uptime, live online count) changes every
  // second on the panel side, so it is polled on its own short interval
  // rather than riding the WS-pushed `nodes` array, which only carries data
  // that changes on the order of the agent's own batch cadence.
  useEffect(() => {
    let active = true
    const poll = async () => {
      try {
        const res = await authFetch('/api/nodes/live')
        if (!res.ok) return
        const data: NodeLiveView[] = await res.json()
        if (!active) return
        setLive(new Map((data ?? []).map((v) => [v.node_id, v])))
      } catch {
        // A missed tick just means the next one keeps the previous values.
      }
    }
    poll()
    const timer = window.setInterval(poll, LIVE_POLL_MS)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  // Linking/unlinking just writes node_remna_map server-side; the WS push
  // (useWsNodes in the parent) picks up the enriched fields on its own next
  // tick, same as every other live stat on this table.
  const unlink = async (nodeId: string) => {
    setUnlinking(nodeId)
    try {
      await authFetch('/api/nodes/unlink-remnawave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ node_id: nodeId }),
      })
    } finally {
      setUnlinking(null)
    }
  }

  const copyText = async (nodeId: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopiedNodeId(nodeId)
      setTimeout(() => setCopiedNodeId((v) => (v === nodeId ? null : v)), 1500)
    } catch {
      // Clipboard API can be denied (insecure context, permissions) — the
      // value is still plain selectable text in the tile either way.
    }
  }

  useEffect(() => {
    const newChanges = new Map<string, {
      statusChanged: boolean
      blacklistIncreased: boolean
      onlineChanged: boolean
    }>()

    nodes.forEach(node => {
      const prev = prevNodesRef.current.get(node.node_id)

      if (prev) {
        const statusChanged = prev.is_connected !== node.is_connected
        const blacklistIncreased = node.blacklist_hits > prev.blacklist_hits
        const onlineChanged = prev.online_users !== node.online_users

        if (statusChanged || blacklistIncreased || onlineChanged) {
          newChanges.set(node.node_id, {
            statusChanged,
            blacklistIncreased,
            onlineChanged
          })
        }
      }
    })

    if (newChanges.size > 0) {
      setChangedNodes(newChanges)

      // Remove animation after 2 seconds
      const timer = setTimeout(() => {
        setChangedNodes(new Map())
      }, 2000)

      return () => clearTimeout(timer)
    }

    // Save current state
    const newPrevMap = new Map<string, PrevNodeState>()
    nodes.forEach(node => {
      newPrevMap.set(node.node_id, {
        is_connected: node.is_connected,
        blacklist_hits: node.blacklist_hits,
        online_users: node.online_users
      })
    })
    prevNodesRef.current = newPrevMap
  }, [nodes])

  // Update prevNodesRef after each render
  useEffect(() => {
    const newPrevMap = new Map<string, PrevNodeState>()
    nodes.forEach(node => {
      newPrevMap.set(node.node_id, {
        is_connected: node.is_connected,
        blacklist_hits: node.blacklist_hits,
        online_users: node.online_users
      })
    })
    prevNodesRef.current = newPrevMap
  }, [nodes])

  return (
    <div className="overflow-x-auto">
    <div className="flex min-w-[1020px] flex-col gap-2">
      {nodes.map((node) => {
        const changes = changedNodes.get(node.node_id)
        const displayName = node.remna_name || node.node_id
        const liveNode = live.get(node.node_id)

        // Three states, per panel status rather than our own agent's WS
        // status: connected (green), unlinked-or-offline (red), or disabled
        // in the panel on purpose (neutral — not a problem, so no tint).
        const isDisabledInPanel = liveNode?.remna_is_disabled ?? node.remna_is_disabled ?? false
        const isConnectedInPanel = liveNode?.remna_is_connected ?? node.remna_is_connected ?? false
        const tileStatusClass = isDisabledInPanel
          ? ''
          : isConnectedInPanel
            ? 'glass-tile-online'
            : 'glass-tile-offline'

        const usersOnline = liveNode?.remna_users_online ?? node.online_users
        // xray-core's own uptime (Remnawave's xrayUptime field), never this
        // panel's own process uptime — those are unrelated numbers and
        // mixing them up was a real bug earlier in this build.
        const uptimeSeconds = liveNode?.xray_uptime_seconds
        const rxBps = liveNode?.rx_bytes_per_sec
        const txBps = liveNode?.tx_bytes_per_sec

        const trafficPct =
          node.remna_traffic_total && node.remna_traffic_total > 0 && node.remna_traffic_used !== undefined
            ? Math.min(100, (node.remna_traffic_used / node.remna_traffic_total) * 100)
            : null

        return (
          <div
            key={node.node_id}
            className={`glass-tile group relative ${GRID_COLS} grid items-center gap-x-4 gap-y-1.5 p-3 transition-colors ${tileStatusClass} ${
              changes?.statusChanged
                ? node.is_connected
                  ? 'ring-2 ring-green-500/60'
                  : 'ring-2 ring-red-500/60'
                : ''
            }`}
          >
            {/* Col 1: identity — status, flag, name, tags */}
            <div className="flex min-w-0 items-center gap-2.5">
              <span
                title={
                  isDisabledInPanel
                    ? t('disabledInPanel')
                    : isConnectedInPanel
                      ? t('statusOnline')
                      : t('statusOffline')
                }
                className={
                  isDisabledInPanel
                    ? 'h-2.5 w-2.5 shrink-0 rounded-full bg-muted-foreground/30'
                    : isConnectedInPanel
                      ? 'h-2.5 w-2.5 shrink-0 rounded-full bg-green-500'
                      : 'h-2.5 w-2.5 shrink-0 rounded-full bg-red-500'
                }
              />
              <FlagIcon countryCode={node.remna_country_code} className="h-5 w-7 shrink-0 text-base" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-base font-semibold leading-tight">{displayName}</span>
                {node.remna_tags && node.remna_tags.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {node.remna_tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Col 2: IP */}
            {node.remna_address ? (
              <button
                onClick={() => copyText(node.node_id, node.remna_address!)}
                title={t('copyAddress')}
                className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground hover:text-foreground"
              >
                {copiedNodeId === node.node_id ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-green-500" />
                ) : (
                  <Globe className="h-3.5 w-3.5 shrink-0 opacity-60" />
                )}
                <span className="truncate">{node.remna_address}</span>
              </button>
            ) : (
              <span />
            )}

            {/* Col 3: port */}
            {node.remna_port ? (
              <span className="rounded bg-white/5 px-1.5 py-0.5 text-center font-mono text-xs text-muted-foreground">
                :{node.remna_port}
              </span>
            ) : (
              <span />
            )}

            {/* Col 4: online users */}
            <span
              title={t('online')}
              className="flex w-fit items-center gap-1.5 rounded-full border border-primary/30 px-2.5 py-1 text-sm font-medium text-primary tabular-nums"
            >
              <Users className="h-3.5 w-3.5" />
              {usersOnline.toLocaleString('ru-RU')}
            </span>

            {/* Col 5: live throughput */}
            {(rxBps !== undefined || txBps !== undefined) ? (
              <div className="flex flex-col gap-0.5 text-xs tabular-nums text-muted-foreground">
                {rxBps !== undefined && (
                  <span className="flex items-center gap-1">
                    <ArrowDown className="h-3 w-3 shrink-0 text-green-500/70" />
                    {formatBitsPerSec(rxBps)}
                  </span>
                )}
                {txBps !== undefined && (
                  <span className="flex items-center gap-1">
                    <ArrowUp className="h-3 w-3 shrink-0 text-blue-500/70" />
                    {formatBitsPerSec(txBps)}
                  </span>
                )}
              </div>
            ) : (
              <span />
            )}

            {/* Col 6: requests */}
            <span title={`${node.total_requests.toLocaleString('ru-RU')} ${t('requests')}`} className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
              <Activity className="h-3 w-3 shrink-0 opacity-60" />
              {formatCompact(node.total_requests)}
            </span>

            {/* Col 7: blacklist */}
            {node.blacklist_hits > 0 ? (
              <span
                title={`${node.blacklist_hits.toLocaleString('ru-RU')} ${t('blacklist')}`}
                className={`flex items-center gap-1 text-xs font-medium tabular-nums ${
                  changes?.blacklistIncreased ? 'font-bold text-red-500' : 'text-red-500/80'
                }`}
              >
                <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
                {formatCompact(node.blacklist_hits)}
              </span>
            ) : (
              <span />
            )}

            {/* Col 8: traffic, with a quota bar when the panel reports a limit */}
            {node.remna_traffic_used !== undefined && node.remna_traffic_used > 0 ? (
              <div className="flex min-w-0 flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-semibold tabular-nums">{formatBytesShort(node.remna_traffic_used)}</span>
                  <span className="text-[11px] text-muted-foreground/60">
                    {trafficPct !== null && node.remna_traffic_total
                      ? formatBytesShort(node.remna_traffic_total)
                      : '∞'}
                  </span>
                </div>
                {trafficPct !== null && (
                  <div className="h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full bg-primary/70" style={{ width: trafficPct + '%' }} />
                  </div>
                )}
              </div>
            ) : (
              <span />
            )}

            {/* Col 9: uptime + last activity */}
            <div className="flex flex-col items-end gap-0.5 text-xs">
              {uptimeSeconds !== undefined && isConnectedInPanel ? (
                <span
                  title={t('uptime')}
                  className="flex items-center gap-1 font-medium text-primary tabular-nums"
                >
                  <Zap className="h-3.5 w-3.5" />
                  {formatUptime(uptimeSeconds)}
                </span>
              ) : (
                <span className="text-muted-foreground/50">
                  {isDisabledInPanel ? t('disabledInPanel') : t('statusOffline')}
                </span>
              )}
              <span className="whitespace-nowrap text-muted-foreground/60">
                {isValidDate(node.last_seen) ? formatRelativeTime(node.last_seen) : t('never')}
              </span>
            </div>

            {/* Col 10: actions */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="justify-self-end rounded-md p-1 text-muted-foreground/40 hover:text-foreground">
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {node.remna_address ? (
                  <DropdownMenuItem onClick={() => unlink(node.node_id)} disabled={unlinking === node.node_id}>
                    <Unlink className="mr-2 h-3.5 w-3.5" />
                    {t('unlink')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => setLinkTarget(node.node_id)}>
                    <Link2 className="mr-2 h-3.5 w-3.5" />
                    {t('linkToPanel')}
                  </DropdownMenuItem>
                )}
                {showDeleteButton && handleDelete && (
                  <DropdownMenuItem onClick={() => handleDelete(node.node_id)} variant="destructive">
                    <Trash2 className="mr-2 h-3.5 w-3.5" />
                    {t('delete')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      })}

      <LinkNodeSheet
        nodeId={linkTarget ?? ''}
        open={linkTarget !== null}
        onOpenChange={(o) => !o && setLinkTarget(null)}
        onLinked={() => {}}
      />
    </div>
    </div>
  )
}
