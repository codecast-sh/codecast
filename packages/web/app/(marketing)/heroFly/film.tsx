"use client";

/** What the film driver writes beyond styles: typed text, and veils (see filmClock.ts for the rest of the clock). */

import type { ComponentProps, CSSProperties } from "react";
import { SessionCardView } from "@/components/inbox/SessionCardView";
import { fly, POSTER_FRAME } from "./filmClock";

const noop = () => {};
const LIFTED_CHROME = { showModelBadge: false, showAgentIcon: true, showBranchPill: true, personifyAll: false };
const LIFTED_LIVENESS = { isLive: true, pendingSend: false, restarting: false, draft: "" };

/** Text the driver types (a TextBeat), seeded with its poster-frame value. */
export function FlyText({ id, className, style }: { id: string; className?: string; style?: CSSProperties }) {
  return (
    <span data-fly-text={id} className={className} style={style}>
      {POSTER_FRAME.texts[id]}
    </span>
  );
}

/**
 * A session row in flight between surfaces: the inbox row it is about to
 * become, lifted off the page, its shadow deep enough to part it from the
 * text it crosses. Centred on the flyer's point.
 */
export function LiftedRow({ session, now, spawnedByTitle = null }: Pick<ComponentProps<typeof SessionCardView>, "session" | "now"> & { spawnedByTitle?: string | null }) {
  return (
    <div className="w-[340px] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-md border border-sol-border/40 bg-sol-bg shadow-[0_18px_40px_-12px_rgba(0,43,54,0.45),0_2px_6px_rgba(0,43,54,0.12)]">
      <SessionCardView
        session={session}
        isActive={false}
        isFavorite={false}
        sessionLabel={null}
        now={now}
        chrome={LIFTED_CHROME}
        liveness={LIFTED_LIVENESS}
        viewerId={null}
        author={null}
        viewers={[]}
        spawnedByTitle={spawnedByTitle}
        anchorIdentity={null}
        onSelect={noop}
      />
    </div>
  );
}

/** A wash of the page colour over a surface (a `scrim` region), faded by its beats: it steps the surface back while the camera frames something else. */
export function Veil({ id }: { id: string }) {
  return <div {...fly(id)} aria-hidden className="pointer-events-none h-full w-full bg-sol-bg/75" />;
}
