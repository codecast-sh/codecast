"use client";

/**
 * The two mode switches on the composer's meta row: "isolated worktree" and
 * "run in the cloud". Presentational — ProjectSwitcher (ConversationView)
 * owns the state and the transitions (lib/sessionMachines). Cloud mode is
 * DERIVED from the routed machine there, so this component only reports what
 * it is told and never reads the store. In cloud mode the isolated toggle
 * becomes the workspace pick (own worktree vs the host's shared checkout).
 */

import { deviceDisplayName } from "@codecast/shared/contracts";
import type { SessionMachine } from "../lib/sessionMachines";

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
};

const START_FROM_OPTIONS: Array<{ value: "checkout" | "origin_main"; label: string; title: string }> = [
  { value: "checkout", label: "my checkout", title: "my checkout — the branch, commit and uncommitted changes of this repo on the laptop that prepares the host" },
  { value: "origin_main", label: "origin/main", title: "origin/main — a clean checkout of the default branch" },
];

export function SessionModeToggles({ cloudHost, cloudMode, cloudToggleEnabled, onToggleCloud, isolated, onToggleIsolated, shared = false, onToggleShared, startFrom = "checkout", onSetStartFrom }: SessionModeTogglesProps) {
  const effectiveStartFrom = shared ? "origin_main" : startFrom;
  return (
    <>
      <button
        onClick={() => { if (cloudMode) onToggleShared?.(); else onToggleIsolated(); }}
        className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:cursor-default disabled:hover:text-sol-text-dim"
        title={cloudMode
          ? (shared
            ? "Runs in the host's main checkout — refused if it is dirty or another session is using it"
            : "Own worktree on the host (default)")
          : "Create session in an isolated git worktree"}
      >
        <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${isolated ? "bg-sol-cyan/30" : "bg-sol-bg-alt"}`}>
          <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${isolated ? "left-3.5 bg-sol-cyan" : "left-0.5 bg-sol-text-dim"}`} />
        </span>
        <span className={isolated ? "text-sol-cyan" : ""}>isolated worktree</span>
      </button>

      {cloudHost && (
        <button
          onClick={() => { if (cloudToggleEnabled) onToggleCloud(); }}
          disabled={!cloudToggleEnabled}
          className="flex items-center gap-2 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors disabled:cursor-default disabled:hover:text-sol-text-dim"
          title={cloudToggleEnabled
            ? `Run this session on ${deviceDisplayName(cloudHost)}, in its own worktree there. The host boots itself when the session starts; turn off 'isolated worktree' to use the host's main checkout.`
            : `${deviceDisplayName(cloudHost)} is the only machine you have — sessions run there`}
        >
          <span className={`w-7 h-4 rounded-full transition-colors relative flex-shrink-0 ${cloudMode ? "bg-sol-violet/30" : "bg-sol-bg-alt"}`}>
            <span className={`absolute top-0.5 w-3 h-3 rounded-full transition-all ${cloudMode ? "left-3.5 bg-sol-violet" : "left-0.5 bg-sol-text-dim"}`} />
          </span>
          <span className={cloudMode ? "text-sol-violet" : ""}>run in the cloud</span>
        </button>
      )}

      {cloudHost && cloudMode && (
        <span
          role="radiogroup"
          aria-label="start from"
          className="inline-flex items-center gap-1.5 text-[11px] text-sol-text-dim"
          title={shared ? "The shared checkout always starts at origin/main" : undefined}
        >
          <span>start from</span>
          <span className="inline-flex rounded-full border border-sol-border/40 overflow-hidden">
            {START_FROM_OPTIONS.map((o) => {
              const active = effectiveStartFrom === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={shared}
                  onClick={() => { if (!shared && !active) onSetStartFrom?.(o.value); }}
                  title={o.title}
                  className={`px-1.5 py-px transition-colors disabled:cursor-default ${active ? "bg-sol-violet/20 text-sol-violet" : "hover:text-sol-text"}`}
                >
                  {o.label}
                </button>
              );
            })}
          </span>
        </span>
      )}
    </>
  );
}
