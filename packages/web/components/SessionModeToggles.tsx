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
import { ConnectCloudAgentButton, cloudAgentUi } from "./cloudAgents";

export type SessionModeTogglesProps = {
  /** The cloud host on the roster (offline included), or null without one. */
  cloudHost: SessionMachine | null;
  cloudMode: boolean;
  /** False when the toggle would have nowhere to go (a cloud-only roster). */
  cloudToggleEnabled: boolean;
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
    on: boolean;
    onToggle: () => void;
    connected: boolean;
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
      aria-pressed={on}
      className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:cursor-default disabled:hover:text-sol-text-dim"
      title={title}
    >
      <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${on ? lit.track : "bg-sol-bg-alt"}`}>
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

export function SessionModeToggles({ cloudHost, cloudMode, cloudToggleEnabled, onToggleCloud, isolated, onToggleIsolated, shared = false, onToggleShared, startFrom = "checkout", onSetStartFrom, cloudAgent }: SessionModeTogglesProps) {
  const effectiveStartFrom = shared ? "origin_main" : startFrom;
  if (cloudAgent) {
    const { spec, on, onToggle, connected, launch, onSetLaunch } = cloudAgent;
    const options = on && launch && onSetLaunch ? spec.launchOptions : undefined;
    return (
      <>
        {!on && <ModeSwitch on={isolated} accent="cyan" label="isolated worktree" title={ISOLATED_TITLE} onClick={onToggleIsolated} />}
        <ModeSwitch on={on} accent="violet" label={`run in ${spec.label}`} title={spec.toggleTitle} onClick={onToggle} />
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
        {on && !connected && <ConnectCloudAgentButton spec={spec} label={cloudAgentUi(spec).connectInlineLabel} deviceId={cloudAgent.deviceId} />}
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
          disabled={!cloudToggleEnabled}
          title={cloudToggleEnabled
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
