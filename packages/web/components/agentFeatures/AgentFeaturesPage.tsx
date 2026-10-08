"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight, Blocks, Check, Search } from "lucide-react";
import {
  FEATURE_EXPLAINERS,
  SNIPPET_CATALOG,
  SNIPPET_CATEGORIES,
  STABLE_MODES,
  isAgentSetupTool,
  snippetAvailableForTeams,
  type AgentSetupTool,
  type SnippetDescriptor,
  type StableMode,
} from "@codecast/shared/contracts";
import { AuthGuard } from "../AuthGuard";
import { SegmentedToggle } from "../SegmentedToggle";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { Switch } from "../ui/switch";
import { deviceDisplayName, type Device } from "../DeviceBadge";
import { DeviceSettingsFrame } from "../settings/DeviceSettingsFrame";
import { useDeviceSettingsPanel } from "../settings/useDeviceSettingsPanel";
import { useInboxStore } from "../../store/inboxStore";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { isRecentlyShipped, snippetEnabledOn } from "../../lib/newSnippets";
import { FeatureVignette } from "./FeatureVignette";
import { FeatureDialog, NewPill, STABLE_NAME } from "./FeatureDetail";
import { featureIcon, featureTone, TONE } from "./featureLook";
import { AgentToolSetupPanel } from "../conversation/blocks/AgentToolSetupCard";
import { useAgentToolSetup } from "../../lib/useAgentToolSetup";

/**
 * /agent-features: what codecast can teach your agents. The web twin of
 * `cast install`. Each machine keeps its own config (its ~/.codecast/config.json),
 * heartbeat-reported into `device.settings`, so the page shows ONE device at a
 * time. Flipping a switch enqueues a device-targeted command that runs the same
 * CLI command a human would; the server mirrors the change optimistically so it
 * moves instantly, and the next heartbeat reconciles to the device's real
 * state. Offline devices are read-only (the command would expire before the
 * daemon could run it). `?feature=<slug>` opens that feature's detail, which is
 * how the upsells across the app link here.
 */

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
  const router = useRouter();
  const pathname = usePathname();
  const open = useSearchParams()?.get("feature") ?? null;
  const setOpen = (slug: string | null) =>
    router.replace(slug ? `${pathname}?feature=${encodeURIComponent(slug)}` : pathname ?? "/agent-features");

  const stableMode: StableMode = d.settings?.stable_mode ?? "off";
  const isOn = (s: SnippetDescriptor) => snippetEnabledOn(d.settings ?? undefined, s);
  const toggle = (s: SnippetDescriptor, next: boolean) => {
    // A feature with a one-time step on the machine opens on its steps the
    // moment it is switched on, so the next thing to do is in front of you.
    if (next && isAgentSetupTool(s.slug) && d.online) setOpen(s.slug);
    return run(s.slug, () =>
      // Send the pre-rename slug when one exists: old daemons only match their
      // exact slug, new daemons resolve it as an alias.
      setSnippet({ device_id: d.device_id, snippet: s.wireSlug ?? s.slug, enabled: next }),
    );
  };

  const q = query.trim().toLowerCase();
  const searchText = (slug: string, ...parts: string[]) => {
    const e = FEATURE_EXPLAINERS[slug];
    return [...parts, slug, e?.pitch ?? "", ...(e?.youSee ?? []), ...(e?.agentsUse ?? [])].join(" ");
  };
  const matches = (on: boolean, text: string) =>
    (filter === "all" || (filter === "on") === on) && (!q || text.toLowerCase().includes(q));

  const groups = SNIPPET_CATEGORIES.map((c) => {
    const all = features.filter((s) => s.category === c.id);
    const shown = all.filter((s) =>
      matches(isOn(s), searchText(s.slug, s.name, s.aliases?.join(" ") ?? "", s.desc, s.detail)),
    );
    const withStable = c.id === "context";
    const stableShown = withStable && matches(stableMode !== "off", searchText(STABLE_KEY, STABLE_NAME, "session history"));
    const onCount = all.filter(isOn).length + (withStable && stableMode !== "off" ? 1 : 0);
    return { ...c, all, shown, stableShown, total: all.length + (withStable ? 1 : 0), onCount };
  });
  const totalOn = groups.reduce((n, g) => n + g.onCount, 0);
  const total = groups.reduce((n, g) => n + g.total, 0);
  const visible = groups.filter((g) => g.shown.length > 0 || g.stableShown);
  const openFeature = open && open !== STABLE_KEY ? features.find((s) => s.slug === open) ?? null : null;

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

      <div className="grid gap-10 lg:grid-cols-[224px_minmax(0,1fr)]">
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
                <span className="flex-1">{g.name}</span>
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
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
                  {g.stableShown && <StableCard d={d} panel={panel} onOpen={() => setOpen(STABLE_KEY)} />}
                  {g.shown.map((s) => (
                    <FeatureCard
                      key={s.slug}
                      s={s}
                      d={d}
                      on={isOn(s)}
                      disabled={!d.online || pending.has(s.slug)}
                      onToggle={(next) => toggle(s, next)}
                      onOpen={() => setOpen(s.slug)}
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
        slug={openFeature ? openFeature.slug : open === STABLE_KEY ? STABLE_KEY : null}
        feature={openFeature}
        setup={
          openFeature && isAgentSetupTool(openFeature.slug) && isOn(openFeature) && d.online ? (
            <AgentToolSetupPanel tool={openFeature.slug} target={{ deviceId: d.device_id }} machineName={deviceDisplayName(d)} />
          ) : null
        }
        onClose={() => setOpen(null)}
        control={
          openFeature ? (
            <label className="flex shrink-0 items-center gap-2 pt-1 text-xs text-sol-text-muted">
              {isOn(openFeature) ? "On" : "Off"}
              <Switch
                checked={isOn(openFeature)}
                disabled={!d.online || pending.has(openFeature.slug)}
                onCheckedChange={(next) => toggle(openFeature, next)}
                aria-label={openFeature.name}
              />
            </label>
          ) : open === STABLE_KEY ? (
            <StableControls d={d} panel={panel} />
          ) : null
        }
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

/** One feature's card: its picture, its name and switch, and what you get. */
function CardShell({
  slug,
  on,
  title,
  control,
  footer,
  onOpen,
}: {
  slug: string;
  on: boolean;
  /** Name and pills, beside the icon. */
  title: React.ReactNode;
  /** The switch, at the head's right edge. */
  control?: React.ReactNode;
  footer: React.ReactNode;
  onOpen: () => void;
}) {
  const tone = featureTone(slug);
  const Icon = featureIcon(slug);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-colors hover:border-sol-text-dim/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sol-cyan/40 ${
        on ? `${tone.on} bg-sol-bg-alt/40` : "border-sol-border/70 bg-sol-bg"
      }`}
    >
      <FeatureVignette slug={slug} className="h-[132px] rounded-none border-0 border-b border-sol-border/50" />
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-center gap-2.5">
          <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${tone.tile}`}>
            <Icon className="h-4 w-4" strokeWidth={1.75} />
          </div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">{title}</div>
          {control && (
            <div onClick={(e) => e.stopPropagation()} className="shrink-0">
              {control}
            </div>
          )}
        </div>
        <p className="mt-3 text-[13px] leading-relaxed text-sol-text">{FEATURE_EXPLAINERS[slug]?.pitch}</p>
        <div className="mt-auto pt-3">{footer}</div>
      </div>
    </div>
  );
}

function CardFooter({ left, mono = true }: { left: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[11.5px]">
      <span className={`text-[11px] text-sol-text-dim ${mono ? "font-mono" : ""}`}>{left}</span>
      <span className="text-sol-text-muted group-hover:text-sol-text">How it works →</span>
    </div>
  );
}

function FeatureCard({
  s,
  d,
  on,
  disabled,
  onToggle,
  onOpen,
}: {
  s: SnippetDescriptor;
  d: Device;
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <CardShell
      slug={s.slug}
      on={on}
      onOpen={onOpen}
      title={
        <>
          <span className="text-sm font-medium text-sol-text">{s.name}</span>
          {isRecentlyShipped(s) && <NewPill />}
          <StatusPill on={on} />
        </>
      }
      control={<Switch checked={on} disabled={disabled} onCheckedChange={onToggle} aria-label={s.name} />}
      footer={
        isAgentSetupTool(s.slug) && on && d.online
          ? <SetupFooter tool={s.slug} d={d} />
          : <CardFooter left={`cast install ${s.slug}`} />
      }
    />
  );
}

/**
 * A feature that also needs a one-time step on the machine (the Chrome
 * extension, the macOS grants): done, it is a green line; not done, it is the
 * next step and its buttons, right on the card.
 */
function SetupFooter({ tool, d }: { tool: AgentSetupTool; d: Device }) {
  const { status } = useAgentToolSetup({ deviceId: d.device_id }, tool, true);
  if (status?.ready) {
    return (
      <CardFooter
        mono={false}
        left={
          <span className="inline-flex items-center gap-1 text-sol-green">
            <Check className="h-3 w-3" strokeWidth={2.5} /> {tool === "browser" ? "Chrome connected" : "Permissions granted"}
          </span>
        }
      />
    );
  }
  return (
    <div className="space-y-2 border-t border-sol-yellow/25 pt-3">
      <AgentToolSetupPanel tool={tool} target={{ deviceId: d.device_id }} machineName={deviceDisplayName(d)} compact />
    </div>
  );
}

/** Stable context: a tri-state (Solo / Team / Off) and a scope switch. */
function useStable(d: Device, panel: Panel) {
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
  return { mode, global, disabled, apply };
}

function StableControls({ d, panel }: { d: Device; panel: Panel }) {
  const { mode, global, disabled, apply } = useStable(d, panel);
  return (
    <div onClick={(e) => e.stopPropagation()} className="flex flex-wrap items-center gap-3">
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
  );
}

function StableCard({ d, panel, onOpen }: { d: Device; panel: Panel; onOpen: () => void }) {
  const { mode } = useStable(d, panel);
  return (
    <CardShell
      slug={STABLE_KEY}
      on={mode !== "off"}
      onOpen={onOpen}
      title={
        <>
          <span className="text-sm font-medium text-sol-text">{STABLE_NAME}</span>
          <StatusPill on={mode !== "off"} />
        </>
      }
      footer={
        <div className="space-y-3">
          <StableControls d={d} panel={panel} />
          <CardFooter mono={false} left={STABLE_MODES.find((m) => m.value === mode)?.desc ?? ""} />
        </div>
      }
    />
  );
}
