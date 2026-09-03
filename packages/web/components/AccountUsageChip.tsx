"use client";

// Header chip: live model usage for ONE provider — the one backing the
// session you're viewing (sticky to the last shown when the selection is
// neither Claude nor Codex), with a meter of its most-utilized limit window,
// always visible so a session-limit surprise never is one. Hovering the chip
// opens the full panel: the ACTIVE accounts broken out on top (what's "on"
// right now), the rest grouped by email below, the auto-switch toggle, and
// the path to Settings.

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { KeyRound, TimerReset, Zap, ZapOff } from "lucide-react";
import { ClaudeIcon, OpenAIIcon } from "./BrandIcons";
import { Switch } from "./ui/switch";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useAccountRecoveryToggles } from "../hooks/useAccountRecoveryToggles";
import { useTrackedStore } from "../store/inboxStore";
import { exhaustionBannerCopy, isExhaustionCurrent, worstUsagePercent, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { formatAgo } from "@codecast/shared/contracts";
import { usageTone } from "../lib/usageTone";
import { AccountUsageBars } from "./AccountUsageMeter";

type ProfileRow = {
  name: string;
  email?: string;
  tier?: string;
  subscription?: string;
  usage?: CcUsage;
};

function MiniMeter({ percent }: { percent: number }) {
  const tone = usageTone(percent);
  return (
    <span className="tb-squeeze-2 inline-block h-[5px] w-14 overflow-hidden rounded-full bg-sol-bg-inset align-middle">
      <span
        className="block h-full rounded-full transition-[width] duration-500"
        style={{ width: `${Math.min(100, Math.max(2, percent))}%`, background: tone }}
      />
    </span>
  );
}

// The chip's visible slice: name + meter + % — a fixed layout that never
// reflows on hover (detail lives in the hover panel). A provider with
// no usage data renders as icon + name with no meter.
function ProviderSegment({
  icon,
  label,
  percent,
  tone,
  stub,
  title,
}: {
  icon: ReactNode;
  label: string;
  percent: number | null;
  tone: string;
  stub: boolean;
  title: string;
}) {
  return (
    <span className="flex items-center gap-1.5" style={{ opacity: stub ? 0.4 : 1 }} aria-label={title}>
      {icon}
      {!stub && (
        <span className="tb-squeeze-1 max-w-[88px] truncate font-mono text-[11px] font-bold" style={{ color: tone }}>
          {label}
        </span>
      )}
      {!stub && percent != null && (
        <>
          <MiniMeter percent={percent} />
          <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: tone }}>
            {Math.round(percent)}%
          </span>
        </>
      )}
    </span>
  );
}

export function AccountUsageChip() {
  const data = useQuery(api.accountSwitch.listAccountProfiles, {});
  const requestSwitch = useMutation(api.accountSwitch.requestAccountSwitch);
  const router = useRouter();
  const now = useCoarseNow(30_000);
  // Hovering the chip expands the full usage panel DOWN from it. The panel is
  // a child of the same wrapper, so it stays open while the mouse is over it.
  // Closing goes through a short grace timer: a diagonal pointer path can
  // briefly exit the wrapper on its way into the panel, and an instant close
  // makes that read as a dropped hover.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openNow = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
  const closeSoon = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  const [switching, setSwitching] = useState<string | null>(null);
  // The chip shows ONE provider: the one backing the session you're viewing.
  // Sticky across selections that map to neither provider (other agent types,
  // nothing selected) so the chip doesn't blink to a default; the other
  // provider stays a popover away.
  const s = useTrackedStore([
    (st) => {
      const id = st.currentSessionId;
      return id ? ((st.conversations[id] ?? st.sessions[id])?.agent_type ?? null) : null;
    },
  ]);
  const currentId = s.currentSessionId;
  const currentAgentType = currentId
    ? ((s.conversations[currentId] ?? s.sessions[currentId])?.agent_type ?? null)
    : null;
  const lastShownProvider = useRef<"claude" | "codex" | null>(null);

  // The primary (non-remote) machine is the one whose login rotates through
  // profiles; remotes mirror it, so their meters would be duplicates.
  // Online only: the query also carries a recently-offline primary (for the
  // settings page's auto-switch toggle), whose meters would render stale here.
  const device = data?.devices.find((d) => !d.is_remote && d.online !== false);
  // Hooks run unconditionally; the placeholder device is never flipped because
  // the panel (and its switches) only render once a real device exists.
  const recovery = useAccountRecoveryToggles(
    device ?? { device_id: "", auto_switch: false, auto_continue: undefined },
  );
  const profiles: ProfileRow[] = device?.profiles ?? [];
  const active = profiles.find((p) => p.email && p.email === device?.active_email);
  // Codex accounts arrive in the same inventory shape as Claude's; the active
  // login is matched by email (uuid isn't exposed per profile), first profile
  // as fallback for legacy single-snapshot devices.
  const codexProfiles: ProfileRow[] = device?.codex_accounts?.profiles ?? [];
  const activeCodex =
    codexProfiles.find((p) => p.email && p.email === device?.codex_accounts?.active_email) ??
    codexProfiles[0];
  if (!device || (!active && !activeCodex)) return null;

  // Time-aware: a window whose reset has passed contributes 0, so a dormant
  // account's old 100% never keeps the chip pegged red.
  const worst = active ? worstUsagePercent(active.usage, now) : null;
  const codexWorst = activeCodex ? worstUsagePercent(activeCodex.usage, now) : null;
  const claudeTone = worst != null ? usageTone(worst) : "var(--sol-text-dim)";
  const codexTone = codexWorst != null ? usageTone(codexWorst) : "var(--sol-text-dim)";
  // The segment reads as: account name + worst LIMIT window. (The label used
  // to be the week's dominant model, which made "sol 0%" in the chip
  // contradict the popover's "SOL 100%" token-share row.)
  const codexLabel = activeCodex?.name ?? "codex";
  const claudeUsed = !!active && worst != null && worst > 0;
  const codexUsed =
    !!activeCodex && ((activeCodex.usage?.models?.length ?? 0) > 0 || (codexWorst ?? 0) > 0);
  // Session's provider wins; a selection that maps to neither (cursor, gemini,
  // nothing open) keeps the last shown; first render falls back to whichever
  // provider has an account, Claude first. Every branch checks the account
  // exists, so the shown provider always has one (the early return above
  // guarantees at least one does).
  const sessionProvider =
    currentAgentType === "codex" || currentAgentType === "codex_cli"
      ? "codex"
      : currentAgentType === "claude_code"
        ? "claude"
        : null;
  const shown: "claude" | "codex" =
    sessionProvider === "codex" && activeCodex
      ? "codex"
      : sessionProvider === "claude" && active
        ? "claude"
        : lastShownProvider.current === "codex" && activeCodex
          ? "codex"
          : lastShownProvider.current === "claude" && active
            ? "claude"
            : active
              ? "claude"
              : "codex";
  lastShownProvider.current = shown;
  // The chip border speaks for the shown provider.
  const tone = shown === "codex" ? codexTone : claudeTone;
  // Panel list: the ACTIVE accounts (the Claude and Codex login actually in
  // use) break out into their own section on top — that's the "what is on"
  // answer. Everything else groups by email below: the same login usually
  // exists on both providers, so one email header covers its Claude and
  // Codex rows.
  type AccountEntry = { provider: "claude" | "codex"; p: ProfileRow; isActive: boolean };
  const allEntries: AccountEntry[] = [
    ...profiles.map((p) => ({ provider: "claude" as const, p, isActive: p === active })),
    ...codexProfiles.map((p) => ({ provider: "codex" as const, p, isActive: p === activeCodex })),
  ];
  const buildGroups = (entries: AccountEntry[]) => {
    const byEmail = new Map<string, AccountEntry[]>();
    for (const e of entries) {
      const key = e.p.email ?? e.p.name;
      byEmail.set(key, [...(byEmail.get(key) ?? []), e]);
    }
    return [...byEmail.entries()].map(([email, list]) => ({ email, entries: list }));
  };
  const activeGroups = buildGroups(allEntries.filter((e) => e.isActive));
  const otherGroups = buildGroups(allEntries.filter((e) => !e.isActive));
  const autoOn = recovery.autoSwitch.on;
  const state = device.auto_switch_state;
  // Only a re-check clears the stamp, so an old one keeps claiming "everything
  // is spent" after the windows rolled — read it against the clock.
  const exhausted = isExhaustionCurrent(state?.exhausted_at, [...profiles, ...codexProfiles], now);

  const handleSwitch = async (profile: string) => {
    setSwitching(profile);
    try {
      // Pure swap, same as the settings page: running sessions are untouched;
      // new/resumed ones adopt the account. The query refresh flips which card
      // shows "active" once the daemon confirms.
      await requestSwitch({ profile, device_id: device.device_id, continue_blocked: false });
      toast.success(`Switching to "${profile}" — new and resumed sessions will use it`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Switch failed");
    } finally {
      setSwitching(null);
    }
  };

  // One email group card, shared by both panel sections; the active section
  // gets the green treatment.
  const renderGroup = (g: { email: string; entries: AccountEntry[] }, activeGroup: boolean) => (
    <div
      key={g.email}
      className={`rounded-md border p-2 ${
        activeGroup ? "border-sol-green/30 bg-sol-green/[0.05]" : "border-sol-border/50"
      }`}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${activeGroup ? "bg-sol-green" : "bg-sol-border"}`}
        />
        <span className="min-w-0 truncate text-[11px] font-medium text-sol-text">{g.email}</span>
      </div>
      <div className="space-y-1.5">
        {g.entries.map((e, i) => (
          <div
            key={`${e.provider}:${e.p.name}`}
            className={i > 0 ? "border-t border-sol-border/40 pt-1.5" : undefined}
          >
            <div className="mb-1 flex items-center gap-1.5">
              <KeyRound
                className={`h-3 w-3 shrink-0 ${e.isActive ? "text-sol-cyan" : "text-sol-text-dim"}`}
              />
              {e.provider === "claude" ? (
                <span title="Claude" className="shrink-0 text-sol-orange">
                  <ClaudeIcon className="h-3 w-3" />
                </span>
              ) : (
                <span title="Codex" className="shrink-0 text-emerald-400">
                  <OpenAIIcon className="h-3 w-3" />
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-[10px] text-sol-text-dim">
                {e.p.name}
                {(e.p.subscription ?? e.p.tier) ? ` · ${e.p.subscription ?? e.p.tier}` : ""}
              </span>
              {e.isActive ? (
                <span className="shrink-0 text-[10px] font-medium text-sol-green">active</span>
              ) : e.provider === "claude" ? (
                // Codex rows are display-only for now — switching the
                // machine's Codex account is the follow-up (auth.json swap).
                <button
                  type="button"
                  disabled={switching !== null}
                  onClick={() => handleSwitch(e.p.name)}
                  title={`Switch this machine to "${e.p.name}"`}
                  className="shrink-0 text-[10px] font-medium text-sol-cyan/70 hover:text-sol-cyan hover:underline disabled:opacity-50"
                >
                  {switching === e.p.name ? "switching…" : "switch →"}
                </button>
              ) : null}
            </div>
            <AccountUsageBars usage={e.p.usage} now={now} />
          </div>
        ))}
      </div>
    </div>
  );

  // The wrapper anchors the hover panel; leaving the whole area (chip +
  // panel) closes it. The panel offset is padding, not margin, so the gap
  // between chip and panel stays inside the hover area.
  return (
    <div className="relative hidden md:block" onMouseEnter={openNow} onMouseLeave={closeSoon}>
      <button
        className="flex items-center gap-2 rounded-full px-2 py-0.5 select-none transition-all duration-300 cursor-default"
        style={{
          background: `color-mix(in srgb, ${tone} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${tone} 25%, transparent)`,
        }}
      >
        {shown === "claude" ? (
          <ProviderSegment
            icon={<ClaudeIcon className="h-3 w-3 shrink-0 text-sol-orange" />}
            label={active?.name ?? "claude"}
            percent={worst}
            tone={claudeTone}
            stub={false}
            title={
              !claudeUsed
                ? `Claude "${active?.name}" — no usage this week`
                : `Claude "${active?.name}" — worst limit window at ${worst != null ? Math.round(worst) : "?"}%`
            }
          />
        ) : (
          <ProviderSegment
            icon={<OpenAIIcon className="h-3 w-3 shrink-0 text-emerald-400" />}
            label={codexLabel}
            percent={codexWorst}
            tone={codexTone}
            stub={false}
            title={
              !codexUsed
                ? `Codex "${codexLabel}" — no usage this week`
                : `Codex "${codexLabel}" — worst limit window at ${codexWorst != null ? Math.round(codexWorst) : "?"}%`
            }
          />
        )}
        {autoOn ? (
          <Zap
            className="h-3 w-3"
            style={{ color: exhausted ? "var(--sol-red)" : "var(--sol-cyan)" }}
            aria-label="Auto-switch enabled"
          />
        ) : (
          active && (
            <ZapOff
              className="h-3 w-3 text-sol-text-dim opacity-60"
              aria-label="Auto-switch off — open to re-enable"
            />
          )
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 pt-1.5">
          <div className="w-[320px] rounded-md border bg-popover text-popover-foreground shadow-md">
        <div className="border-b border-sol-border/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sol-text">
            <KeyRound className="h-3.5 w-3.5 text-sol-cyan" />
            Model usage
            <span className="ml-auto font-normal text-[10px] text-sol-text-dim">{device.label}</span>
          </div>
        </div>

        <div className="max-h-[360px] space-y-2 overflow-y-auto px-3 py-2">
          <div className="px-0.5 text-[9px] font-semibold uppercase tracking-wider text-sol-green">
            Active
          </div>
          {activeGroups.map((g) => renderGroup(g, true))}
          {otherGroups.length > 0 && (
            <>
              <div className="px-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim">
                Available
              </div>
              {otherGroups.map((g) => renderGroup(g, false))}
            </>
          )}
          {profiles.length === 0 && (
            <div className="rounded-md border border-dashed border-sol-border/60 p-2">
              <div className="flex items-center gap-2 text-xs text-sol-text-dim">
                <KeyRound className="h-3 w-3 opacity-50" />
                No Claude account connected on this machine — run <span className="font-mono">/login</span> in
                Claude Code and it appears here.
              </div>
            </div>
          )}
          {codexProfiles.length === 0 && (
            <div className="rounded-md border border-dashed border-sol-border/60 p-2">
              <div className="flex items-center gap-2 text-xs text-sol-text-dim">
                <KeyRound className="h-3 w-3 opacity-50" />
                Codex not detected on this machine — sign in with the Codex CLI and its usage appears here.
              </div>
            </div>
          )}
        </div>

        <div className="border-t border-sol-border/60 px-3 py-2.5">
          {/* Device-level flag — shown even when the current login isn't a
              saved profile, so the off state is always recoverable from here. */}
          <div className="flex items-center gap-2">
            <Zap className={`h-3.5 w-3.5 ${autoOn ? "text-sol-cyan" : "text-sol-text-dim"}`} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-sol-text">Auto-switch accounts</div>
              <div className="text-[10px] leading-snug text-sol-text-dim">
                When sessions park on a usage limit or an expired login, hop to the freshest
                account and continue them until everything is unblocked or every account is spent.
              </div>
            </div>
            <Switch
              checked={autoOn}
              onCheckedChange={recovery.autoSwitch.set}
              disabled={recovery.autoSwitch.pending}
            />
          </div>
          <div className="mt-2 flex items-center gap-2">
            <TimerReset
              className={`h-3.5 w-3.5 ${recovery.autoContinue.on ? "text-sol-cyan" : "text-sol-text-dim"}`}
            />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-sol-text">Resume at window reset</div>
              <div className="text-[10px] leading-snug text-sol-text-dim">
                Sessions parked on this account&apos;s limit continue on their own once the window
                resets — no account change.
              </div>
            </div>
            <Switch
              checked={recovery.autoContinue.on}
              onCheckedChange={recovery.autoContinue.set}
              disabled={recovery.autoContinue.pending}
            />
          </div>
          {autoOn && exhausted && (
            <div className="mt-1.5 rounded bg-sol-red/10 px-2 py-1 text-[10px] text-sol-red">
              {exhaustionBannerCopy([...profiles, ...codexProfiles], now)}
            </div>
          )}
          {(autoOn || recovery.autoContinue.on) &&
            !exhausted &&
            state?.last_action &&
            state.last_action_at && (
              <div className="mt-1.5 text-[10px] text-sol-text-dim">
                Last action: {state.last_action.replace("switch:", "switched to ")}{" "}
                {formatAgo(now - state.last_action_at)}
              </div>
            )}
          <button
            onClick={() => {
              setOpen(false);
              router.push("/settings/claude-accounts");
            }}
            className="mt-2 text-[11px] text-sol-cyan hover:underline"
          >
            Manage accounts →
          </button>
        </div>
          </div>
        </div>
      )}
    </div>
  );
}
