"use client";

import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useEffect, useMemo, useState } from "react";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { ConversationDiffLayout } from "../../components/ConversationDiffLayout";
import { ConversationData } from "../../components/ConversationView";
import { useConversationMessages } from "../../hooks/useConversationMessages";
import { useInboxStore } from "../../store/inboxStore";

type ScopeType = "user" | "team";

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
  const [scope, setScope] = useState<ScopeType>("user");
  const space = useQuery(api.anchors.getAnchorSpace, { scope_type: scope });

  // Surface the ?slack=connected / ?slack=error banner from the OAuth redirect.
  const [slackFlash, setSlackFlash] = useState<null | "connected" | "error">(null);
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const s = p.get("slack");
    if (s === "connected" || s === "error") {
      setSlackFlash(s);
      const url = new URL(window.location.href);
      url.searchParams.delete("slack");
      url.searchParams.delete("reason");
      window.history.replaceState({}, "", url.pathname + url.search);
      const t = setTimeout(() => setSlackFlash(null), 6000);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <div className="h-full flex flex-col bg-sol-bg text-sol-text">
      <header className="flex items-center gap-3 px-6 py-4 border-b border-sol-border/60 shrink-0">
        <div className="flex items-center gap-2 text-sol-text-muted">
          <svg className="w-5 h-5 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="5" r="2.5" strokeWidth={1.5} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5V21M5 12H3a9 9 0 0018 0h-2" />
          </svg>
          <span className="text-lg font-semibold tracking-tight text-sol-text">Anchor</span>
        </div>
        <div className="ml-auto flex items-center gap-1 text-xs">
          <ScopeTab active={scope === "user"} onClick={() => setScope("user")}>Personal</ScopeTab>
          <ScopeTab active={scope === "team"} onClick={() => setScope("team")}>Team</ScopeTab>
        </div>
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
        ) : !space?.anchor ? (
          <Onboarding scope={scope} />
        ) : (
          <AnchorHome key={String(space.anchor._id)} space={space} />
        )}
      </div>
    </div>
  );
}

function ScopeTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md transition-colors ${
        active ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
      }`}
    >
      {children}
    </button>
  );
}

function CenteredNote({ children }: { children: React.ReactNode }) {
  return <div className="h-full flex items-center justify-center text-sol-text-dim text-sm">{children}</div>;
}

// ── Onboarding (no anchor yet) ──────────────────────────────────────────────

function Onboarding({ scope }: { scope: ScopeType }) {
  const provision = useMutation(api.anchors.provisionAnchor);
  const [project, setProject] = useState("");
  const [name, setName] = useState("Anchor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await provision({
        scope_type: scope,
        name: name.trim() || "Anchor",
        project_path: project.trim() || undefined,
      } as any);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to create anchor");
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center px-6">
      <div className="max-w-md w-full text-center">
        <div className="mx-auto w-14 h-14 rounded-2xl bg-sol-cyan/15 flex items-center justify-center mb-5">
          <svg className="w-7 h-7 text-sol-cyan" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <circle cx="12" cy="5" r="2.5" strokeWidth={1.5} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 7.5V21M5 12H3a9 9 0 0018 0h-2" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold tracking-tight mb-2">
          Meet {scope === "team" ? "your team's Anchor" : "your Anchor"}
        </h1>
        <p className="text-sm text-sol-text-muted mb-6 leading-relaxed">
          A standing agent member that lives here, keeps your workspace's context, is woken by
          events, delegates code work to fresh sessions, and can answer in Slack — all under its
          own identity.
        </p>
        <div className="text-left space-y-3">
          <label className="block">
            <span className="text-xs text-sol-text-dim">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-2 text-sm outline-none focus:border-sol-cyan"
            />
          </label>
          <label className="block">
            <span className="text-xs text-sol-text-dim">Project it lives and works in</span>
            <input
              value={project}
              onChange={(e) => setProject(e.target.value)}
              placeholder="~/src/your-project"
              className="mt-1 w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-2 text-sm font-mono outline-none focus:border-sol-cyan"
            />
            <span className="text-[11px] text-sol-text-dim/70">
              The anchor runs on your machine at this path. Leave blank to let the daemon pick.
            </span>
          </label>
        </div>
        {err && <div className="text-sol-red text-xs mt-3">{err}</div>}
        <button
          onClick={create}
          disabled={busy}
          className="mt-5 w-full bg-sol-cyan text-sol-bg font-medium rounded-lg px-4 py-2.5 text-sm disabled:opacity-60 hover:bg-sol-cyan/90 transition-colors"
        >
          {busy ? "Bringing it online…" : `Create ${scope === "team" ? "team " : ""}Anchor`}
        </button>
      </div>
    </div>
  );
}

// ── Anchor home (anchor exists) ─────────────────────────────────────────────

function AnchorHome({ space }: { space: any }) {
  const a = space.anchor;
  const convId = a.conversation_id as string | null;

  // Seed ownership so the embedded conversation shows owner UI immediately.
  useEffect(() => {
    if (convId) {
      useInboxStore.getState().syncRecord("conversations", convId, { _id: convId, is_own: true });
    }
  }, [convId]);

  const status = useMemo(() => deriveStatus(a), [a]);

  return (
    <div className="h-full flex min-h-0">
      {/* Center: the anchor's live conversation */}
      <div className="flex-1 min-w-0 flex flex-col border-r border-sol-border/60">
        <div className="flex items-center gap-3 px-5 py-3 border-b border-sol-border/60 shrink-0">
          <Avatar name={a.bot_name} avatar={a.bot_avatar} />
          <div className="min-w-0">
            <div className="font-semibold truncate">{a.bot_name}</div>
            <StatusLine status={status} project={a.project_path} />
          </div>
        </div>
        <div className="flex-1 min-h-0">
          {convId ? <AnchorConversation conversationId={convId} /> : <CenteredNote>Coming online…</CenteredNote>}
        </div>
      </div>

      {/* Right rail: Slack + Settings */}
      <aside className="w-80 shrink-0 overflow-y-auto p-4 space-y-4 bg-sol-bg-alt/30">
        <SlackPanel space={space} />
        <SettingsPanel anchor={a} />
      </aside>
    </div>
  );
}

function AnchorConversation({ conversationId }: { conversationId: string }) {
  const {
    conversation,
    hasMoreAbove,
    hasMoreBelow,
    isLoadingOlder,
    isLoadingNewer,
    loadOlder,
    loadNewer,
    jumpToStart,
    jumpToEnd,
    jumpToTimestamp,
  } = useConversationMessages(conversationId);

  if (!conversation) return <CenteredNote>Loading conversation…</CenteredNote>;

  return (
    <div className="h-full">
      <ConversationDiffLayout
        conversation={conversation as ConversationData}
        embedded
        hasMoreAbove={hasMoreAbove}
        hasMoreBelow={hasMoreBelow}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onJumpToStart={jumpToStart}
        onJumpToEnd={jumpToEnd}
        onJumpToTimestamp={jumpToTimestamp}
        isOwner
        showMessageInput
      />
    </div>
  );
}

// ── Slack panel ─────────────────────────────────────────────────────────────

function SlackPanel({ space }: { space: any }) {
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const unlink = useMutation(api.slack.unlinkChannel);
  const [busy, setBusy] = useState(false);
  const connected = !!space.slack?.connected;
  const channels: any[] = space.channels ?? [];

  const connect = async () => {
    setBusy(true);
    try {
      const res = await getInstallUrl({ scope_type: space.scope_type } as any);
      if (res?.ok && res.url) window.location.href = res.url;
      else setBusy(false);
    } catch {
      setBusy(false);
    }
  };

  return (
    <Panel title="Slack">
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
            <svg width="16" height="16" viewBox="0 0 122.8 122.8" aria-hidden>
              <path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9z" fill="#E01E5A" />
              <path d="M32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z" fill="#E01E5A" />
              <path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2z" fill="#36C5F0" />
              <path d="M45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z" fill="#36C5F0" />
              <path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2z" fill="#2EB67D" />
              <path d="M90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z" fill="#2EB67D" />
              <path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9z" fill="#ECB22E" />
              <path d="M77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z" fill="#ECB22E" />
            </svg>
            {busy ? "Opening Slack…" : "Add to Slack"}
          </button>
        </>
      )}
    </Panel>
  );
}

// ── Settings panel ──────────────────────────────────────────────────────────

function SettingsPanel({ anchor }: { anchor: any }) {
  const update = useMutation(api.anchors.updateAnchor);
  const decommission = useMutation(api.anchors.decommissionAnchor);
  const [name, setName] = useState(anchor.bot_name ?? anchor.name ?? "Anchor");
  const [persona, setPersona] = useState(anchor.persona ?? "");
  const [saved, setSaved] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState(false);

  const save = async () => {
    await update({ anchor_id: anchor._id, name, persona } as any);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <Panel title="Settings">
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
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          className="text-xs bg-sol-bg-highlight hover:bg-sol-bg-highlight/70 rounded-md px-3 py-1.5"
        >
          {saved ? "Saved" : "Save"}
        </button>
        {!confirmRetire ? (
          <button
            onClick={() => setConfirmRetire(true)}
            className="ml-auto text-xs text-sol-text-dim hover:text-sol-red"
          >
            Retire
          </button>
        ) : (
          <button
            onClick={() => decommission({ anchor_id: anchor._id } as any)}
            className="ml-auto text-xs text-sol-red font-medium"
          >
            Confirm retire
          </button>
        )}
      </div>
    </Panel>
  );
}

// ── Small pieces ────────────────────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-sol-bg border border-sol-border/70 rounded-xl p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-sol-text-dim mb-3">{title}</h2>
      {children}
    </section>
  );
}

function Avatar({ name, avatar }: { name: string; avatar: string | null }) {
  if (avatar) return <img src={avatar} alt={name} className="w-9 h-9 rounded-lg object-cover" />;
  const initial = (name || "A").trim().charAt(0).toUpperCase();
  return (
    <div className="w-9 h-9 rounded-lg bg-sol-cyan/20 text-sol-cyan flex items-center justify-center font-semibold">
      {initial}
    </div>
  );
}

function StatusLine({ status, project }: { status: ReturnType<typeof deriveStatus>; project: string | null }) {
  const proj = project ? project.replace(/^.*\//, "") : null;
  return (
    <div className="text-xs flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />
      <span className={status.text}>{status.label}</span>
      {proj && <span className="text-sol-text-dim">· {proj}</span>}
    </div>
  );
}

function deriveStatus(a: any): { label: string; dot: string; text: string } {
  if (a.status === "decommissioned" || a.conv_status === "completed") {
    return { label: "retired", dot: "bg-sol-text-dim", text: "text-sol-text-dim" };
  }
  if (a.has_pending_messages) return { label: "working", dot: "bg-sol-cyan animate-pulse", text: "text-sol-cyan" };
  const fresh = a.updated_at && Date.now() - a.updated_at < 3 * 60 * 1000;
  if (fresh) return { label: "online", dot: "bg-sol-green", text: "text-sol-green" };
  return { label: "dormant · wakes on an event", dot: "bg-sol-yellow", text: "text-sol-yellow" };
}
