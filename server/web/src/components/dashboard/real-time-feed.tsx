"use client";

import { useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Activity, 
  ShieldAlert, 
  UserPlus, 
  Server,
  AlertTriangle,
  Globe,
  Ban,
  CheckCircle,
  Filter
} from "lucide-react";
import { formatDistanceToNowRu } from "@/lib/utils/date";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type EventType = 
  | "blacklist_hit" 
  | "threat_match" 
  | "user_online" 
  | "node_status" 
  | "anomaly"
  | "sync";

export interface FeedEvent {
  id: string;
  type: EventType;
  message: string;
  details?: string;
  timestamp: string;
  severity?: "info" | "warning" | "error";
  link?: string;
}

interface RealTimeFeedProps {
  events: FeedEvent[];
  maxEvents?: number;
  title?: string;
}

const eventIcons: Record<EventType, React.ReactNode> = {
  blacklist_hit: <Ban className="h-3.5 w-3.5" />,
  threat_match: <ShieldAlert className="h-3.5 w-3.5" />,
  user_online: <UserPlus className="h-3.5 w-3.5" />,
  node_status: <Server className="h-3.5 w-3.5" />,
  anomaly: <AlertTriangle className="h-3.5 w-3.5" />,
  sync: <CheckCircle className="h-3.5 w-3.5" />,
};

const eventColors: Record<EventType, string> = {
  blacklist_hit: "text-red-500",
  threat_match: "text-orange-500",
  user_online: "text-green-500",
  node_status: "text-muted-foreground",
  anomaly: "text-yellow-500",
  sync: "text-muted-foreground",
};

// Keys, not labels: the map lives outside the component (no hook access), so
// the one call site (the filter dropdown) looks these up via tf(`type.${...}`).
const eventLabelKeys: Record<EventType, string> = {
  blacklist_hit: "blacklist",
  threat_match: "threat",
  user_online: "user",
  node_status: "node",
  anomaly: "anomaly",
  sync: "sync",
};

export function RealTimeFeed({ events, maxEvents = 50, title }: RealTimeFeedProps) {
  const tf = useTranslations("realTimeFeed");
  const heading = title ?? tf("title");
  const [filter, setFilter] = useState<Set<EventType>>(new Set(Object.keys(eventIcons) as EventType[]));
  const [newEventIds, setNewEventIds] = useState<Set<string>>(new Set());
  const prevEventsRef = useRef<Set<string>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);

  // Track new events for animation
  useEffect(() => {
    const currentIds = new Set(events.map(e => e.id));
    const newIds = new Set<string>();
    
    currentIds.forEach(id => {
      if (!prevEventsRef.current.has(id)) {
        newIds.add(id);
      }
    });
    
    if (newIds.size > 0) {
      setNewEventIds(newIds);
      
      // Remove highlight after animation
      const timer = setTimeout(() => {
        setNewEventIds(new Set());
      }, 2000);
      
      return () => clearTimeout(timer);
    }
    
    prevEventsRef.current = currentIds;
  }, [events]);

  useEffect(() => {
    prevEventsRef.current = new Set(events.map(e => e.id));
  }, [events]);

  const filteredEvents = events
    .filter(e => filter.has(e.type))
    .slice(0, maxEvents);

  const toggleFilter = (type: EventType) => {
    setFilter(prev => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <CardHeader className="pb-3 flex-none">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Activity className="h-4 w-4 text-green-500" />
            {heading}
            <Badge variant="secondary" className="text-xs animate-pulse">
              {tf("live")}
            </Badge>
          </CardTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2">
                <Filter className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(Object.keys(eventIcons) as EventType[]).map(type => (
                <DropdownMenuCheckboxItem
                  key={type}
                  checked={filter.has(type)}
                  onCheckedChange={() => toggleFilter(type)}
                >
                  <span className="flex items-center gap-2">
                    {eventIcons[type]}
                    {tf(`type.${eventLabelKeys[type]}` as Parameters<typeof tf>[0])}
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden p-0 min-h-0">
        <div
          ref={scrollRef}
          className="h-full overflow-y-auto scrollbar-thin px-5 pb-4"
        >
          {filteredEvents.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
              <p className="text-sm">{tf("empty")}</p>
            </div>
          ) : (
            <div className="-mx-5">
              {filteredEvents.map((event) => {
                const isNew = newEventIds.has(event.id);
                return (
                  <div
                    key={event.id}
                    className={`glass-row flex items-start gap-2.5 px-5 py-2 ${
                      isNew ? "animate-fade-in-row" : ""
                    }`}
                  >
                    <div className="mt-0.5">{eventIcons[event.type]}</div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium truncate">{event.message}</p>
                      {event.details && (
                        <p className="text-[10px] text-muted-foreground truncate">
                          {event.details}
                        </p>
                      )}
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {formatDistanceToNowRu(new Date(event.timestamp))}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
