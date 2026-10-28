"use client";

/**
 * The two mode switches on the composer's meta row: "isolated worktree" and
 * "run in the cloud". Presentational — ProjectSwitcher (ConversationView)
 * owns the state and the transitions (lib/sessionMachines). Cloud mode is
 * DERIVED from the routed machine there, so this component only reports what
 * it is told and never reads the store. In cloud mode the isolated toggle
 * becomes the workspace pick (own worktree vs the host's shared checkout).
 */

import { deviceDisplayName, type CloudAgentLaunch, type CloudAgentProviderSpec } from "@codecast/shared/contracts";
import type { SessionMachine } from "../lib/sessionMachines";
import { CloudAgentProblemNote, ConnectCloudAgentButton } from "./cloudAgents";
import { cloudAgentUi } from "./cloudAgents/providerUi";
import { DetailPopover } from "./cloudAgents/parts";
import type { CloudAgentProblem } from "./cloudAgents/machine";
import { ChevronDown, Cloud, Folder, GitBranch } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { FOOT_PICK } from "./ModelEffortPicker";

export type SessionModeTogglesProps = {
  /** The cloud host on the roster (offline included), or null without one. */
  cloudHost: SessionMachine | null;
  cloudMode: boolean;
  /** False when the toggle would have nowhere to go (a cloud-only roster). */
  cloudToggleEnabled: boolean;
  /** Why the session's team turns cloud hosting off (Managed devices); the cloud choice is locked. */
  cloudRefusal?: string | null;
  onToggleCloud: () => void;
  isolated: boolean;
  onToggleIsolated: () => void;
  /**
   * Cloud mode only: the isolated toggle reads as the workspace pick — on =
   * its own worktree on the host (default), off = the host's main checkout
   * (`shared`). Turning it off calls onToggleShared instead of onToggleIsolated,
   * so the local isolated flag is never written from cloud mode.
   */
  shared?: boolean;
  onToggleShared?: () => void;
  /**
   * Cloud mode only: what the worktree starts from — this laptop's checkout
   * (its branch, HEAD and uncommitted changes; the default) or a clean
   * origin/main. Pinned at origin/main while the shared checkout is picked.
   */
  startFrom?: "checkout" | "origin_main";
  onSetStartFrom?: (v: "checkout" | "origin_main") => void;
  /**
   * Set when the agent runs on a cloud agent provider (Cursor: Cursor Cloud
   * Agents): "run in the cloud" means the provider's machines, on the repo's
   * GitHub branch, instead of a codecast cloud host, and the host-only
   * controls step aside. `connected` is whether the machine that drives it
   * holds the provider's credentials.
   */
  cloudAgent?: {
    spec: CloudAgentProviderSpec;
    /** Every provider the agent type can run on (CloudAgentProviderSpec.lane): with more than one, a choice between them while on. */
    lanes?: CloudAgentProviderSpec[];
    onPickLane?: (spec: CloudAgentProviderSpec) => void;
    on: boolean;
    onToggle: () => void;
    connected: boolean;
    /** What the driving machine's daemon found in the provider's way (machine.ts); one no sign-in fixes (the provider changed, a limit, a workspace that refuses it) is said beside the switch. */
    problem?: CloudAgentProblem;
    deviceId?: string | null;
    /** While on, the provider's launch options (spec.launchOptions: ask mode, attempts) and how to change them. */
    launch?: CloudAgentLaunch;
    onSetLaunch?: (change: Partial<CloudAgentLaunch>) => void;
  };
};

const START_FROM_OPTIONS: Array<{ value: "checkout" | "origin_main"; label: string; title: string }> = [
  { value: "checkout", label: "my checkout", title: "my checkout — the branch, commit and uncommitted changes of this repo on the laptop that prepares the host" },
  { value: "origin_main", label: "origin/main", title: "origin/main — a clean checkout of the default branch" },
];

/** One of the meta row's switches: a small track and its label, lit in `accent` while on. */
function ModeSwitch({ on, accent, label, title, onClick, disabled = false }: { on: boolean; accent: "cyan" | "violet"; label: string; title: string; onClick: () => void; disabled?: boolean }) {
  const lit = accent === "cyan" ? { track: "bg-sol-cyan/30", knob: "bg-sol-cyan", text: "text-sol-cyan" } : { track: "bg-sol-violet/30", knob: "bg-sol-violet", text: "text-sol-violet" };
  return (
    <button
      onClick={() => { if (!disabled) onClick(); }}
      disabled={disabled}
      role="switch"
      aria-checked={on}
      className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:cursor-default disabled:hover:text-sol-text-dim"
      title={title}
    >
      <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${on ? lit.track : "bg-sol-border/40"}`}>
        <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${on ? `left-3.5 ${lit.knob}` : "left-0.5 bg-sol-text-dim"}`} />
      </span>
      <span className={on ? lit.text : ""}>{label}</span>
    </button>
  );
}

/** A labelled row of pills where one is picked (what a cloud worktree starts from, how many attempts a cloud task makes). */
function PillRadio<T extends string | number>({ label, options, value, onPick, disabled = false, title }: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  value: T;
  onPick: (v: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <span role="radiogroup" aria-label={label} className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim" title={title}>
      <span>{label}</span>
      <span className="inline-flex rounded-full border border-sol-border/40 overflow-hidden">
        {options.map((o) => {
          const active = value === o.value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => { if (!disabled && !active) onPick(o.value); }}
              title={o.title}
              className={`px-1.5 py-px transition-colors disabled:cursor-default ${active ? "bg-sol-violet/20 text-sol-violet" : "hover:text-sol-text"}`}
            >
              {o.label}
            </button>
          );
        })}
      </span>
    </span>
  );
}

const ISOLATED_TITLE = "Create session in an isolated git worktree";

type CloudAgent = NonNullable<SessionModeTogglesProps["cloudAgent"]>;

// Several ways to run on one vendor's machines (Codex: your ChatGPT plan or an
// API key): the control names the vendor's cloud (never bare "the cloud",
// which is a codecast cloud host's, and never just the vendor, which reads as
// its models), and the lane pills say how it is paid for.
function cloudAgentLanes(cloudAgent: CloudAgent) {
  return (cloudAgent.lanes ?? []).filter((l) => l.lane);
}
function cloudAgentPlace(cloudAgent: CloudAgent) {
  return cloudAgentLanes(cloudAgent).length > 1 ? `${cloudAgent.spec.vendor}'s cloud` : cloudAgent.spec.label;
}

/** While a cloud agent launch is on: its lane, launch options, and anything in its way. */
function CloudAgentOptions({ cloudAgent }: { cloudAgent: CloudAgent }) {
  const { spec, on, connected, problem, launch, onSetLaunch, onPickLane } = cloudAgent;
  const options = on && launch && onSetLaunch ? spec.launchOptions : undefined;
  const lanes = cloudAgentLanes(cloudAgent);
  const choosing = lanes.length > 1;
  return (
    <>
      {on && choosing && onPickLane && (
        <>
          <PillRadio
            label="with"
            title={spec.toggleTitle}
            options={lanes.map((l) => ({ value: l.id, label: l.lane!.label, title: `${l.label}: ${l.lane!.detail}` }))}
            value={spec.id}
            onPick={(id) => { const lane = lanes.find((l) => l.id === id); if (lane) onPickLane(lane); }}
          />
          {spec.lane && (
            <DetailPopover label={spec.lane.cost} about={`About ${spec.label}`} className="text-sol-text-dim hover:text-sol-text">
              <span className="font-medium text-sol-text">{spec.label}</span>: {spec.lane.detail}
            </DetailPopover>
          )}
        </>
      )}
      {options?.ask && (
        <ModeSwitch
          on={launch!.ask}
          accent="violet"
          label="ask"
          title={`Ask mode: ${spec.label} reads the repository and answers, without changing code or opening a pull request`}
          onClick={() => onSetLaunch!({ ask: !launch!.ask })}
        />
      )}
      {options && options.maxAttempts > 1 && (
        <PillRadio
          label="attempts"
          title={`How many attempts ${spec.label} makes at the first message; each becomes a branch of this session to compare and continue`}
          options={Array.from({ length: options.maxAttempts }, (_, i) => ({ value: i + 1, label: String(i + 1) }))}
          value={launch!.attempts}
          onPick={(attempts) => onSetLaunch!({ attempts })}
        />
      )}
      {/* A problem no sign-in fixes (the provider changed, a limit, a workspace or repository it refuses): its word, beside the switch. */}
      {on && problem && !problem.credential && <CloudAgentProblemNote spec={spec} problem={problem} where="composer" />}
      {on && !connected && <ConnectCloudAgentButton spec={spec} label={cloudAgentUi(spec).connectInlineLabel} deviceId={cloudAgent.deviceId} />}
    </>
  );
}

export function SessionModeToggles({ cloudHost, cloudMode, cloudToggleEnabled, cloudRefusal, onToggleCloud, isolated, onToggleIsolated, shared = false, onToggleShared, startFrom = "checkout", onSetStartFrom, cloudAgent }: SessionModeTogglesProps) {
  const effectiveStartFrom = shared ? "origin_main" : startFrom;
  if (cloudAgent) {
    const { spec, on, onToggle } = cloudAgent;
    const lanes = cloudAgentLanes(cloudAgent);
    return (
      <>
        {!on && <ModeSwitch on={isolated} accent="cyan" label="isolated worktree" title={ISOLATED_TITLE} onClick={onToggleIsolated} />}
        <ModeSwitch
          on={on}
          accent="violet"
          label={`run in ${cloudAgentPlace(cloudAgent)}`}
          title={lanes.length > 1 && !on ? `Run this session on ${spec.vendor}'s machines: ${lanes.map((l) => `${l.label} on your ${l.lane!.label}`).join(", or ")}` : spec.toggleTitle}
          onClick={onToggle}
        />
        <CloudAgentOptions cloudAgent={cloudAgent} />
      </>
    );
  }
  return (
    <>
      <ModeSwitch
        on={isolated}
        accent="cyan"
        label="isolated worktree"
        title={cloudMode
          ? (shared
            ? "Runs in the host's main checkout — refused if it is dirty or another session is using it"
            : "Own worktree on the host (default)")
          : ISOLATED_TITLE}
        onClick={() => { if (cloudMode) onToggleShared?.(); else onToggleIsolated(); }}
      />

      {cloudHost && (
        <ModeSwitch
          on={cloudMode}
          accent="violet"
          label="run in the cloud"
          disabled={!cloudToggleEnabled || (!!cloudRefusal && !cloudMode)}
          title={cloudRefusal && !cloudMode ? cloudRefusal : cloudToggleEnabled
            ? `Run this session on ${deviceDisplayName(cloudHost)}, in its own worktree there. The host boots itself when the session starts; turn off 'isolated worktree' to use the host's main checkout.`
            : `${deviceDisplayName(cloudHost)} is the only machine you have — sessions run there`}
          onClick={onToggleCloud}
        />
      )}

      {cloudHost && cloudMode && (
        <PillRadio
          label="start from"
          title={shared ? "The shared checkout always starts at origin/main" : undefined}
          options={START_FROM_OPTIONS}
          value={effectiveStartFrom}
          disabled={shared}
          onPick={(v) => onSetStartFrom?.(v)}
        />
      )}
    </>
  );
}

export type SessionPlacement = "checkout" | "worktree" | "cloud";

/**
 * Where the session runs, as one menu in the new-session composer foot: this
 * checkout, an isolated worktree, or the cloud (a codecast cloud host, or the
 * agent's own cloud). Same state as SessionModeToggles; the owner maps a pick
 * onto its transitions (onPick). On a host, the workspace and start-from
 * choices sit in the menu; a cloud agent's options follow it in the row.
 */
export function SessionPlacementMenu({ cloudHost, cloudMode, cloudToggleEnabled, cloudRefusal, isolated, shared = false, onToggleShared, startFrom = "checkout", onSetStartFrom, cloudAgent, onPick }: SessionModeTogglesProps & { onPick: (p: SessionPlacement) => void }) {
  const cloudOn = cloudAgent ? cloudAgent.on : cloudMode;
  const current: SessionPlacement = cloudOn ? "cloud" : isolated ? "worktree" : "checkout";
  const cloudName = cloudAgent ? cloudAgentPlace(cloudAgent) : cloudHost ? deviceDisplayName(cloudHost) : null;
  // A cloud-only roster has nowhere local to go.
  const localLocked = !cloudAgent && cloudMode && !cloudToggleEnabled;
  const hostLocked = !cloudAgent && !cloudMode && !!cloudRefusal;
  const rows: { key: SessionPlacement; icon: typeof Folder; label: string; hint: string; disabled?: boolean; title?: string }[] = [
    { key: "checkout", icon: Folder, label: "This checkout", hint: "edits the folder in place", disabled: localLocked },
    { key: "worktree", icon: GitBranch, label: "Isolated worktree", hint: "its own branch", disabled: localLocked },
    ...(cloudName ? [{ key: "cloud" as const, icon: Cloud, label: cloudName, hint: cloudAgent ? cloudAgent.spec.vendor : hostLocked ? "turned off" : "cloud host", disabled: hostLocked, title: hostLocked ? cloudRefusal! : undefined }] : []),
  ];
  const now = rows.find((r) => r.key === current) ?? rows[0];
  const Icon = now.icon;
  const effectiveStartFrom = shared ? "origin_main" : startFrom;
  const check = (on: boolean) => <span className={`w-3 text-center ${on ? "text-sol-cyan" : "text-transparent"}`}>●</span>;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={FOOT_PICK} title="Where this session runs">
            <Icon className={`w-3.5 h-3.5 ${current === "cloud" ? "text-sol-violet" : current === "worktree" ? "text-sol-cyan" : ""}`} />
            {now.label}
            <ChevronDown className="w-3 h-3 opacity-50" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[15rem]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Runs in</DropdownMenuLabel>
          {rows.map((r) => (
            <DropdownMenuItem key={r.key} disabled={r.disabled} title={r.title} onSelect={() => { if (r.key !== current) onPick(r.key); }} className="flex items-center gap-2 text-xs">
              {check(r.key === current)}
              <r.icon className="w-3.5 h-3.5 text-sol-text-dim" />
              <span className={r.key === current ? "text-sol-text font-medium" : ""}>{r.label}</span>
              <span className="ml-auto pl-3 text-[10px] text-sol-text-dim">{r.hint}</span>
            </DropdownMenuItem>
          ))}
          {cloudMode && !cloudAgent && cloudHost && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">On the host</DropdownMenuLabel>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); if (shared) onToggleShared?.(); }} className="flex items-center gap-2 text-xs">
                {check(!shared)}own worktree
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={(e) => { e.preventDefault(); if (!shared) onToggleShared?.(); }} className="flex items-center gap-2 text-xs" title="Refused if it is dirty or another session is using it">
                {check(shared)}main checkout
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-sol-text-dim">Start from</DropdownMenuLabel>
              {START_FROM_OPTIONS.map((o) => (
                <DropdownMenuItem key={o.value} disabled={shared} onSelect={(e) => { e.preventDefault(); if (o.value !== effectiveStartFrom) onSetStartFrom?.(o.value); }} className="flex items-center gap-2 text-xs" title={o.title}>
                  {check(o.value === effectiveStartFrom)}{o.label}
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {cloudAgent?.on && <span className="inline-flex items-center gap-3 pl-1"><CloudAgentOptions cloudAgent={cloudAgent} /></span>}
    </>
  );
}
