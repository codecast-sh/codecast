"use client";
// The first visit (docs/architecture/org-staffing.md S20). The first time a
// person opens the org page, with roles in it or with none, the page opens
// on this screen instead of the canvas: one screen, read in thirty seconds,
// built from the painted faces because the faces are the feature's own
// character.
//
// Five faces stand as a small company at the top: the chief of staff above,
// four roles under it on one rail. Each face stands for one of the five
// sentences, and the same face marks that sentence's line below, so the two
// are tied without a label. The entrance is one orchestrated sequence in CSS
// (globals.css, "org-intro"): the faces pop in, the rail draws between them,
// the title and the lines reveal one after the other, and as each line lands
// its face nods; the two actions come last. Reduced motion collapses the
// whole sequence to its final frame through the global rule.
//
// Two actions and only two: the one that starts (Ask the chief of staff when
// the workspace has no roles, Open the chart when it has) and Later. Seen is
// the page's business: both actions call back and the page writes
// org_intro_seen through the store, so the screen is seen once per person.
// "How this page works" in the header reopens it by hand.
import type { CSSProperties } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AvatarKey } from "@codecast/shared/contracts/orgAvatars";
import { RoleAvatar } from "./avatars";
import { OrgButton } from "./OrgButton";
import { useEventListener } from "../../hooks/useEventListener";
import { useMountEffect } from "../../hooks/useMountEffect";

// Capture: the intro answers Escape before the page under it does.
const INTRO_KEY_CAPTURE = { capture: true } as const;

/** A line's text carries its own emphasis between double asterisks: the
 *  subject it leads with, and the one or two words that carry it. Nothing
 *  else is marked, so a person scanning sees the five parts before reading. */
export type OrgIntroLine = { face: AvatarKey; text: string };

/** S20's five sentences, in its order, each with the face that stands for it. */
export const ORG_INTRO_LINES: readonly OrgIntroLine[] = [
  { face: "fox", text: "**Roles.** Your organization has roles: agents that each keep watching one area of work, with a face, a boss, sessions that report to them and tasks they own." },
  { face: "owl", text: "**A chief of staff** reads your workspace, commits, sessions, plans and tasks, and proposes the roles it needs. You decide, and nothing changes until you **accept**." },
  { face: "bear", text: "**Only what needs you.** A role triages its own sessions and puts in front of you only what needs you, with **one line saying why**." },
  { face: "hare", text: "**Talk and hover.** You can talk to any role from its page, and hover any role anywhere to see what it looks after." },
  { face: "crane", text: "**From any session.** All of this works from any session too: type /cast-org." },
];

/** The line as plain words, emphasis marks dropped. */
export function orgIntroPlain(text: string): string {
  return text.replace(/\*\*/g, "");
}

/** The line as React: strong for the marked runs, plain text between. */
export function renderOrgIntroLine(text: string) {
  return text.split(/\*\*/).map((run, i) => (i % 2 === 1 ? <strong key={i} className="font-semibold" style={{ color: "var(--sol-text)" }}>{run}</strong> : run));
}

/** The chief of staff sits above the rail; the other four stand on it. */
export const ORG_INTRO_CHIEF: AvatarKey = "owl";

/** One name for one thing: the page is Org, the feature is the organization,
 *  so the card and this screen both say it. */
export const ORG_INTRO_TITLE = "Meet your organization";

/** How long the screen takes to leave (globals.css, org-intro-leave). */
export const ORG_INTRO_LEAVE_MS = 260;

// ---------------------------------------------------------------- seen, on the store

type SeenPrefs = { org_intro_seen?: boolean; org_upsell_seen?: boolean };
export type OrgSeenStore = { clientState: { ui?: SeenPrefs | null }; updateClientUI: (partial: SeenPrefs) => void };

/** Seeing the org page by any route sells the feature (S20): the card that
 *  introduces it elsewhere never rises afterwards. One write, only when unset. */
export function markOrgUpsellSeen(st: OrgSeenStore) {
  if (!st.clientState.ui?.org_upsell_seen) st.updateClientUI({ org_upsell_seen: true });
}

/** Either action on the first visit: seen once per person, and sold, in one
 *  write of whichever prefs are still unset. */
export function markOrgIntroSeen(st: OrgSeenStore) {
  const ui = st.clientState.ui;
  const patch: SeenPrefs = {};
  if (!ui?.org_intro_seen) patch.org_intro_seen = true;
  if (!ui?.org_upsell_seen) patch.org_upsell_seen = true;
  if (Object.keys(patch).length) st.updateClientUI(patch);
}

/** The start action's label, by whether the workspace has roles. */
export function orgIntroStartLabel(hasRoles: boolean): string {
  return hasRoles ? "Open the chart" : "Ask the chief of staff to look at my workspace";
}

// ---------------------------------------------------------------- the entrance, in milliseconds

const T = {
  /** The chief pops first, then the four on the rail, left to right. */
  face: (i: number) => i * 110,
  rail: 520,
  title: 760,
  /** One line after another; the face nods as its line lands. */
  line: (i: number) => 980 + i * 170,
  actions: 2000,
};

// ---------------------------------------------------------------- the small company

/** Geometry of the little chart in CSS pixels at scale 1. The four on the
 *  rail are spaced so the whole company is a touch wider than the lines
 *  below it, which keeps it reading as a picture and not as a header. */
const CHART = { w: 340, h: 136, chief: { x: 170, y: 30, size: 56 }, rail: { y: 88, from: 32, to: 308 }, kids: { y: 110, size: 50, xs: [32, 124, 216, 308] } };

function Company({ scale, lines }: { scale: number; lines: readonly OrgIntroLine[] }) {
  const k = scale;
  const kids = lines.filter((l) => l.face !== ORG_INTRO_CHIEF).slice(0, CHART.kids.xs.length);
  const faces: Array<{ face: AvatarKey; x: number; y: number; size: number; order: number }> = [
    { face: ORG_INTRO_CHIEF, x: CHART.chief.x, y: CHART.chief.y, size: CHART.chief.size, order: 0 },
    ...kids.map((l, i) => ({ face: l.face, x: CHART.kids.xs[i], y: CHART.kids.y, size: CHART.kids.size, order: i + 1 })),
  ];
  const lineIndexOf = (face: AvatarKey) => lines.findIndex((l) => l.face === face);
  const stemTop = CHART.chief.y + CHART.chief.size / 2;
  const kidTop = CHART.kids.y - CHART.kids.size / 2;
  return (
    <div className="relative mx-auto" style={{ width: CHART.w * k, height: CHART.h * k }} data-org-intro-company aria-hidden="true">
      <svg className="absolute inset-0" width={CHART.w * k} height={CHART.h * k} viewBox={`0 0 ${CHART.w} ${CHART.h}`} fill="none" stroke="color-mix(in srgb, var(--sol-text-dim) 60%, transparent)" strokeWidth={1.5} strokeLinecap="round">
        {/* the stem from the chief to the rail, the rail, then one stem per role */}
        <path d={`M ${CHART.chief.x} ${stemTop + 4} V ${CHART.rail.y}`} pathLength={1} className="org-intro-draw" style={{ "--d": `${T.rail}ms` } as CSSProperties} />
        <path d={`M ${CHART.rail.from} ${CHART.rail.y} H ${CHART.rail.to}`} pathLength={1} className="org-intro-draw" style={{ "--d": `${T.rail + 120}ms` } as CSSProperties} />
        {CHART.kids.xs.slice(0, kids.length).map((x, i) => (
          <path key={x} d={`M ${x} ${CHART.rail.y} V ${kidTop - 4}`} pathLength={1} className="org-intro-draw" style={{ "--d": `${T.rail + 260 + i * 40}ms` } as CSSProperties} />
        ))}
      </svg>
      {faces.map((f) => (
        <div
          key={f.face}
          className="absolute org-intro-face"
          data-org-intro-face={f.face}
          style={{ left: (f.x - f.size / 2) * k, top: (f.y - f.size / 2) * k, width: f.size * k, height: f.size * k, "--d": `${T.face(f.order)}ms`, "--dn": `${T.line(lineIndexOf(f.face))}ms` } as CSSProperties}
        >
          <RoleAvatar avatar={f.face} size={f.size * k} className="block" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- the screen

/** How large the company draws: the room the screen has. A tall window lets
 *  the faces grow; a laptop with every rail open keeps them at one; a phone
 *  draws them small and scrolls. Measured from the screen itself, so the
 *  shell around it (rails, banners, tabs) is already accounted for. */
function useRoomScale(ref: React.RefObject<HTMLDivElement | null>, compact: boolean): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  if (compact) return 0.74;
  if (h === 0) return 1;
  return h >= 880 ? 1.3 : h >= 780 ? 1.15 : 1;
}

export function OrgIntro({ hasRoles, compact = false, leaving = false, onStart, onLater, lines = ORG_INTRO_LINES }: {
  /** Roles exist: the start action opens the chart under this screen.
   *  None: it asks the chief of staff to look at the workspace. */
  hasRoles: boolean;
  /** The screen is on its way out: it fades and lifts over ORG_INTRO_LEAVE_MS
   *  with the tour's own easing, so the tour's first step opens as the last
   *  frame leaves and nothing blank sits between them. */
  leaving?: boolean;
  /** A phone: the company draws smaller and the page may scroll. */
  compact?: boolean;
  onStart: () => void;
  onLater: () => void;
  lines?: readonly OrgIntroLine[];
}) {
  useEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onLater(); }
  }, undefined, INTRO_KEY_CAPTURE);
  // The keyboard lands on the start action once it has revealed, so Enter
  // starts and Escape defers without a reach for the mouse.
  const startRef = useRef<HTMLButtonElement | null>(null);
  useMountEffect(() => {
    const t = window.setTimeout(() => startRef.current?.focus({ preventScroll: true }), T.actions + 200);
    return () => window.clearTimeout(t);
  });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scale = useRoomScale(rootRef, compact);
  return (
    <div
      ref={rootRef}
      className={`absolute inset-0 z-40 overflow-y-auto ${leaving ? "org-intro-leave pointer-events-none" : ""}`}
      style={{ background: "var(--sol-bg)", color: "var(--sol-text)" }}
      data-org-intro-leaving={leaving || undefined}
      role="dialog"
      aria-modal="true"
      aria-label={ORG_INTRO_TITLE}
      data-org-intro={hasRoles ? "roles" : "empty"}
    >
      {/* one soft pool of light behind the company, and nothing else on the ground */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[46%]" style={{ background: "radial-gradient(ellipse 52% 70% at 50% 34%, color-mix(in srgb, var(--sol-violet) 14%, transparent), transparent 72%)" }} aria-hidden="true" />
      <div className={compact ? "relative min-h-full flex flex-col justify-center px-5 py-6" : "relative min-h-full flex flex-col justify-center px-8 py-5"}>
        <div className="w-full mx-auto" style={{ maxWidth: 580 }}>
          <Company scale={scale} lines={lines} />

          <h2
            className={`org-intro-in text-center font-semibold tracking-tight ${compact ? "mt-4 text-[26px]" : "mt-4 text-[28px]"}`}
            style={{ fontFamily: "var(--font-serif)", lineHeight: 1.1, "--d": `${T.title}ms` } as CSSProperties}
            data-org-intro-title
          >
            {ORG_INTRO_TITLE}
          </h2>

          <ol className={`list-none m-0 p-0 ${compact ? "mt-4" : "mt-4"}`} data-org-intro-lines>
            {lines.map((l, i) => (
              <li
                key={l.face}
                className={`org-intro-in flex items-start ${compact ? "gap-3 py-[6px]" : "gap-3.5 py-[6px]"}`}
                style={{ "--d": `${T.line(i)}ms` } as CSSProperties}
                data-org-intro-line={l.face}
              >
                <RoleAvatar avatar={l.face} size={compact ? 22 : 24} className="mt-[1px]" />
                <p className={`m-0 min-w-0 flex-1 ${compact ? "text-[13px] leading-[1.55]" : "text-[12.5px] leading-[1.5]"}`} style={{ fontFamily: "var(--font-mono)", color: "var(--sol-text-secondary)" }}>
                  {renderOrgIntroLine(l.text)}
                </p>
              </li>
            ))}
          </ol>

          {/* On a phone the page scrolls, so the actions pin to the foot of the
              screen and stay in reach while the lines are read. */}
          <div
            className={`org-intro-in flex items-center justify-center gap-3 flex-wrap ${compact ? "sticky bottom-0 -mx-5 mt-4 px-5 pt-5 pb-4" : "mt-5"}`}
            style={{ "--d": `${T.actions}ms`, ...(compact ? { background: "linear-gradient(to bottom, transparent, var(--sol-bg) 45%)" } : {}) } as CSSProperties}
            data-org-intro-actions
          >
            <OrgButton ref={startRef} primary onClick={onStart} className={compact ? "w-full h-auto min-h-9 px-4 py-2 text-[13px] whitespace-normal" : "h-9 px-5 text-[13px]"} data-org-intro-start>
              {orgIntroStartLabel(hasRoles)}
            </OrgButton>
            <button type="button" onClick={onLater} className={`rounded-lg transition-colors hover:bg-sol-bg-highlight/70 ${compact ? "h-9 px-3 text-[13px]" : "h-9 px-4 text-[13px]"}`} style={{ color: "var(--sol-text-muted)" }} data-org-intro-later>
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
