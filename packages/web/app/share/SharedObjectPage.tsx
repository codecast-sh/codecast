"use client";
// The frame every /share/<kind>/<token> page renders in, and the pieces those
// pages are built from: the token from the URL, the public query (seeded by
// the server's inlined payload when there is one), the loader, the dead-link
// page, the bar, the reading column and its footer. A share page only says
// what its object looks like, in these pieces, so every kind reads alike.
import { useState, type CSSProperties, type ReactNode } from "react";
import { useQuery } from "convex/react";
import type { FunctionReference } from "convex/server";
import { useParams } from "next/navigation";
import { Check, Link2, Unlink } from "lucide-react";
import type { SharedObjectKind } from "@codecast/shared/entities";
import { formatDateFull, formatDateSmart } from "@codecast/shared/time";
import { AppLoader } from "../../components/AppLoader";
import { MarkdownRenderer } from "../../components/tools/MarkdownRenderer";
import { AvatarImg } from "../../lib/avatarCache";
import { readSharePreload } from "@/lib/sharePreload";
import "./share.css";

// Solarized accents, the same in light and dark.
export const TONE = {
  cyan: "#2aa198",
  blue: "#268bd2",
  green: "#859900",
  yellow: "#b58900",
  orange: "#cb4b16",
  red: "#dc322f",
  magenta: "#d33682",
  violet: "#6c71c4",
  muted: "var(--ink-muted)",
} as const;
export type Tone = keyof typeof TONE;

const toneStyle = (tone?: Tone) => (tone ? ({ "--tone": TONE[tone] } as CSSProperties) : undefined);

function CopyPageLink() {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="share-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(window.location.href.split("#")[0]);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
    >
      {copied ? <Check size={13} /> : <Link2 size={13} />}
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

function Dead({ noun }: { noun: string }) {
  return (
    <main className="share-page">
      <div className="share-dead">
        <div>
          <Unlink size={36} style={{ color: "var(--ink-dim)" }} />
          <h1>This link is closed</h1>
          <p>The {noun} was made private, or the link never pointed anywhere.</p>
        </div>
      </div>
    </main>
  );
}

export function SharedObjectPage<T>({
  kind,
  query,
  noun,
  aside,
  children,
}: {
  kind: SharedObjectKind;
  /** The kind's public query, taking `{ share_token }`. */
  query: FunctionReference<"query">;
  /** What the object is called ("doc", "decision"), in the bar and the dead-link page. */
  noun: string;
  /** A rail beside the column on wide screens (a doc's outline). */
  aside?: (data: T) => ReactNode;
  children: (data: T) => ReactNode;
}) {
  const token = useParams().token as string;
  const live = useQuery(query, { share_token: token }) as T | null | undefined;
  const data = live !== undefined ? live : readSharePreload<T>(kind, token);

  if (data === undefined) return <AppLoader className="min-h-0 h-screen bg-sol-bg" />;
  if (data === null) return <Dead noun={noun} />;

  const rail = aside?.(data);
  return (
    <main className="share-page">
      <div className="share-progress" aria-hidden />
      <header className="share-bar">
        <a className="share-mark" href="https://codecast.sh">
          <i aria-hidden />
          codecast
        </a>
        <span className="share-kind">shared {noun}</span>
        <CopyPageLink />
      </header>
      <div className="share-layout" data-aside={rail ? "" : undefined}>
        {rail}
        <article className="share-col">{children(data)}</article>
      </div>
      <footer className="share-foot">
        Shared from <a href="https://codecast.sh">Codecast</a>, where people and their agents work in the open.
      </footer>
    </main>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────

export function Pill({ tone, quiet, children }: { tone?: Tone; quiet?: boolean; children: ReactNode }) {
  return (
    <span className="share-pill" data-quiet={quiet ? "" : undefined} style={toneStyle(tone)}>
      {children}
    </span>
  );
}

/** The top of a page: badges, the title, then who made it and when. */
export function ShareHead({
  badges,
  title,
  user,
  at,
  meta,
}: {
  badges?: ReactNode;
  title: ReactNode;
  user?: { name: string | null; image?: string | null } | null;
  /** When it was made; shown relative, exact on hover. */
  at?: number;
  meta?: ReactNode;
}) {
  return (
    <div className="share-head">
      {badges && <div className="share-badges">{badges}</div>}
      <h1 className="share-title">{title}</h1>
      {(user?.name || at || meta) && (
        <div className="share-meta">
          {user?.name && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              {user.image && <AvatarImg src={user.image} alt="" />}
              <strong>{user.name}</strong>
            </span>
          )}
          {at && <span title={formatDateFull(at)}>{formatDateSmart(at)}</span>}
          {meta}
        </div>
      )}
    </div>
  );
}

export function Callout({ label, tone, children }: { label: string; tone?: Tone; children: ReactNode }) {
  return (
    <div className="share-callout" style={toneStyle(tone)}>
      <span>{label}</span>
      <div>{children}</div>
    </div>
  );
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="share-section">
      <h2>
        {title}
        {count !== undefined && <small>{count}</small>}
      </h2>
      {children}
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <div className="share-rows">{children}</div>;
}

export function Row({
  lead,
  tone,
  trail,
  note,
  children,
}: {
  lead?: ReactNode;
  tone?: Tone;
  trail?: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="share-row" style={toneStyle(tone)}>
      {lead !== undefined && <span className="share-row-lead">{lead}</span>}
      <div className="share-row-main">
        {children}
        {note && <p>{note}</p>}
      </div>
      {trail !== undefined && <span className="share-row-trail">{trail}</span>}
    </div>
  );
}

export function Bullets({ items, tone }: { items: ReactNode[]; tone?: Tone }) {
  return (
    <ul className="share-bullets" style={toneStyle(tone)}>
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

/** Markdown set for reading; `compact` for comments and notes. */
export function Prose({ content, compact }: { content: string; compact?: boolean }) {
  return (
    <div className="share-prose" data-compact={compact ? "" : undefined}>
      <MarkdownRenderer content={content} />
    </div>
  );
}

/** A calendar day, for due and target dates: "Dec 31, 2026". */
export function fmtDay(ts: number): string {
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "In progress" from "in_progress". */
export function humanize(value: string | null | undefined): string {
  const s = (value ?? "").replace(/_/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

const STATUS_TONE: Record<string, Tone> = {
  done: "green",
  completed: "green",
  answered: "green",
  active: "cyan",
  running: "cyan",
  in_progress: "yellow",
  in_review: "violet",
  pending: "yellow",
  open: "blue",
  planned: "blue",
  proposed: "violet",
  paused: "orange",
  draft: "muted",
  backlog: "muted",
  failed: "red",
  cancelled: "muted",
  abandoned: "muted",
  dropped: "muted",
  on_track: "green",
  at_risk: "yellow",
  off_track: "red",
};

/** One status vocabulary for every kind's pill. */
export function StatusPill({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  return <Pill tone={STATUS_TONE[status] ?? "muted"}>{humanize(status)}</Pill>;
}

export function statusTone(status: string | null | undefined): Tone {
  return STATUS_TONE[status ?? ""] ?? "muted";
}
