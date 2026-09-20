"use client";

import { cn } from "@/lib/utils";

/**
 * A thematic motif sunk INTO a glass panel.
 *
 * Solid, heavy silhouettes — not hairline drawings. A 1.5px outline vanishes
 * at the opacity this layer needs, so shapes are filled or stroked at 9–14
 * units on a 160 viewBox: the mass survives being faded almost to nothing,
 * which is what lets the motif sit under live numbers without competing.
 *
 * It bleeds off the trailing edge and is clipped by the panel, so it reads as
 * something suspended in the material rather than a sticker on top.
 *
 * The parent must be positioned and clipped (`relative overflow-hidden`).
 */
export type MotifName =
  | "nodes"
  | "shield"
  | "users"
  | "globe"
  | "stream"
  | "link"
  | "pulse"
  | "database";

export function GlassMotif({
  name,
  className,
}: {
  name: MotifName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 160 160"
      className={cn(
        "pointer-events-none absolute -right-5 -top-6 h-[140%] w-auto text-foreground",
        "opacity-[0.07] dark:opacity-[0.10]",
        className
      )}
      fill="currentColor"
      stroke="none"
    >
      {MOTIFS[name]}
    </svg>
  );
}

/** Heavy strokes for the shapes that are genuinely linear. */
const bar = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const MOTIFS: Record<MotifName, React.ReactNode> = {
  // Hub and satellites, connected by thick bars.
  nodes: (
    <g>
      <path {...bar} strokeWidth="9" d="M80 80 34 42M80 80l46-38M80 80l-44 40M80 80l42 38" />
      <circle cx="80" cy="80" r="20" />
      <circle cx="32" cy="40" r="13" />
      <circle cx="128" cy="40" r="13" />
      <circle cx="34" cy="122" r="13" />
      <circle cx="124" cy="120" r="13" />
    </g>
  ),
  // Solid shield with a knocked-out tick.
  shield: (
    <g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M80 12 140 38v44c0 34-25 59-60 70-35-11-60-36-60-70V38zM66 78 54 90l20 22 36-40-13-12-23 26z"
      />
    </g>
  ),
  // Two filled figures, the nearer one overlapping.
  users: (
    <g>
      <circle cx="116" cy="56" r="20" />
      <path d="M78 130c0-24 17-42 38-42s38 18 38 42z" />
      <circle cx="56" cy="62" r="26" />
      <path d="M6 146c0-30 22-52 50-52s50 22 50 52z" />
    </g>
  ),
  // Filled disc with meridians cut out of it.
  globe: (
    <g>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M80 16a64 64 0 100 128 64 64 0 000-128zm0 14c7 0 18 17 18 50s-11 50-18 50-18-17-18-50 11-50 18-50z"
      />
      <path {...bar} strokeWidth="10" d="M22 62h116M22 98h116" />
    </g>
  ),
  // Log lines streaming past, as slabs.
  stream: (
    <g>
      <path {...bar} strokeWidth="13" d="M16 36h84M16 68h120M16 100h66M16 132h102" />
    </g>
  ),
  // Two heavy chain links.
  link: (
    <g>
      <path {...bar} strokeWidth="14" d="M62 98 98 62" />
      <path {...bar} strokeWidth="14" d="M88 44l14-14a26 26 0 0137 37l-14 14" />
      <path {...bar} strokeWidth="14" d="M72 116l-14 14a26 26 0 01-37-37l14-14" />
    </g>
  ),
  pulse: (
    <g>
      <path {...bar} strokeWidth="13" d="M8 88h28l16-46 22 88 18-60 14 28h46" />
    </g>
  ),
  database: (
    <g>
      <ellipse cx="80" cy="38" rx="54" ry="20" />
      <path d="M26 54v28c0 11 24 20 54 20s54-9 54-20V54c0 11-24 20-54 20s-54-9-54-20z" />
      <path d="M26 96v28c0 11 24 20 54 20s54-9 54-20V96c0 11-24 20-54 20s-54-9-54-20z" />
    </g>
  ),
};
