// Small pieces every Ops view shares: a group's kind glyph, its status pill,
// a source's chip, and the empty state that points at source setup.
import Link from "next/link";
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Bug, ChartLine, CircleDot, Film, Gauge, Plug, ScrollText, ShieldCheck, Webhook, Workflow, type LucideIcon } from "lucide-react";
import type { GroupKind, GroupStatus, SourceProvider } from "@codecast/shared/contracts/ingest";
import { accentSoft, accentVar, type ExternalEventAccent } from "../../lib/externalEvents";
import { APP_LOOK } from "../../lib/integrations";
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
  sdk: { icon: CircleDot, accent: "var(--sol-blue)" },
  http: { icon: Webhook, accent: "var(--sol-text-muted)" },
};

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
      <span>{source.name}</span>
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
