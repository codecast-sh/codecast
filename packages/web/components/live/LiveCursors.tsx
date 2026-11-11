// Every other participant's cursor and name tag over a live artifact: people
// and agent sessions alike. The product says where a position is on screen
// (LiveViewProps.toScreen); this draws the arrows in each participant's color.
// An agent's tag opens its session.
import Link from "next/link";
import { textOnColor, type ArtifactPosition, type ArtifactPresence } from "@codecast/shared/artifacts";
import { CursorArrow } from "../presence/CursorArrow";
import type { ScreenPoint } from "./registry";

export function presenceLabel(p: ArtifactPresence): string {
  return p.kind === "agent" ? `✳ ${p.name}` : p.name;
}

/** A name tag in a participant's color, for products that outline selections (a sheet range, a board selection). */
export function CursorTag({ p, className = "" }: { p: ArtifactPresence; className?: string }) {
  const tag = (
    <span
      data-live-tag={p.kind}
      className={`inline-block max-w-[180px] truncate rounded px-1.5 py-px text-meta font-mono font-medium whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.35)] ${className}`}
      style={{ backgroundColor: p.color, color: textOnColor(p.color) }}
      title={p.status ? `${p.name}: ${p.status}` : p.name}
    >
      {presenceLabel(p)}
    </span>
  );
  return p.kind === "agent" && p.session_id ? <Link href={`/conversation/${p.session_id}`} className="pointer-events-auto">{tag}</Link> : tag;
}

function anchorOf(p: ArtifactPresence): ArtifactPosition | null {
  const pos = p.position;
  if (pos && (pos.point || pos.cell || pos.range || pos.block || pos.key)) return pos;
  const last = p.selection?.[p.selection.length - 1];
  return last ? { key: last } : null;
}

export function LiveCursors({ others, toScreen }: { others: ArtifactPresence[]; toScreen: ((pos: ArtifactPosition) => ScreenPoint | null) | null }) {
  if (!toScreen) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden z-30" data-live-cursors>
      {others.map((p) => {
        const pos = anchorOf(p);
        const pt = pos ? toScreen(pos) : null;
        if (!pt) return null;
        // A range or element has a box: the arrow sits at its bottom-right, like a write in progress.
        const x = pt.x + (pt.w ?? 0);
        const y = pt.y + (pt.h ?? 0);
        return (
          <div
            key={p.actor}
            data-live-cursor={p.actor}
            className="absolute left-0 top-0 transition-transform duration-100 ease-out"
            style={{ transform: `translate(${x}px, ${y}px)` }}
          >
            {pt.w !== undefined && pt.h !== undefined && (pt.w > 0 || pt.h > 0) && (
              <div
                className="absolute rounded-sm"
                style={{ left: -(pt.w ?? 0), top: -(pt.h ?? 0), width: pt.w, height: pt.h, boxShadow: `0 0 0 2px ${p.color}` }}
              />
            )}
            <CursorArrow color={p.color} />
            <span className="absolute left-5 top-7">
              <CursorTag p={p} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
