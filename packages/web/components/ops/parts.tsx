// Small pieces every Ops view shares: a group's kind glyph, its status pill,
// a source's chip, the empty state that points at source setup, the base
// feeds' readiness, and keyboard activation for clickable rows.
import Link from "next/link";
import { createContext, useContext, type ComponentType, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { SyncCollectionResult } from "../../hooks/useSyncCollection";
import { Bug, ChartLine, CircleDot, Film, Gauge, Plug, ScrollText, ShieldCheck, Webhook, Workflow, type LucideIcon } from "lucide-react";
import type { GroupKind, GroupStatus, SourceProvider, SourceStatus } from "@codecast/shared/contracts/ingest";
import { accentSoft, accentVar, type ExternalEventAccent } from "../../lib/externalEvents";
import { APP_LOOK } from "../../lib/integrations";
import { formatRelative } from "../../lib/utils";
import type { OpsSource } from "./opsTypes";

export const KIND_LOOK: Record<GroupKind, { icon: LucideIcon; accent: ExternalEventAccent; label: string }> = {
  error: { icon: Bug, accent: "red", label: "error" },
  log: { icon: ScrollText, accent: "yellow", label: "log" },
  job: { icon: Workflow, accent: "orange", label: "job" },
  check: { icon: ShieldCheck, accent: "cyan", label: "check" },
  metric: { icon: Gauge, accent: "violet", label: "metric" },
  replay_issue: { icon: Film, accent: "magenta", label: "replay" },
};

export function KindGlyph({ kind }: { kind: GroupKind }) {
  const look = KIND_LOOK[kind] ?? KIND_LOOK.error;
  const Icon = look.icon;
  return (
    <span className="ops-kind" style={{ color: accentVar(look.accent), background: accentSoft(look.accent, 12) }} title={look.label}>
      <Icon className="w-3.5 h-3.5" strokeWidth={1.75} />
    </span>
  );
}

const STATUS_ACCENT: Record<GroupStatus, ExternalEventAccent> = { open: "red", resolved: "green", ignored: "muted", muted: "muted" };

export function StatusPill({ status, failing }: { status: GroupStatus; failing?: boolean }) {
  // An open check or metric that is currently fine reads as watched, not red.
  const accent = status === "open" && failing === false ? "cyan" : STATUS_ACCENT[status];
  const label = status === "open" && failing === false ? "ok" : status;
  return (
    <span className="ops-pill" style={{ color: accentVar(accent), background: accentSoft(accent, 12) }}>
      {label}
    </span>
  );
}

// Keyed sources (the door) have no vendor; they get their own look beside the
// connected apps' (lib/integrations APP_LOOK), so every chip names its feed.
type Icon = ComponentType<{ className?: string; style?: CSSProperties; strokeWidth?: number }>;

const PROVIDER_ICON: Record<SourceProvider, { icon: Icon; accent: string }> = {
  sentry: APP_LOOK.sentry,
  posthog: APP_LOOK.posthog,
  app: APP_LOOK.app,
  github: APP_LOOK.github,
  sdk: { icon: CircleDot, accent: "var(--sol-blue)" },
  http: { icon: Webhook, accent: "var(--sol-text-muted)" },
};

export const SOURCE_PROVIDER_LABEL: Record<SourceProvider, string> = { sdk: "SDK", http: "HTTP", app: "App", sentry: "Sentry", posthog: "PostHog", github: "GitHub" };

/** A source's health as one word and its ink, for every surface that names a source. */
export const SOURCE_STATE: Record<SourceStatus, { label: string; ink: string }> = {
  active: { label: "Active", ink: "text-sol-green" },
  paused: { label: "Paused", ink: "text-sol-text-dim" },
  error: { label: "Error", ink: "text-sol-red" },
};

/** What a source has done lately, as one line of facts: last event, today's count, open issues. */
export function sourceFacts(source: Pick<OpsSource, "last_event_at" | "events_today" | "groups_open">): string[] {
  return [
    source.last_event_at ? `last event ${formatRelative(source.last_event_at)}` : "no events yet",
    source.events_today ? `${source.events_today} today` : null,
    source.groups_open ? `${source.groups_open} open ${source.groups_open === 1 ? "issue" : "issues"}` : null,
  ].filter((f): f is string => !!f);
}

export function ProviderIcon({ provider, className = "w-3 h-3" }: { provider: SourceProvider; className?: string }) {
  const look = PROVIDER_ICON[provider] ?? { icon: ChartLine, accent: "var(--sol-text-muted)" };
  const Glyph = look.icon;
  return <Glyph className={className} style={{ color: look.accent }} strokeWidth={1.75} />;
}

export function SourceChip({ source, href, on, children }: { source: Pick<OpsSource, "name" | "provider" | "status" | "last_error">; href?: string; on?: boolean; children?: ReactNode }) {
  const body = (
    <>
      <span className="ops-dot" data-status={source.status} />
      <ProviderIcon provider={source.provider} />
      <span className="truncate min-w-0">{source.name}</span>
      {children}
    </>
  );
  const title = source.last_error ? `${source.name}: ${source.last_error}` : `${source.name} (${source.provider}, ${source.status})`;
  return href ? (
    <Link href={href} className="ops-source-chip" data-on={on ? "true" : undefined} title={title}>{body}</Link>
  ) : (
    <span className="ops-source-chip" title={title}>{body}</span>
  );
}

/** The honest empty screen: what would fill it, and where to set that up. */
export function OpsEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="max-w-[520px] mx-auto text-center py-16">
      <div className="text-[13.5px] text-sol-text font-medium">{title}</div>
      {children && <div className="text-[12.5px] ops-quiet mt-2 leading-relaxed">{children}</div>}
    </div>
  );
}

export const SETUP_HREF = "/settings/integrations#product-sources";

// ── The base feeds' readiness ──

/** The area's base lists, fed once by OpsShell; tabs read whether each has answered. */
export type OpsFeeds = { sources: SyncCollectionResult; groups: SyncCollectionResult; replays: SyncCollectionResult; watches: SyncCollectionResult };
export const OpsFeedsContext = createContext<OpsFeeds | null>(null);
export function useOpsFeed(name: keyof OpsFeeds): SyncCollectionResult | undefined {
  return useContext(OpsFeedsContext)?.[name];
}

/** A read that failed with nothing cached to show: say so, with a retry. */
export function OpsFeedError({ what, retry }: { what: string; retry?: () => void }) {
  return (
    <OpsEmpty title={`Could not load ${what}`}>
      Nothing is cached on this device and the server did not answer.{" "}
      {retry && <button type="button" className="text-sol-link hover:underline" onClick={retry}>Try again</button>}
    </OpsEmpty>
  );
}

/**
 * An empty list, told honestly: a feed that failed says so, a feed that has
 * not answered yet says it is reading, and only an answered feed shows the
 * "nothing here" copy. Rows in the store always paint first; this is only
 * reached when there are none.
 */
export function OpsFeedEmpty({ feeds, what, title, children }: { feeds: (SyncCollectionResult | undefined)[]; what: string; title: string; children?: ReactNode }) {
  const failed = feeds.find((f) => f?.error);
  if (failed) return <OpsFeedError what={what} retry={failed.retry} />;
  if (feeds.some((f) => f && !f.ready)) return <div className="ops-quiet text-[12.5px] py-16 text-center">Reading {what}…</div>;
  return <OpsEmpty title={title}>{children}</OpsEmpty>;
}

// ── Keyboard activation ──

/**
 * Props that make a clickable row or mark reachable and usable from the
 * keyboard: focusable, announced with its role, Enter or Space activates.
 */
export function pressable(onActivate: () => void, role: "link" | "button" = "button") {
  return {
    role,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      e.stopPropagation();
      onActivate();
    },
  };
}
