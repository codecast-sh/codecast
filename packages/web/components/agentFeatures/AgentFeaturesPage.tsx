"use client";

import { useMemo, useState } from "react";
import {
  AlarmClock, AppWindow, ArrowUpRight, Blocks, Brain, CheckCheck, Gauge, GitFork, GitPullRequest, Globe, Layers,
  LayoutDashboard, ListChecks, MessagesSquare, Monitor, Network, Phone, Pin, Puzzle, Scale, Search, Send,
  Smartphone, SquareSlash, Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  SNIPPET_CATALOG,
  SNIPPET_CATEGORIES,
  STABLE_MODES,
  snippetAvailableForTeams,
  type SnippetCategory,
  type SnippetDescriptor,
  type StableMode,
} from "@codecast/shared/contracts";
import { AuthGuard } from "../AuthGuard";
import { SegmentedToggle } from "../SegmentedToggle";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Switch } from "../ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { MarkdownRenderer } from "../tools/MarkdownRenderer";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { DeviceSettingsFrame } from "../settings/DeviceSettingsFrame";
import { useDeviceSettingsPanel } from "../settings/useDeviceSettingsPanel";
import { useInboxStore } from "../../store/inboxStore";
import { useRouter } from "next/navigation";
import { isRecentlyShipped, snippetEnabledOn } from "../../lib/newSnippets";
import { hooksOfFeature } from "../../lib/harnessHooksView";

/**
 * /agent-features: what codecast can teach your agents. The web twin of
 * `cast install`. Each machine keeps its own config (its ~/.codecast/config.json),
 * heartbeat-reported into `device.settings`, so the page shows ONE device at a
 * time. Flipping a switch enqueues a device-targeted command that runs the same
 * CLI command a human would; the server mirrors the change optimistically so it
 * moves instantly, and the next heartbeat reconciles to the device's real
 * state. Offline devices are read-only (the command would expire before the
 * daemon could run it).
 */

const ICONS: Record<string, LucideIcon> = {
  memory: Brain,
  state: Pin,
  messaging: Send,
  forks: GitFork,
  decide: Scale,
  chat: MessagesSquare,
  calls: Phone,
  tasks: ListChecks,
  triggers: AlarmClock,
  workflows: Workflow,
  orchestration: Network,
  skills: SquareSlash,
  pr: GitPullRequest,
  visual: LayoutDashboard,
  publish: Globe,
  mods: Puzzle,
  browser: AppWindow,
  computer: Monitor,
  sim: Smartphone,
  check: CheckCheck,
  limits: Gauge,
};

/** Literal class strings per category, so Tailwind sees every one. */
const TONE: Record<SnippetCategory, { text: string; tile: string; on: string; dot: string }> = {
  context: { text: "text-sol-cyan", tile: "bg-sol-cyan/10 text-sol-cyan", on: "border-sol-cyan/40", dot: "bg-sol-cyan" },
  together: { text: "text-sol-violet", tile: "bg-sol-violet/10 text-sol-violet", on: "border-sol-violet/40", dot: "bg-sol-violet" },
  work: { text: "text-sol-blue", tile: "bg-sol-blue/10 text-sol-blue", on: "border-sol-blue/40", dot: "bg-sol-blue" },
  show: { text: "text-sol-magenta", tile: "bg-sol-magenta/10 text-sol-magenta", on: "border-sol-magenta/40", dot: "bg-sol-magenta" },
  hands: { text: "text-sol-orange", tile: "bg-sol-orange/10 text-sol-orange", on: "border-sol-orange/40", dot: "bg-sol-orange" },
};

type Filter = "all" | "on" | "off";

/** Stable context is a SessionStart hook with a tri-state, not a catalog
 *  snippet; it joins the Context group as its own card. */
const STABLE_KEY = "stable";

export default function AgentFeaturesPage() {
  return (
    <AuthGuard>
      <AgentFeaturesContent />
    </AuthGuard>
  );
}

function AgentFeaturesContent() {
  // Team-gated snippets (chat, calls) only appear while some team has the
  // feature on; the daemon keeps a device's copy in step with the flag.
  const teams = useInboxStore((s) => s.teams);
  const panel = useDeviceSettingsPanel();
  const router = useRouter();
  const features = useMemo(() => SNIPPET_CATALOG.filter((s) => snippetAvailableForTeams(s.slug, teams)), [teams]);

  return (
    <div className="h-full overflow-y-auto" data-main-scroll>
      <div className="mx-auto w-full max-w-[1180px] px-5 pb-16 pt-8 sm:px-8">
        <header className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <h1 className="flex items-center gap-2.5 text-2xl font-serif text-sol-text">
              <Blocks className="h-6 w-6 text-sol-cyan" strokeWidth={1.5} />
              Agent features
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-sol-text-muted">
              Codecast teaches your coding agents to work as a team: to remember, delegate, track work,
              show results and drive your machine. Each feature is a short set of instructions and{" "}
              <code className="font-mono text-[12.5px] text-sol-text-secondary">cast</code> commands written
              into a machine&apos;s agent setup. Switch on what you want your agents to know.
            </p>
          </div>
          <button
            type="button"
            onClick={() => router.push("/capabilities")}
            className="inline-flex items-center gap-1 text-xs text-sol-text-muted hover:text-sol-text"
          >
            Third-party skills and plugins live in Capabilities
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </header>

        <HowItWorks />

        <DeviceSettingsFrame panel={panel} title="Agent features" icon={Blocks} className="max-w-none space-y-6">
          {(selected) => <FeatureBoard d={selected} features={features} panel={panel} />}
        </DeviceSettingsFrame>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { n: "1", title: "Switch a feature on", body: "for one machine. Each machine keeps its own setup, so pick it above the list." },
    { n: "2", title: "Its daemon writes it in", body: "a section of CLAUDE.md and AGENTS.md, plus any skill or hook the feature needs." },
    { n: "3", title: "New sessions pick it up", body: "and use the commands when the work calls for them. Nothing runs until they do." },
  ];
  return (
    <ol className="my-7 grid gap-px overflow-hidden rounded-lg border border-sol-border/60 bg-sol-border/40 sm:grid-cols-3">
      {steps.map((s) => (
        <li key={s.n} className="flex gap-3 bg-sol-bg px-4 py-3.5">
          <span className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-sol-border font-mono text-[10px] text-sol-text-muted">
            {s.n}
          </span>
          <p className="text-[12.5px] leading-relaxed text-sol-text-muted">
            <span className="font-medium text-sol-text">{s.title}</span> {s.body}
          </p>
        </li>
      ))}
    </ol>
  );
}

type Panel = ReturnType<typeof useDeviceSettingsPanel>;

function FeatureBoard({ d, features, panel }: { d: Device; features: SnippetDescriptor[]; panel: Panel }) {
  const { pending, run, setSnippet } = panel;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<SnippetDescriptor | null>(null);

  const stableMode: StableMode = d.settings?.stable_mode ?? "off";
  const isOn = (s: SnippetDescriptor) => snippetEnabledOn(d.settings ?? undefined, s);
  const toggle = (s: SnippetDescriptor, next: boolean) =>
    run(s.slug, () =>
      // Send the pre-rename slug when one exists: old daemons only match their
      // exact slug, new daemons resolve it as an alias.
      setSnippet({ device_id: d.device_id, snippet: s.wireSlug ?? s.slug, enabled: next }),
    );

  const q = query.trim().toLowerCase();
  const matches = (on: boolean, text: string) =>
    (filter === "all" || (filter === "on") === on) && (!q || text.toLowerCase().includes(q));
  const stableText = `stable context ${STABLE_MODES.map((m) => m.desc).join(" ")} session history`;

  const groups = SNIPPET_CATEGORIES.map((c) => {
    const all = features.filter((s) => s.category === c.id);
    const shown = all.filter((s) => matches(isOn(s), `${s.name} ${s.slug} ${s.aliases?.join(" ") ?? ""} ${s.desc} ${s.detail}`));
    const withStable = c.id === "context";
    const stableShown = withStable && matches(stableMode !== "off", stableText);
    const onCount = all.filter(isOn).length + (withStable && stableMode !== "off" ? 1 : 0);
    return { ...c, all, shown, stableShown, total: all.length + (withStable ? 1 : 0), onCount };
  });
  const totalOn = groups.reduce((n, g) => n + g.onCount, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const visible = groups.filter((g) => g.shown.length > 0 || g.stableShown);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
            placeholder="Find a feature"
            aria-label="Find a feature"
            className="h-8 w-64 rounded-md border border-sol-border/70 bg-sol-bg pl-8 pr-2 text-xs text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan/50 focus:outline-none"
          />
        </div>
        <SegmentedToggle
          value={filter}
          onChange={(k) => setFilter(k as Filter)}
          items={[
            { key: "all", label: "All" },
            { key: "on", label: "On" },
            { key: "off", label: "Off" },
          ]}
        />
        <div className="flex-1" />
        <span className="text-xs text-sol-text-muted">
          <span className="font-medium text-sol-text">{totalOn}</span> of {total} on {deviceDisplayName(d)}
        </span>
      </div>

      {!d.online && (
        <p className="rounded-md bg-sol-yellow/10 px-3 py-2 text-xs text-sol-text">
          This machine is offline, so its features are read-only until it reconnects.
        </p>
      )}

      <div className="grid gap-10 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Feature groups" className="hidden lg:block">
          <div className="sticky top-4 space-y-0.5">
            {groups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => document.getElementById(`af-${g.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] text-sol-text-secondary transition-colors hover:bg-sol-bg-highlight/50 hover:text-sol-text"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE[g.id].dot}`} />
                <span className="flex-1 truncate">{g.name}</span>
                <span className="font-mono text-[10.5px] text-sol-text-dim">
                  {g.onCount}/{g.total}
                </span>
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-12">
          {visible.map((g) => {
            const off = g.all.filter((s) => !isOn(s));
            return (
              <section key={g.id} id={`af-${g.id}`} className="scroll-mt-4">
                <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
                  <div className="max-w-xl">
                    <h2 className="flex items-baseline gap-2.5 text-base font-semibold text-sol-text">
                      <span className={TONE[g.id].text}>{g.name}</span>
                      <span className="font-mono text-[11px] font-normal text-sol-text-dim">
                        {g.onCount} of {g.total} on
                      </span>
                    </h2>
                    <p className="mt-1 text-[13px] leading-relaxed text-sol-text-muted">{g.blurb}</p>
                  </div>
                  {off.length > 1 && d.online && (
                    <button
                      type="button"
                      onClick={() => off.forEach((s) => toggle(s, true))}
                      className="text-xs text-sol-text-muted hover:text-sol-text"
                    >
                      Turn on all {off.length}
                    </button>
                  )}
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  {g.stableShown && <StableCard d={d} panel={panel} />}
                  {g.shown.map((s) => (
                    <FeatureCard
                      key={s.slug}
                      s={s}
                      on={isOn(s)}
                      disabled={!d.online || pending.has(s.slug)}
                      onToggle={(next) => toggle(s, next)}
                      onOpen={() => setOpen(s)}
                    />
                  ))}
                </div>
              </section>
            );
          })}
          {visible.length === 0 && (
            <p className="py-16 text-center text-sm text-sol-text-muted">
              No feature matches{q ? <> &ldquo;{query}&rdquo;</> : null}.{" "}
              <span className="inline-flex items-center gap-1 text-xs text-sol-text-dim">
                <KeyCap size="xs">Esc</KeyCap> clears the search
              </span>
            </p>
          )}
        </div>
      </div>

      <FeatureDialog
        s={open}
        on={open ? isOn(open) : false}
        disabled={!open || !d.online || pending.has(open.slug)}
        onToggle={(next) => open && toggle(open, next)}
        onClose={() => setOpen(null)}
      />
    </>
  );
}

function StatusPill({ on }: { on: boolean }) {
  return (
    <span
      className={`rounded-full border px-1.5 py-px text-[10px] ${
        on ? "border-sol-green/30 bg-sol-green/10 text-sol-green" : "border-sol-border bg-sol-bg-alt text-sol-text-muted"
      }`}
    >
      {on ? "On" : "Off"}
    </span>
  );
}

function NewPill() {
  return (
    <span className="rounded-full border border-sol-cyan/30 bg-sol-cyan/10 px-1.5 py-px text-[10px] text-sol-cyan">New</span>
  );
}

function CardShell({
  category,
  icon: Icon,
  on,
  children,
  onOpen,
}: {
  category: SnippetCategory;
  icon: LucideIcon;
  on: boolean;
  children: React.ReactNode;
  onOpen?: () => void;
}) {
  const tone = TONE[category];
  return (
    <div
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (onOpen && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group flex gap-3.5 rounded-lg border bg-sol-bg p-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40 ${
        on ? `${tone.on} bg-sol-bg-alt/40` : "border-sol-border/70"
      } ${onOpen ? "cursor-pointer hover:border-sol-text-dim/60" : ""}`}
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md ${tone.tile}`}>
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function FeatureCard({
  s,
  on,
  disabled,
  onToggle,
  onOpen,
}: {
  s: SnippetDescriptor;
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <CardShell category={s.category} icon={ICONS[s.slug] ?? Blocks} on={on} onOpen={onOpen}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-sol-text">{s.name}</span>
            {isRecentlyShipped(s) && <NewPill />}
            <StatusPill on={on} />
          </div>
          <p className="mt-1 text-[13px] leading-snug text-sol-text-secondary">{s.desc}</p>
        </div>
        <div onClick={(e) => e.stopPropagation()} className="shrink-0 pt-0.5">
          <Switch checked={on} disabled={disabled} onCheckedChange={onToggle} aria-label={s.name} />
        </div>
      </div>
      <p className="mt-2 line-clamp-3 text-[12.5px] leading-relaxed text-sol-text-muted">{s.detail}</p>
      <div className="mt-3 flex items-center justify-between gap-3">
        <code className="truncate font-mono text-[11px] text-sol-text-dim">cast install {s.slug}</code>
        <span className="shrink-0 text-[11.5px] text-sol-text-muted group-hover:text-sol-text">
          {s.section ? "What your agent reads" : "Details"} →
        </span>
      </div>
    </CardShell>
  );
}

/** Stable context: a tri-state (Solo / Team / Off) and a scope switch. */
function StableCard({ d, panel }: { d: Device; panel: Panel }) {
  const { pending, run, setSnippet } = panel;
  const mode: StableMode = d.settings?.stable_mode ?? "off";
  const global = d.settings?.stable_global === true;
  const disabled = !d.online || pending.has(STABLE_KEY);
  const apply = (nextMode: StableMode, nextGlobal: boolean) =>
    run(STABLE_KEY, () =>
      setSnippet({
        device_id: d.device_id,
        snippet: STABLE_KEY,
        enabled: nextMode !== "off",
        mode: nextMode,
        global: nextGlobal,
      }),
    );
  const hook = hooksOfFeature(STABLE_KEY)[0];

  return (
    <CardShell category="context" icon={Layers} on={mode !== "off"}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm font-medium text-sol-text">Stable context</span>
        <StatusPill on={mode !== "off"} />
      </div>
      <p className="mt-1 text-[13px] leading-snug text-sol-text-secondary">
        Every new session starts with a digest of recent ones
      </p>
      <p className="mt-2 text-[12.5px] leading-relaxed text-sol-text-muted">
        {STABLE_MODES.find((m) => m.value === mode)?.desc}.
        {hook && <> Added as a SessionStart hook (~/.claude/hooks/{hook.file}).</>}
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <SegmentedToggle
          size="sm"
          value={mode}
          onChange={(v) => !disabled && apply(v as StableMode, global)}
          items={STABLE_MODES.map((m) => ({ key: m.value, label: m.name, title: m.desc }))}
        />
        <label className={`flex items-center gap-2 text-[11.5px] text-sol-text-muted ${mode === "off" ? "opacity-55" : ""}`}>
          All projects
          <Switch
            checked={global}
            disabled={disabled || mode === "off"}
            onCheckedChange={(next) => apply(mode, next)}
            aria-label="Stable context across all projects"
          />
        </label>
      </div>
    </CardShell>
  );
}

function FeatureDialog({
  s,
  on,
  disabled,
  onToggle,
  onClose,
}: {
  s: SnippetDescriptor | null;
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  onClose: () => void;
}) {
  const Icon = s ? ICONS[s.slug] ?? Blocks : Blocks;
  const hooks = s ? hooksOfFeature(s.slug) : [];
  return (
    <Dialog open={!!s} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[88dvh] max-w-3xl flex-col gap-0 overflow-hidden border-sol-border bg-sol-bg p-0">
        {s && (
          <>
            <div className="flex items-start gap-4 border-b border-sol-border px-6 pb-5 pt-6 pr-12">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${TONE[s.category].tile}`}>
                <Icon className="h-5 w-5" strokeWidth={1.75} />
              </div>
              <div className="min-w-0 flex-1">
                <DialogTitle className="flex flex-wrap items-center gap-2 text-lg font-semibold text-sol-text">
                  {s.name}
                  {isRecentlyShipped(s) && <NewPill />}
                </DialogTitle>
                <DialogDescription className="mt-1 text-[13px] text-sol-text-secondary">{s.desc}</DialogDescription>
              </div>
              <label className="flex shrink-0 items-center gap-2 pt-1 text-xs text-sol-text-muted">
                {on ? "On" : "Off"}
                <Switch checked={on} disabled={disabled} onCheckedChange={onToggle} aria-label={s.name} />
              </label>
            </div>
            <div className="scrollbar-auto min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <p className="text-[13.5px] leading-relaxed text-sol-text">{s.detail}</p>
              <dl className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-[12px]">
                <DetailRow label="Install" mono>
                  cast install {s.slug}
                  {s.aliases?.length ? <span className="text-sol-text-dim"> (or {s.aliases.join(", ")})</span> : null}
                </DetailRow>
                <DetailRow label="Writes to">{s.writesTo}</DetailRow>
                {hooks.map((h) => (
                  <DetailRow key={h.file} label="Hook">
                    {h.name} (~/.claude/hooks/{h.file}), added and removed with the switch
                  </DetailRow>
                ))}
                <DetailRow label="Since">{s.shipped}</DetailRow>
              </dl>
              {s.section && (
                <div className="mt-7">
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-sol-text-muted">
                    What your agent reads
                  </h3>
                  <div className="rounded-lg border border-sol-border/70 bg-sol-bg-alt/40 px-5 py-4 text-[13px]">
                    <MarkdownRenderer content={s.section.body.trim().replace(/\n<!-- \/codecast-[^>]+-->\s*$/, "")} />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, mono, children }: { label: string; mono?: boolean; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-sol-text-dim">{label}</dt>
      <dd className={`text-sol-text-secondary ${mono ? "font-mono" : ""}`}>{children}</dd>
    </>
  );
}
