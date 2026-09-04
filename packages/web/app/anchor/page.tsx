"use client";

// The Anchor's home: one place per anchor for its conversation, its routines,
// its Slack connection and its settings. A person may have several anchors —
// a personal one and one per team — so the header is a scope switcher and the
// identity line always says which one is on screen. The quick way to talk to
// an anchor from anywhere is the global slide-over (⌘⇧A); this page is where
// you shape it.

import { useAction, useMutation } from "convex/react";
import { useAnchorSpace } from "../../hooks/useSyncAnchorSpace";
import { deriveAnchorStatus, useAnchors } from "../../hooks/useSyncAnchors";
import { api } from "@codecast/convex/convex/_generated/api";
import { useMemo, useState } from "react";
import { Repeat, Settings2 } from "lucide-react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { TeamIcon } from "../../components/TeamIcon";
import { useInboxStore } from "../../store/inboxStore";
import { useTriggers } from "../../hooks/useSyncTriggers";
import { armedInjectTasksFor, taskDisplayTitle } from "../../components/triggerTasks";
import { describeTaskCadence, taskStateLabel } from "../../components/triggerCadence";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { AnchorAvatar, AnchorGlyph, AnchorScopePill } from "../../components/anchor/AnchorIdentity";
import { AnchorConversation, AnchorOnboarding, CenteredNote } from "../../components/anchor/AnchorConversation";
import { useTitlebarHead } from "../../hooks/useTitlebarHead";

import { useMountEffect } from "../../hooks/useMountEffect";
import { useWatchEffect } from "../../hooks/useWatchEffect";
type ScopeType = "user" | "team";
type Scope = { type: ScopeType; teamId: string | null };

export default function AnchorPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <AnchorSpace />
      </DashboardLayout>
    </AuthGuard>
  );
}

function AnchorSpace() {
  const teams: any[] = useInboxStore((s) => s.teams) ?? [];
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id as string | undefined) ?? null;
  const [scope, setScope] = useState<Scope>({ type: "user", teamId: null });
  // Store-fed (hooks/useSyncAnchorSpace): paints from the cached row for this
  // scope; "Loading your anchor" shows only for a genuinely cold cache.
  const { space } = useAnchorSpace(scope.type, scope.teamId);
  const anchors = useAnchors();

  // When Slack redirects back to this (authenticated) page with ?code&?state,
  // complete the install here — binding it to the logged-in user's own anchor.
  const completeInstall = useAction(api.slack.completeSlackInstall);
  const [slackFlash, setSlackFlash] = useState<null | "connected" | "error">(null);
  useMountEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const cleanUrl = () => {
      const u = new URL(window.location.href);
      ["code", "state", "scope", "team", "slack", "reason", "error"].forEach((k) => u.searchParams.delete(k));
      window.history.replaceState({}, "", u.pathname + u.search);
    };
    const wantsTeam = p.get("scope") === "team";
    const teamParam = p.get("team");
    if (wantsTeam) setScope({ type: "team", teamId: teamParam ?? activeTeamId });
    const code = p.get("code");
    const st = p.get("state");
    if (code && st) {
      completeInstall({ code, state: st } as any)
        .then((res: any) => {
          if (res?.scope_type === "team") setScope({ type: "team", teamId: res?.team_id ?? activeTeamId });
          setSlackFlash(res?.ok ? "connected" : "error");
        })
        .catch(() => setSlackFlash("error"))
        .finally(() => {
          cleanUrl();
          setTimeout(() => setSlackFlash(null), 6000);
        });
      return;
    }
    const s = p.get("slack");
    if (s === "connected" || s === "error") {
      setSlackFlash(s);
      cleanUrl();
      const t = setTimeout(() => setSlackFlash(null), 6000);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // A team scope with no team named yet resolves to the active team once the
  // pointer lands (a deep link that only said scope=team).
  useWatchEffect(() => {
    if (scope.type === "team" && !scope.teamId && activeTeamId) setScope({ type: "team", teamId: activeTeamId });
  }, [scope, activeTeamId]);

  const teamName = scope.type === "team"
    ? (teams.find((t) => t?._id === scope.teamId)?.name ?? space?.anchor?.team_name ?? null)
    : null;

  return (
    <div className="h-full flex flex-col bg-sol-bg text-sol-text">
      <header className="flex items-center gap-3 px-6 py-3 border-b border-sol-border/60 shrink-0">
        <div className="flex items-center gap-2 text-sol-text-muted">
          <AnchorGlyph className="w-5 h-5 text-sol-cyan" />
          <span className="text-lg font-semibold tracking-tight text-sol-text">Anchor</span>
        </div>
        <nav className="ml-auto flex items-center gap-1 text-xs" aria-label="Which anchor">
          <ScopeTab
            active={scope.type === "user"}
            onClick={() => setScope({ type: "user", teamId: null })}
            has={anchors.some((a) => a.scope_type === "user")}
          >
            <span className="inline-flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-violet" />
              Personal
            </span>
          </ScopeTab>
          {teams.filter((t) => t?._id).map((t) => (
            <ScopeTab
              key={t._id}
              active={scope.type === "team" && scope.teamId === t._id}
              onClick={() => setScope({ type: "team", teamId: t._id })}
              has={anchors.some((a) => a.scope_type === "team" && a.team_id === t._id)}
            >
              <span className="inline-flex items-center gap-1.5">
                <TeamIcon icon={t.icon} color={t.color} className="w-3 h-3" />
                {t.name}
              </span>
            </ScopeTab>
          ))}
        </nav>
      </header>

      {slackFlash && (
        <div
          className={`px-6 py-2 text-sm shrink-0 ${
            slackFlash === "connected"
              ? "bg-sol-green/15 text-sol-green"
              : "bg-sol-red/15 text-sol-red"
          }`}
        >
          {slackFlash === "connected"
            ? "Slack connected — invite the bot to a channel, then link it below."
            : "Slack connection failed. Please try again."}
        </div>
      )}

      <div className="flex-1 min-h-0">
        {space === undefined ? (
          <CenteredNote>Loading your anchor…</CenteredNote>
        ) : space?.forbidden ? (
          <CenteredNote>You're not a member of that team.</CenteredNote>
        ) : space?.no_team ? (
          <CenteredNote>Create or join a team to give it a shared Anchor.</CenteredNote>
        ) : !space?.anchor ? (
          <AnchorOnboarding scope={scope.type} teamId={scope.teamId} teamName={teamName} />
        ) : (
          <AnchorHome key={String(space.anchor._id)} space={space} teamName={teamName} />
        )}
      </div>
    </div>
  );
}

function ScopeTab({ active, has, onClick, children }: { active: boolean; has: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      title={has ? undefined : "No anchor here yet"}
      className={`px-3 py-1 rounded-md transition-colors ${
        active ? "bg-sol-bg-highlight text-sol-text" : has ? "text-sol-text-dim hover:text-sol-text" : "text-sol-text-dim/50 hover:text-sol-text-muted"
      }`}
    >
      {children}
    </button>
  );
}

// ── Anchor home (anchor exists) ─────────────────────────────────────────────

function AnchorHome({ space, teamName }: { space: any; teamName: string | null }) {
  const a = space.anchor;
  const convId = a.conversation_id as string | null;
  const now = useCoarseNow(30_000);
  const titlebarRef = useTitlebarHead<HTMLDivElement>();
  const identity = useMemo(() => ({
    bot_name: a.bot_name, bot_avatar: a.bot_avatar,
    scope_type: space.scope_type as ScopeType, team_name: teamName,
  }), [a.bot_name, a.bot_avatar, space.scope_type, teamName]);
  const status = useMemo(() => deriveAnchorStatus({
    status: a.status, conv_status: a.conv_status, has_pending_messages: a.has_pending_messages,
    conv_updated_at: a.updated_at, agent_status: a.agent_status, awaiting_input: a.awaiting_input,
  }, now), [a, now]);
  const proj = a.project_path ? String(a.project_path).replace(/^.*\//, "") : null;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={titlebarRef} className="flex items-center gap-3 px-5 py-3 border-b border-sol-border/60 shrink-0">
        <AnchorAvatar anchor={identity} size={36} />
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="font-semibold truncate">{a.bot_name}</span>
            <AnchorScopePill anchor={identity} />
          </div>
          <div className="text-xs flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
            <span className={status.text}>{status.label}</span>
            {proj && <span className="text-sol-text-dim">· {proj}</span>}
            <span className="text-sol-text-dim">
              · {space.scope_type === "team"
                ? `shared with everyone in ${teamName ?? "the team"}`
                : "private to you"}
            </span>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {convId && <RoutinesPopover conversationId={convId} anchorName={a.bot_name} />}
          <SlackPopover space={space} />
          <SettingsPopover anchor={a} />
        </div>
      </div>
      <div className="flex-1 min-h-0">
        {convId ? <AnchorConversation conversationId={convId} /> : <CenteredNote>Coming online…</CenteredNote>}
      </div>
    </div>
  );
}

// ── Routines popover ────────────────────────────────────────────────────────
// What the anchor does on its own clock: the armed triggers bound to its
// session. Read-only here on purpose — the way to change a routine is to tell
// the anchor ("stop the weekly digest", "do that at 9 instead"); it owns them.

function RoutinesPopover({ conversationId, anchorName }: { conversationId: string; anchorName: string }) {
  const { tasks } = useTriggers();
  const now = useCoarseNow(30_000);
  const routines = useMemo(() => armedInjectTasksFor(tasks as any[], conversationId), [tasks, conversationId]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title="Routines — what it does on a schedule"
          className="flex items-center gap-1.5 text-xs border border-sol-border rounded-md px-2.5 py-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors"
        >
          <Repeat className="w-3.5 h-3.5" />
          <span>Routines</span>
          {routines.length > 0 && (
            <span className="min-w-[16px] h-4 px-1 rounded-full bg-sol-cyan/15 text-sol-cyan text-[10px] font-semibold flex items-center justify-center">
              {routines.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 bg-sol-bg border-sol-border p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim mb-1">Routines</h2>
        <p className="text-[11px] text-sol-text-dim leading-relaxed mb-3">
          Recurring behavior {anchorName} runs on its own. To add, change or stop one, just tell it in
          the conversation — it manages its own schedule.
        </p>
        {routines.length === 0 ? (
          <p className="text-xs text-sol-text-muted">
            None yet. Try: <span className="italic">"every weekday at 9, summarize what changed overnight and DM me."</span>
          </p>
        ) : (
          <ul className="space-y-1.5">
            {routines.map((t: any) => (
              <li key={t._id} className="flex items-start gap-2 text-xs">
                <span className={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${t.status === "paused" ? "bg-sol-text-dim" : "bg-sol-cyan"}`} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sol-text">{taskDisplayTitle(t)}</div>
                  <div className="text-sol-text-dim">
                    {describeTaskCadence(t)} · {taskStateLabel(t, now)}
                    {t.short_id && <span className="font-mono"> · {t.short_id}</span>}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ── Slack popover ───────────────────────────────────────────────────────────

function SlackPopover({ space }: { space: any }) {
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const unlink = useMutation(api.slack.unlinkChannel);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connected = !!space.slack?.connected;
  const channels: any[] = space.channels ?? [];

  const connect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const res = await getInstallUrl({ scope_type: space.scope_type, team_id: space.anchor?.team_id ?? undefined } as any);
      if (res?.ok && res.url) {
        window.location.href = res.url;
      } else {
        setErr(res?.error ?? "Couldn't start the Slack connection");
        setBusy(false);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't reach Slack");
      setBusy(false);
    }
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title={connected ? `Slack connected${space.slack?.workspace_name ? ` · ${space.slack.workspace_name}` : ""}` : "Connect Slack"}
          className="flex items-center gap-1.5 text-xs border border-sol-border rounded-md px-2.5 py-1.5 text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors"
        >
          <SlackLogo className="w-3.5 h-3.5" muted={!connected} />
          <span>Slack</span>
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-sol-green" : "bg-sol-text-dim/40"}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 bg-sol-bg border-sol-border p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim mb-3">Slack</h2>
        {connected ? (
          <>
            <div className="flex items-center gap-2 text-xs text-sol-green mb-3">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green" />
              Connected{space.slack?.workspace_name ? ` · ${space.slack.workspace_name}` : ""}
            </div>
            {channels.length === 0 ? (
              <p className="text-xs text-sol-text-dim leading-relaxed">
                Invite the bot to a channel in Slack, then <code>cast anchor link-channel &lt;id&gt;</code>.
                @mentions there wake this anchor.
              </p>
            ) : (
              <ul className="space-y-1">
                {channels.map((c) => (
                  <li key={c.channel_key} className="flex items-center justify-between text-xs">
                    <span className="font-mono text-sol-text-muted truncate">{c.channel_key}</span>
                    <button
                      onClick={() => unlink({ channel: c.channel_key } as any)}
                      className="text-sol-text-dim hover:text-sol-red"
                    >
                      unlink
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <button onClick={connect} className="mt-3 text-xs text-sol-text-dim hover:text-sol-text">
              Reconnect
            </button>
          </>
        ) : (
          <>
            <p className="text-xs text-sol-text-muted mb-3 leading-relaxed">
              Let this anchor answer @mentions in your Slack. One click — no manual tokens.
            </p>
            <button
              onClick={connect}
              disabled={busy}
              style={{ backgroundColor: "#4A154B" }}
              className="w-full text-white text-sm font-medium rounded-lg px-4 py-2 flex items-center justify-center gap-2 disabled:opacity-60"
            >
              <SlackLogo className="w-4 h-4" />
              {busy ? "Opening Slack…" : "Add to Slack"}
            </button>
          </>
        )}
        {err && <div className="text-sol-red text-xs mt-2">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}

function SlackLogo({ className, muted }: { className?: string; muted?: boolean }) {
  return (
    <svg className={className} viewBox="0 0 122.8 122.8" aria-hidden style={muted ? { filter: "grayscale(1)", opacity: 0.6 } : undefined}>
      <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9z" fill="#E01E5A" />
      <path d="M32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2z" fill="#36C5F0" />
      <path d="M45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z" fill="#36C5F0" />
      <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2z" fill="#2EB67D" />
      <path d="M90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z" fill="#2EB67D" />
      <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9z" fill="#ECB22E" />
      <path d="M77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z" fill="#ECB22E" />
    </svg>
  );
}

// ── Settings popover ────────────────────────────────────────────────────────

function SettingsPopover({ anchor }: { anchor: any }) {
  const update = useMutation(api.anchors.updateAnchor);
  const decommission = useMutation(api.anchors.decommissionAnchor);
  const rebrief = useMutation(api.anchors.rebriefAnchor);
  const [name, setName] = useState(anchor.bot_name ?? anchor.name ?? "Anchor");
  const [persona, setPersona] = useState(anchor.persona ?? "");
  const [saved, setSaved] = useState(false);
  const [briefed, setBriefed] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setErr(null);
    try {
      await update({ anchor_id: anchor._id, name, persona } as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setErr(e?.message ?? "Save failed");
    }
  };
  const retire = async () => {
    setErr(null);
    try {
      await decommission({ anchor_id: anchor._id } as any);
    } catch (e: any) {
      setErr(e?.message ?? "Retire failed");
    }
  };
  const brief = async () => {
    setErr(null);
    try {
      await rebrief({ anchor_id: anchor._id } as any);
      setBriefed(true);
      setTimeout(() => setBriefed(false), 2500);
    } catch (e: any) {
      setErr(e?.message ?? "Re-brief failed");
    }
  };

  return (
    <Popover onOpenChange={(o) => { if (!o) setConfirmRetire(false); }}>
      <PopoverTrigger asChild>
        <button
          title="Anchor settings"
          className="p-1.5 border border-sol-border rounded-md text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight/60 transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 bg-sol-bg border-sol-border p-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim mb-3">Settings</h2>
        <label className="block mb-3">
          <span className="text-xs text-sol-text-dim">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-sol-cyan"
          />
        </label>
        <label className="block mb-3">
          <span className="text-xs text-sol-text-dim">Persona</span>
          <textarea
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            rows={3}
            placeholder="Skill name or a short note on how it should behave"
            className="mt-1 w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-1.5 text-sm outline-none focus:border-sol-cyan resize-none"
          />
        </label>
        {anchor.project_path && (
          <div className="mb-3">
            <span className="text-xs text-sol-text-dim">Project</span>
            <div className="mt-1 text-xs font-mono text-sol-text-muted truncate" title={anchor.project_path}>
              {anchor.project_path}
            </div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={save}
            className="text-xs bg-sol-bg-highlight hover:bg-sol-bg-highlight/70 rounded-md px-3 py-1.5"
          >
            {saved ? "Saved" : "Save"}
          </button>
          <button
            onClick={brief}
            title="Send it the standing briefing again: who it is, how it reaches people, that it owns its routines"
            className="text-xs text-sol-text-dim hover:text-sol-text"
          >
            {briefed ? "Briefed" : "Re-brief"}
          </button>
          {!confirmRetire ? (
            <button
              onClick={() => setConfirmRetire(true)}
              className="ml-auto text-xs text-sol-text-dim hover:text-sol-red"
            >
              Retire
            </button>
          ) : (
            <button onClick={retire} className="ml-auto text-xs text-sol-red font-medium">
              Confirm retire
            </button>
          )}
        </div>
        {err && <div className="text-sol-red text-xs mt-2">{err}</div>}
      </PopoverContent>
    </Popover>
  );
}
