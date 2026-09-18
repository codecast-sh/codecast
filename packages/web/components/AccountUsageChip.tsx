"use client";

// Header chip: live model usage for ONE provider — the one backing the
// session you're viewing (sticky to the last shown when the selection is
// neither Claude nor Codex). A status dot carries its most-utilized limit
// window — green with headroom, orange near the limit, red once sessions on
// it are blocked. Last-known accounts stay in the bar while the daemon is
// quiet or offline so a session-limit surprise (or a missing switcher) never
// is one; switching itself stays blocked until the machine is back.
// Hovering the chip opens the full panel with the real meters: the ACTIVE
// accounts broken out on top (what's "on" right now), the rest grouped by
// email below, the auto-switch toggle, and the path to Settings.

import { useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api } from "@codecast/convex/convex/_generated/api";
import { KeyRound, Zap, ZapOff } from "lucide-react";
import { ClaudeIcon, OpenAIIcon } from "./BrandIcons";
import { Switch } from "./ui/switch";
import { useCoarseNow } from "../hooks/useCoarseNow";
import { useQueryNoThrow } from "../hooks/useQueryNoThrow";
import { useAccountRecoveryToggles } from "../hooks/useAccountRecoveryToggles";
import { RecoveryModeSelect, RecoveryDecisionNote } from "./RecoveryModeSelect";
import { useMachineAccountSwitch } from "../hooks/useMachineAccountSwitch";
import { useTrackedStore } from "../store/inboxStore";
import { exhaustionBannerCopy, isExhaustionCurrent, worstUsagePercent, type CcUsage } from "@codecast/convex/convex/ccAccountsShared";
import { formatAgo, headroomScore } from "@codecast/shared/contracts";
import { resolveAccountChip } from "../lib/accountUsageChip";
import { machineSwitchBlock, machineSwitchPendingCopy } from "../lib/machineAccountSwitch";
import { usageTone } from "../lib/usageTone";
import { AccountUsageBars, LoginExpiredBadge, ProfileSignInButton, UsageRefreshButton } from "./AccountUsageMeter";
import { MintTokenButton, SetupTokenBadge } from "./MintTokenDialog";
import { StatusDot } from "./StatusDot";

type ProfileRow = {
  name: string;
  email?: string;
  tier?: string;
  subscription?: string;
  usage?: CcUsage;
  login_expired_at?: number;
  setup_token?: { stored_at: number; expires_at: number };
};

function ClaudeSwitchControl({
  profile,
  email,
  loginExpired,
  online,
  isRemote,
  onSwitch,
}: {
  profile: string;
  email?: string;
  loginExpired: boolean;
  online?: boolean;
  isRemote?: boolean;
  onSwitch: (profile: string, email?: string) => void;
}) {
  const blocked = machineSwitchBlock({
    isActive: false,
    online,
    isRemote,
    loginExpired,
    thisProfile: profile,
  });
  if (blocked?.block === "login_expired") {
    return (
      <span className="shrink-0 text-[10px] text-sol-text-dim" title={blocked.label}>
        sign in to switch
      </span>
    );
  }
  if (blocked) {
    return (
      <span className="shrink-0 cursor-default text-[10px] text-sol-text-dim" title={blocked.label}>
        switch →
      </span>
    );
  }
  return (
    <button
      type="button"
      onPointerDown={(ev) => ev.stopPropagation()}
      onClick={() => onSwitch(profile, email)}
      title={`Switch this machine to "${profile}". Running sessions keep the account they started on.`}
      className="shrink-0 text-[10px] font-medium text-sol-cyan/70 hover:text-sol-cyan hover:underline"
    >
      switch →
    </button>
  );
}

// The chip's visible slice: status dot + provider icon + account name — the
// same dot-led shape as the daemon and agents chips beside it, and a fixed
// layout that never reflows on hover (the percentages live in the hover
// panel). The dot pings while the window is pegged: that is the state that
// parks sessions, and the one the reader must not miss.
function ProviderSegment({
  icon,
  label,
  percent,
  tone,
  title,
}: {
  icon: ReactNode;
  label: string;
  percent: number | null;
  tone: string;
  title: string;
}) {
  return (
    <span className="flex items-center gap-1.5" aria-label={title}>
      <StatusDot color={tone} ping={percent != null && percent >= 100} />
      {icon}
      <span className="tb-squeeze-1 max-w-[88px] truncate font-mono text-[11px] font-bold" style={{ color: tone }}>
        {label}
      </span>
    </span>
  );
}

export function AccountUsageChip() {
  // No-throw: the chip lives in always-mounted chrome, so a backend that can't
  // serve this must cost the chip, not the surface hosting it. Undefined reads
  // as "no accounts yet", which the render below already handles.
  const { data } = useQueryNoThrow(api.accountSwitch.listAccountProfiles, {});
  const router = useRouter();
  const now = useCoarseNow(30_000);
  // Hovering the chip expands the full usage panel DOWN from it. The panel is
  // a child of the same wrapper, so it stays open while the mouse is over it.
  // Closing goes through a short grace timer: a diagonal pointer path can
  // briefly exit the wrapper on its way into the panel, and an instant close
  // makes that read as a dropped hover.
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInside = useRef(false);
  const openNow = () => {
    pointerInside.current = true;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setOpen(true);
  };
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

  // Last-known primary, even when the daemon is quiet or offline. The query
  // also carries remotes and a 7-day offline primary (for Settings); remotes
  // never win, and going quiet must not hide the switcher. Switch itself stays
  // blocked while the machine is offline.
  const resolved = resolveAccountChip({
    devices: data?.devices,
    currentAgentType,
    lastShown: lastShownProvider.current,
  });
  const device = resolved?.device;
  // Hooks run unconditionally; the placeholder device is never flipped because
  // the panel (and its switches) only render once a real device exists.
  const recovery = useAccountRecoveryToggles(
    device ?? { device_id: "", auto_switch: false, auto_continue: undefined },
  );
  const sw = useMachineAccountSwitch({
    deviceId: device?.device_id,
    activeEmail: device?.active_email,
  });
  const closeSoon = () => {
    pointerInside.current = false;
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => {
      if (pointerInside.current) return;
      setOpen(false);
      sw.clearOutcome();
    }, 160);
  };
  const profiles: ProfileRow[] = device?.profiles ?? [];
  const active = resolved?.active;
  const codexProfiles: ProfileRow[] = device?.codex_accounts?.profiles ?? [];
  const activeCodex = resolved?.activeCodex;
  if (!resolved || !device) return null;

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
  const shown = resolved.shown;
  lastShownProvider.current = shown;
  // The chip border speaks for the shown provider.
  const tone = shown === "codex" ? codexTone : claudeTone;
  const shownClaudeName =
    sw.outcome?.kind === "success" ? sw.outcome.profile : active?.name;
  // Panel list: the ACTIVE accounts (the Claude and Codex login actually in
  // use) break out into their own section on top — that's the "what is on"
  // answer. Everything else groups by email below: the same login usually
  // exists on both providers, so one email header covers its Claude and
  // Codex rows.
  type AccountEntry = { provider: "claude" | "codex"; p: ProfileRow; isActive: boolean };
  const allEntries: AccountEntry[] = [
    ...profiles.map((p) => ({
      provider: "claude" as const,
      p,
      isActive: p === active,
    })),
    ...codexProfiles.map((p) => ({ provider: "codex" as const, p, isActive: p === activeCodex })),
  ];
  // Most room left first, inside a group and between groups: the top of the
  // "Available" list is then the account a switch would land on. A group's
  // rank is its roomiest account, since that is what switching to that email
  // buys. Rolled-window accounts score behind every measured one (headroomScore).
  const buildGroups = (entries: AccountEntry[]) => {
    const byEmail = new Map<string, AccountEntry[]>();
    for (const e of entries) {
      const key = e.p.email ?? e.p.name;
      byEmail.set(key, [...(byEmail.get(key) ?? []), e]);
    }
    const rank = (e: AccountEntry) => headroomScore(e.p.usage, now);
    return [...byEmail.entries()]
      .map(([email, list]) => {
        const sorted = [...list].sort((a, b) => rank(a) - rank(b));
        return { email, entries: sorted, score: rank(sorted[0]) };
      })
      .sort((a, b) => a.score - b.score);
  };
  const activeGroups = buildGroups(allEntries.filter((e) => e.isActive));
  const otherGroups = buildGroups(allEntries.filter((e) => !e.isActive));
  // The chip's bolt says whether this machine recovers on its own. Ask-first
  // counts: it acts, it just stops for approval first — and a proposal waiting
  // on the human is exactly what the chip should surface.
  const mode = recovery.recovery.mode;
  const autoOn = mode === "auto" || mode === "ask";
  const state = device.auto_switch_state;
  const awaitingApproval = state?.last_decision?.kind === "propose";
  // Only a re-check clears the stamp, so an old one keeps claiming "everything
  // is spent" after the windows rolled — read it against the clock.
  const exhausted = isExhaustionCurrent(state?.exhausted_at, [...profiles, ...codexProfiles], now);
  const handleSwitch = (profile: string, email?: string) => {
    setOpen(true);
    void sw.switchTo(profile, email);
  };
  const panelOpen = open;

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
              {e.provider === "claude" && sw.switching === e.p.name ? (
                <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-sol-cyan">
                  <span className="h-2 w-2 animate-spin rounded-full border-2 border-sol-cyan/30 border-t-sol-cyan" aria-hidden />
                  switching…
                </span>
              ) : e.isActive ? (
                <span className="shrink-0 text-[10px] font-medium text-sol-green">active</span>
              ) : e.provider === "claude" ? (
                // Codex rows are display-only for now — switching the
                // machine's Codex account is the follow-up (auth.json swap).
                <ClaudeSwitchControl
                  profile={e.p.name}
                  email={e.p.email}
                  loginExpired={!!e.p.login_expired_at}
                  online={device.online}
                  isRemote={device.is_remote}
                  onSwitch={handleSwitch}
                />
              ) : null}
            </div>
            {/* Status chips get their own wrapping line: the panel is too narrow to
                hold them beside the name, and each chip renders null when it has
                nothing to say, so the line collapses when all are absent. */}
            <div className="mb-1 flex flex-wrap items-center gap-1 empty:hidden">
              <LoginExpiredBadge profile={e.p} />
              {e.provider === "claude" && device && (
                <ProfileSignInButton
                  device={device}
                  profile={e.p}
                  force={
                    sw.outcome?.kind === "error" &&
                    sw.outcome.profile === e.p.name &&
                    /sign in again/i.test(sw.outcome.message)
                  }
                />
              )}
              {e.provider === "claude" && <SetupTokenBadge profile={e.p} now={now} />}
              {e.provider === "claude" && device && <MintTokenButton device={device} profile={e.p} />}
            </div>
            <AccountUsageBars usage={e.p.usage} now={now} />
          </div>
        ))}
      </div>
    </div>
  );

  // The wrapper anchors the hover panel; leaving the whole area (chip +
  // panel) closes it. The panel offset is padding, not margin, so the gap
  // between chip and panel stays inside the hover area. data-flyout opts the
  // panel out of the titlebar drag region — without it, Electron eats the
  // pointer on the way in and the panel closes on hover (globals.css).
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
            label={shownClaudeName ?? resolved.claudeLabel}
            percent={worst}
            tone={claudeTone}
            title={
              sw.switching
                ? machineSwitchPendingCopy(sw.phase, sw.switching, device.label)
                : !claudeUsed
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
            title={
              !codexUsed
                ? `Codex "${codexLabel}" — no usage this week`
                : `Codex "${codexLabel}" — worst limit window at ${codexWorst != null ? Math.round(codexWorst) : "?"}%`
            }
          />
        )}
        {sw.switching ? (
          <span
            className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current/30 border-t-current"
            style={{ color: tone }}
            aria-label={machineSwitchPendingCopy(sw.phase, sw.switching, device.label)}
          />
        ) : autoOn ? (
          <Zap
            className="h-3 w-3"
            style={{
              color: exhausted
                ? "var(--sol-red)"
                : awaitingApproval
                  ? "var(--sol-yellow)"
                  : "var(--sol-cyan)",
            }}
            aria-label={
              awaitingApproval
                ? "An account switch is waiting for your approval"
                : mode === "auto"
                  ? "Switches accounts automatically on a usage limit"
                  : "Asks before switching accounts on a usage limit"
            }
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
      {panelOpen && (
        <div data-flyout className="absolute right-0 top-full z-50 pt-1.5">
          <div className="w-[320px] rounded-md border bg-popover text-popover-foreground shadow-md">
        <div className="border-b border-sol-border/60 px-3 py-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sol-text">
            <KeyRound className="h-3.5 w-3.5 text-sol-cyan" />
            Model usage
            <span className="ml-auto font-normal text-[10px] text-sol-text-dim">{device.label}</span>
            <UsageRefreshButton device={device} />
          </div>
        </div>

        {(sw.switching || sw.outcome) && (
          <div
            className={`border-b px-3 py-2 text-[10px] leading-snug ${
              sw.outcome?.kind === "error"
                ? "border-sol-red/30 bg-sol-red/10 text-sol-red"
                : sw.outcome?.kind === "success"
                  ? "border-sol-green/30 bg-sol-green/10 text-sol-green"
                  : "border-sol-cyan/30 bg-sol-cyan/10 text-sol-cyan"
            }`}
          >
            {sw.switching ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 animate-spin rounded-full border-2 border-current/30 border-t-current" aria-hidden />
                <span className="min-w-0 flex-1">
                  {machineSwitchPendingCopy(sw.phase, sw.switching, device.label)}
                </span>
                <button
                  type="button"
                  onPointerDown={(ev) => ev.stopPropagation()}
                  onClick={sw.cancel}
                  className="shrink-0 font-medium text-current/80 underline-offset-2 hover:underline"
                >
                  cancel
                </button>
              </span>
            ) : sw.outcome?.kind === "error" ? (
              sw.outcome.message
            ) : (
              <>
                Now using {sw.outcome?.profile}. Running sessions keep the account they started on.
              </>
            )}
          </div>
        )}

        <div className="max-h-[min(60rem,calc(100dvh-13rem))] space-y-2 overflow-y-auto px-3 py-2">
          {activeGroups.length > 0 && (
            <>
              <div className="px-0.5 text-[9px] font-semibold uppercase tracking-wider text-sol-green">
                Active
              </div>
              {activeGroups.map((g) => renderGroup(g, true))}
            </>
          )}
          {otherGroups.length > 0 && (
            <>
              <div className="px-0.5 pt-1 text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim">
                Available
              </div>
              <p className="px-0.5 text-[10px] leading-snug text-sol-text-dim">
                Switch changes the default login on this machine. Sessions already running keep the
                account they started on.
              </p>
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
          {/* Device-level mode — shown even when the current login isn't a
              saved profile, so it is always reachable from here. */}
          <div className="flex items-center gap-2 px-2">
            <Zap className={`h-3.5 w-3.5 ${recovery.recovery.mode === "off" ? "text-sol-text-dim" : "text-sol-cyan"}`} />
            <div className="text-xs font-medium text-sol-text">On a usage limit</div>
          </div>
          <div className="mt-1">
            <RecoveryModeSelect control={recovery.recovery} compact />
          </div>
          {recovery.recovery.mode === "auto" && exhausted && (
            <div className="mt-1.5 rounded bg-sol-red/10 px-2 py-1 text-[10px] text-sol-red">
              {exhaustionBannerCopy([...profiles, ...codexProfiles], now)}
            </div>
          )}
          {!exhausted && state?.last_decision && (
            <RecoveryDecisionNote decision={state.last_decision} now={now} className="mt-1.5 px-2" />
          )}
          {!exhausted && !state?.last_decision && state?.last_action && state.last_action_at && (
            <div className="mt-1.5 px-2 text-[10px] text-sol-text-dim">
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
