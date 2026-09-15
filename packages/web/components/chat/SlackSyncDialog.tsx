"use client";

// The Slack mirror for one channel: connect the workspace, pick the Slack
// channel, choose which way lines flow and what kinds of lines go, pause,
// unlink, and see what happened last. One surface, three states — no
// workspace yet, workspace but no mirror, mirrored — because the person who
// opens it wants ONE answer to "is this channel in Slack, and on what terms?"
//
// Reads: the link row from the store (chat.listChannels feeds chatSlackLinks),
// the workspace from a per-view query, the Slack channel list from an action
// on demand. Writes: optimistic store actions for the controls (the row is
// already on screen), and the link action for the one write that has to
// probe Slack first.

import { useAction, useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  ArrowLeft,
  Check,
  ExternalLink,
  Hash,
  Lock,
  Pause,
  Play,
  Search,
  Unlink,
  Users,
} from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import { DIRECTION_ARROW, LINK_DEFAULTS } from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../SlackLogo";
import { Switch } from "../ui/switch";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import { slackLinksSig } from "../../hooks/useChatSync";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { compactAge } from "../../lib/threadState";
import "./chat.css";

type Direction = ChatSlackLinkRow["direction"];
type Options = ChatSlackLinkRow["options"];

const DIRECTIONS: { key: Direction; label: string; hint: string; icon: any }[] = [
  { key: "both", label: "Both ways", hint: "Lines here appear in Slack; Slack lines appear here.", icon: ArrowLeftRight },
  { key: "slack_to_codecast", label: "From Slack", hint: "Slack lines appear here. Nothing here goes to Slack.", icon: ArrowLeft },
  { key: "codecast_to_slack", label: "To Slack", hint: "Lines here appear in Slack. Nothing from Slack comes here.", icon: ArrowRight },
];

type OptionRow = { key: keyof Options; label: string; hint: string; scope: "both" | "in" | "out" };
// The four that decide whether it feels like one conversation stay in view;
// the four policy choices most teams never touch sit behind "More".
const OPTION_ROWS: OptionRow[] = [
  { key: "threads", label: "Thread replies", hint: "Off: only top level lines cross over.", scope: "both" },
  { key: "reactions", label: "Reactions", hint: "Emoji reactions cross in both directions. Slack shows ours as the app's.", scope: "both" },
  { key: "edits", label: "Edits and deletes", hint: "An edit or delete on one side is applied on the other.", scope: "both" },
  { key: "files", label: "Images and files", hint: "Images are copied across; other files arrive as links.", scope: "both" },
];
const ADVANCED_ROWS: OptionRow[] = [
  { key: "agent_lines", label: "Agent lines to Slack", hint: "What the anchor, roles and sessions post here goes to Slack, marked as an agent.", scope: "out" },
  { key: "bot_messages", label: "Slack app messages", hint: "Lines other Slack apps and bots post (GitHub, Linear, alerts).", scope: "in" },
  { key: "system_messages", label: "Join and topic notices", hint: "Who joined or left the Slack channel, topic changes, pins.", scope: "in" },
  { key: "match_people_by_email", label: "Match people by email", hint: "A Slack person with a teammate's email appears here as that teammate. Off: everyone from Slack shows under their Slack name.", scope: "in" },
];

const BACKFILLS: { key: "none" | "1d" | "7d" | "30d"; label: string }[] = [
  { key: "none", label: "From now" },
  { key: "1d", label: "Last day" },
  { key: "7d", label: "Last week" },
  { key: "30d", label: "Last month" },
];

export function slackDeepLink(workspaceId: string, channelId: string, ts?: string): string {
  return `slack://channel?team=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(channelId)}${ts ? `&message=${encodeURIComponent(ts)}` : ""}`;
}

/** The mirror row for one channel, out of the store's whole link map. At most
 *  one link per channel (the server enforces it), so the first match is THE
 *  answer. Takes the map rather than reading the store, so a snapshot caller
 *  (the channel menu) and a subscribed one both use this one lookup. */
export function slackLinkForChannel(
  links: Record<string, ChatSlackLinkRow> | undefined,
  channelId: string | null | undefined,
): ChatSlackLinkRow | null {
  if (!channelId || !links) return null;
  for (const id in links) {
    if (links[id].chat_channel_id === channelId) return links[id];
  }
  return null;
}

export function useChannelSlackLink(channelId: string | null | undefined): ChatSlackLinkRow | null {
  const s = useTrackedStore([(st) => slackLinksSig(st.chatSlackLinks as any)]);
  return slackLinkForChannel(s.chatSlackLinks as any, channelId);
}

export function SlackSyncDialog({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const link = useChannelSlackLink(channelId);
  const s = useTrackedStore([(st) => st.chatChannels[channelId]?.name, (st) => st.chatChannels[channelId]?.team_id]);
  const channel = s.chatChannels[channelId];
  const teamId = channel?.team_id as string | undefined;
  const team = useQuery(api.slackSync.getTeamSlack, teamId ? ({ team_id: teamId } as any) : "skip");

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus moves into the dialog on open and back to whatever opened it on
  // close: three different triggers open this, so "where am I" must not
  // depend on which one it was.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>("input, button:not(.ch-slack-close), [tabindex]:not([tabindex='-1'])");
    (focusable ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="ch-slack-overlay" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="ch-slack-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Slack mirror"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ch-slack-head">
          <SlackLogo className="w-4 h-4" muted={!link || link.paused} />
          <div className="min-w-0">
            <div className="ch-slack-title">Slack mirror</div>
            <div className="ch-slack-sub">
              <Hash className="w-3 h-3 inline-block -mt-px" />
              {channel?.name ?? "channel"}
              {link && (
                <>
                  <span className="ch-slack-arrow" aria-hidden="true">{DIRECTION_ARROW[link.direction]}</span>
                  {link.slack_channel_private ? <Lock className="w-3 h-3 inline-block -mt-px" /> : <Hash className="w-3 h-3 inline-block -mt-px" />}
                  {link.slack_channel_name ?? link.slack_channel_id}
                  {team?.installation?.workspace_name && <span className="ch-slack-ws"> · {team.installation.workspace_name}</span>}
                </>
              )}
            </div>
          </div>
          <button type="button" className="ch-slack-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {team === undefined && !link ? (
          <div className="ch-slack-body ch-slack-quiet">Checking the team's Slack connection.</div>
        ) : link ? (
          <LinkedBody link={link} workspaceName={team?.installation?.workspace_name ?? null} onClose={onClose} />
        ) : team?.installation ? (
          <SetupBody channelId={channelId} teamId={teamId!} installation={team.installation} canManage={true} />
        ) : (
          <ConnectBody teamId={teamId} isAdmin={!!team?.is_admin} channelId={channelId} />
        )}
      </div>
    </div>,
    document.body,
  );
}

function ago(now: number, at: number): string {
  const age = compactAge(now - at);
  return age === "just now" ? age : `${age} ago`;
}

// ── No workspace yet ─────────────────────────────────────────────────────────

function ConnectBody({ teamId, isAdmin, channelId }: { teamId?: string; isAdmin: boolean; channelId: string }) {
  const getInstallUrl = useAction(api.slack.getInstallUrl);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const connect = async () => {
    if (!teamId) return;
    setBusy(true);
    setErr(null);
    try {
      const res: any = await getInstallUrl({ scope_type: "team", team_id: teamId, return_to: `/chat/${channelId}?slack=setup`, origin: window.location.origin } as any);
      if (res?.ok && res.url) window.location.href = res.url;
      else {
        setErr(res?.error ?? "Couldn't start the Slack connection");
        setBusy(false);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Couldn't reach Slack");
      setBusy(false);
    }
  };
  return (
    <div className="ch-slack-body">
      <p className="ch-slack-lede">
        Mirror this channel with a Slack channel. People who live in Slack keep talking there; the
        conversation shows up here, and what your team and its agents say here shows up there.
      </p>
      {isAdmin ? (
        <>
          <button type="button" onClick={connect} disabled={busy} className="ch-slack-add">
            <SlackLogo className="w-4 h-4" />
            {busy ? "Opening Slack…" : "Add to Slack"}
          </button>
          <p className="ch-slack-fine">
            Connects the team's workspace once. Every channel then chooses its own mirror.
          </p>
        </>
      ) : (
        <p className="ch-slack-fine">
          A team admin connects the Slack workspace first (one click, from this same dialog). Then any
          channel manager can set up a mirror.
        </p>
      )}
      {err && <div className="ch-slack-err">{err}</div>}
    </div>
  );
}

// ── Workspace connected, channel not mirrored ────────────────────────────────

type SlackChannelOption = {
  id: string;
  name: string;
  is_private: boolean;
  is_member: boolean;
  num_members: number | null;
  topic: string | null;
  purpose: string | null;
  linked_chat_channel_id: string | null;
  linked_chat_channel_name: string | null;
};

function SetupBody({
  channelId,
  teamId,
  installation,
  canManage,
}: {
  channelId: string;
  teamId: string;
  installation: { workspace_name: string | null; workspace_id: string };
  canManage: boolean;
}) {
  const listChannels = useAction(api.slackSync.listSlackChannels);
  const linkChannel = useAction(api.slackSync.linkChannel);
  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<SlackChannelOption | null>(null);
  const [direction, setDirection] = useState<Direction>("both");
  const [options, setOptions] = useState<Options>(LINK_DEFAULTS);
  const [backfill, setBackfill] = useState<"none" | "1d" | "7d" | "30d">("none");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useWatchEffect(() => {
    let alive = true;
    listChannels({ team_id: teamId } as any)
      .then((res: any) => {
        if (!alive) return;
        if (res?.ok) setChannels(res.channels ?? []);
        else setLoadErr(res?.error ?? "Couldn't list Slack channels");
      })
      .catch((e: any) => alive && setLoadErr(e?.message ?? "Couldn't reach Slack"));
    return () => {
      alive = false;
    };
  }, [teamId, listChannels]);

  const chatName = useInboxStore((st) => st.chatChannels[channelId]?.name);
  const filtered = useMemo(() => {
    if (!channels) return [];
    const needle = q.trim().toLowerCase();
    const rows = needle ? channels.filter((c) => c.name.toLowerCase().includes(needle)) : channels;
    // The same name first: the obvious pairing is nearly always the right one.
    return [...rows].sort((a, b) => {
      const am = a.name === chatName ? 0 : 1;
      const bm = b.name === chatName ? 0 : 1;
      return am - bm || a.name.localeCompare(b.name);
    });
  }, [channels, q, chatName]);

  const start = async () => {
    if (!picked) return;
    setBusy(true);
    setErr(null);
    try {
      const res: any = await linkChannel({
        chat_channel_id: channelId,
        slack_channel_id: picked.id,
        direction,
        options,
        backfill,
      } as any);
      if (!res?.ok) {
        setErr(res?.error ?? "Couldn't set up the mirror");
        setBusy(false);
        return;
      }
      toast(`Mirroring #${chatName ?? "channel"} with Slack #${picked.name}`, { duration: 4000 });
    } catch (e: any) {
      setErr(e?.data?.message ?? e?.message ?? "Couldn't set up the mirror");
      setBusy(false);
    }
  };

  if (!canManage) {
    return (
      <div className="ch-slack-body">
        <p className="ch-slack-lede">
          This team's Slack{installation.workspace_name ? ` (${installation.workspace_name})` : ""} is connected.
          The channel's creator or a team admin can set up its mirror.
        </p>
      </div>
    );
  }

  return (
    <div className="ch-slack-body">
      <section className="ch-slack-section">
        <div className="ch-slack-label">
          Slack channel
          <span className="ch-slack-ws">{installation.workspace_name ?? installation.workspace_id}</span>
        </div>
        <label className="ch-slack-search">
          <Search className="w-3.5 h-3.5" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a channel"
            autoFocus
            aria-label="Find a Slack channel"
          />
        </label>
        <div className="ch-slack-list" role="listbox" aria-label="Slack channels">
          {loadErr ? (
            <div className="ch-slack-err">{loadErr}</div>
          ) : channels === null ? (
            <div className="ch-slack-quiet">Asking Slack for the channel list…</div>
          ) : filtered.length === 0 ? (
            <div className="ch-slack-quiet">
              {channels.length === 0
                ? "The app can't see any channels yet. In Slack, invite @Codecast to a channel, then reopen this."
                : "No channel matches."}
            </div>
          ) : (
            filtered.map((c) => {
              const taken = !!c.linked_chat_channel_id;
              const selected = picked?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={taken}
                  className={`ch-slack-row ${selected ? "ch-slack-row-on" : ""}`}
                  onClick={() => setPicked(c)}
                  title={c.topic || c.purpose || undefined}
                >
                  {c.is_private ? <Lock className="w-3 h-3 shrink-0" /> : <Hash className="w-3 h-3 shrink-0" />}
                  <span className="ch-slack-row-name">{c.name}</span>
                  {c.name === chatName && !taken && <span className="ch-slack-tag">same name</span>}
                  {taken ? (
                    <span className="ch-slack-row-meta">mirrors #{c.linked_chat_channel_name}</span>
                  ) : (
                    <span className="ch-slack-row-meta">
                      {c.is_private && !c.is_member ? "invite the app first" : c.num_members !== null ? <><Users className="w-3 h-3 inline-block -mt-px" /> {c.num_members}</> : null}
                    </span>
                  )}
                  {selected && <Check className="w-3.5 h-3.5 shrink-0 ch-slack-check" />}
                </button>
              );
            })
          )}
        </div>
      </section>

      <section className="ch-slack-section">
        <div className="ch-slack-label">Direction</div>
        <DirectionPicker value={direction} onChange={setDirection} />
      </section>

      <section className="ch-slack-section">
        <div className="ch-slack-label">What crosses over</div>
        <OptionRows options={options} direction={direction} onChange={(k, val) => setOptions((o) => ({ ...o, [k]: val }))} />
      </section>

      {direction !== "codecast_to_slack" && (
        <section className="ch-slack-section">
          <div className="ch-slack-label">Bring in Slack history</div>
          <div className="ch-slack-seg" role="radiogroup" aria-label="Backfill">
            {BACKFILLS.map((b) => (
              <button
                key={b.key}
                type="button"
                role="radio"
                aria-checked={backfill === b.key}
                className={`ch-slack-seg-item ${backfill === b.key ? "ch-slack-seg-on" : ""}`}
                onClick={() => setBackfill(b.key)}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="ch-slack-fine">Backfilled lines keep their Slack time and wake nobody. Up to 500 messages.</p>
        </section>
      )}

      {err && <div className="ch-slack-err">{err}</div>}
      <p className="ch-slack-fine ch-slack-summary">
        This channel takes the Slack channel's name and follows it when Slack renames it. Nothing
        already posted moves, either way, unless you pick history above. Slack gets one notice when
        this starts. You can unlink any time; copies on both sides stay.
      </p>
      <footer className="ch-slack-foot">
        <span className="ch-slack-fine">
          {pickSummary(picked, chatName)}
        </span>
        <button type="button" className="ch-slack-primary" disabled={!picked || busy} onClick={start}>
          {busy ? "Setting up…" : "Start mirroring"}
        </button>
      </footer>
    </div>
  );
}

// ── Mirrored ─────────────────────────────────────────────────────────────────

function LinkedBody({ link, workspaceName, onClose }: { link: ChatSlackLinkRow; workspaceName: string | null; onClose: () => void }) {
  const update = useInboxStore((st) => st.updateChatSlackLink);
  const unlink = useInboxStore((st) => st.unlinkChatSlack);
  const activity = useQuery(api.slackSync.linkActivity, { link_id: link._id } as any);
  const now = useCoarseNow(30_000);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const paused = !!link.paused;

  return (
    <div className="ch-slack-body">
      <section className={`ch-slack-status ${paused ? "ch-slack-status-paused" : ""}`}>
        <div className="ch-slack-status-row">
          <span className={`ch-slack-dot ${paused ? "ch-slack-dot-paused" : link.last_error ? "ch-slack-dot-err" : ""}`} />
          <span className="ch-slack-status-text">
            {paused ? "Paused" : "Mirroring"}
            {workspaceName && <span className="ch-slack-ws"> · {workspaceName}</span>}
          </span>
          <a
            className="ch-slack-open"
            href={slackDeepLink(link.workspace_id, link.slack_channel_id)}
            title="Open the Slack channel"
          >
            Open in Slack <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <dl className="ch-slack-facts">
          <div><dt>From Slack</dt><dd>{link.inbound_count ?? 0}{link.last_inbound_at ? ` · ${ago(now, link.last_inbound_at)}` : ""}</dd></div>
          <div><dt>To Slack</dt><dd>{link.outbound_count ?? 0}{link.last_outbound_at ? ` · ${ago(now, link.last_outbound_at)}` : ""}</dd></div>
          <div><dt>Since</dt><dd>{new Date(Number(link.since_ts) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</dd></div>
        </dl>
        {link.last_error && (
          <div className="ch-slack-err ch-slack-err-inline">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{humanizeError(link.last_error)}</span>
          </div>
        )}
      </section>

      <section className="ch-slack-section">
        <div className="ch-slack-label">Direction</div>
        <DirectionPicker value={link.direction} onChange={(d) => update(link._id, { direction: d })} />
      </section>

      <section className="ch-slack-section">
        <div className="ch-slack-label">What crosses over</div>
        <OptionRows
          options={{ ...LINK_DEFAULTS, ...link.options }}
          direction={link.direction}
          onChange={(k, val) => update(link._id, { options: { [k]: val } })}
        />
      </section>

      <section className="ch-slack-section">
        <div className="ch-slack-label">Recent activity</div>
        {activity === undefined ? (
          <div className="ch-slack-quiet">Loading…</div>
        ) : !activity || activity.length === 0 ? (
          <div className="ch-slack-quiet">Nothing from Slack yet. Say something there.</div>
        ) : (
          <ul className="ch-slack-ledger">
            {activity.map((j: any) => (
              <li key={j._id} className={`ch-slack-ledger-row ch-slack-ledger-${j.status}`}>
                <span className="ch-slack-ledger-kind">{describeKind(j.kind)}</span>
                <span className="ch-slack-ledger-status">{describeJobStatus(j.status, j.error)}</span>
                <span className="ch-slack-ledger-time">{compactAge(now - j.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="ch-slack-foot ch-slack-foot-split">
        <button
          type="button"
          className="ch-slack-secondary"
          onClick={() => update(link._id, { paused: !paused })}
          title={paused ? "Resume mirroring" : "Pause mirroring both ways; nothing is lost on either side"}
        >
          {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {paused ? "Resume" : "Pause"}
        </button>
        {confirmUnlink ? (
          <span className="ch-slack-confirm">
            <span>Stop mirroring? Lines already copied stay on both sides.</span>
            <button type="button" className="ch-slack-danger" onClick={() => { unlink(link._id); onClose(); }}>
              Unlink
            </button>
            <button type="button" className="ch-slack-secondary" onClick={() => setConfirmUnlink(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="ch-slack-secondary ch-slack-secondary-danger" onClick={() => setConfirmUnlink(true)}>
            <Unlink className="w-3.5 h-3.5" />
            Unlink
          </button>
        )}
      </footer>
    </div>
  );
}

/** The footer's one sentence about the choice so far. */
function pickSummary(picked: SlackChannelOption | null, chatName: string | undefined): string {
  if (!picked) return "Pick the Slack channel to mirror.";
  if (picked.is_private && !picked.is_member) {
    return "Private: run /invite @Codecast in that Slack channel first.";
  }
  return chatName && chatName !== picked.name
    ? `#${chatName} becomes #${picked.name}, the same name as in Slack.`
    : `Mirroring #${picked.name} with Slack.`;
}

function DirectionPicker({ value, onChange }: { value: Direction; onChange: (d: Direction) => void }) {
  return (
    <div className="ch-slack-dirs" role="radiogroup" aria-label="Direction">
      {DIRECTIONS.map((d) => {
        const Icon = d.icon;
        const on = value === d.key;
        return (
          <button
            key={d.key}
            type="button"
            role="radio"
            aria-checked={on}
            className={`ch-slack-dir ${on ? "ch-slack-dir-on" : ""}`}
            onClick={() => onChange(d.key)}
          >
            <Icon className="w-3.5 h-3.5" />
            <span className="ch-slack-dir-label">{d.label}</span>
            <span className="ch-slack-dir-hint">{d.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

function OptionRows({
  options,
  direction,
  onChange,
}: {
  options: Options;
  direction: Direction;
  onChange: (key: keyof Options, value: boolean) => void;
}) {
  const inbound = direction !== "codecast_to_slack";
  const outbound = direction !== "slack_to_codecast";
  const render = (rows: OptionRow[]) => rows.map((row) => {
    const relevant = row.scope === "both" || (row.scope === "in" && inbound) || (row.scope === "out" && outbound);
    return (
      <li key={row.key} className={`ch-slack-opt ${relevant ? "" : "ch-slack-opt-dim"}`}>
        <div className="ch-slack-opt-text">
          <span className="ch-slack-opt-label">{row.label}</span>
          <span className="ch-slack-opt-hint">{relevant ? row.hint : "Not used with this direction."}</span>
        </div>
        <Switch
          checked={!!options[row.key]}
          onCheckedChange={(v) => onChange(row.key, v)}
          disabled={!relevant}
          aria-label={row.label}
        />
      </li>
    );
  });
  const changedAdvanced = ADVANCED_ROWS.filter((r) => options[r.key] !== LINK_DEFAULTS[r.key]).length;
  return (
    <>
      <ul className="ch-slack-opts">{render(OPTION_ROWS)}</ul>
      <details className="ch-slack-more">
        <summary>
          More
          {changedAdvanced > 0 && <span className="ch-slack-more-count">{changedAdvanced} changed</span>}
        </summary>
        <ul className="ch-slack-opts">{render(ADVANCED_ROWS)}</ul>
      </details>
    </>
  );
}

function describeKind(kind: string): string {
  switch (kind) {
    case "message": return "message";
    case "message.file_share": return "file";
    case "message.thread_broadcast": return "thread reply (broadcast)";
    case "message.bot_message": return "app message";
    case "message.message_changed": return "edit";
    case "message.message_deleted": return "delete";
    case "reaction_added": return "reaction";
    case "reaction_removed": return "reaction removed";
    case "member_joined_channel": return "joined";
    case "member_left_channel": return "left";
    default: return kind.replace(/^message\./, "").replace(/_/g, " ");
  }
}

/** One job's line in the activity strip: what became of it, and why when the
 *  answer is not obvious. */
function describeJobStatus(status: string, error: string | null): string {
  switch (status) {
    case "done": return "mirrored";
    case "skipped": return error ? `skipped · ${describeSkip(error)}` : "skipped";
    case "failed": return error ? `failed · ${error}` : "failed";
    default: return "queued";
  }
}

function describeSkip(reason: string): string {
  const table: Record<string, string> = {
    own_bot: "our own post",
    bot_off: "app messages are off",
    threads_off: "threads are off",
    edits_off: "edits are off",
    reactions_off: "reactions are off",
    system_off: "notices are off",
    before_link: "older than the mirror",
    duplicate: "already here",
    not_mirrored: "original not here",
    not_inbound: "our own line",
    unchanged: "no change",
    empty: "nothing to show",
  };
  if (reason.startsWith("unknown_emoji:")) return `no match for :${reason.slice("unknown_emoji:".length)}:`;
  return table[reason] ?? `Slack said "${reason}"`;
}

function humanizeError(err: string): string {
  if (err.includes("not_in_channel")) return "The app is not in the Slack channel. In Slack, run /invite @Codecast there, then resume.";
  if (err.includes("channel_not_found")) return "Slack can't find that channel any more.";
  if (err.includes("is_archived")) return "The Slack channel is archived.";
  if (err.includes("missing_scope")) return "The Slack app needs newer permissions. Reconnect Slack from the anchor page.";
  if (err.includes("invalid_auth") || err.includes("token_revoked") || err.includes("account_inactive")) return "Slack revoked the app's access. Reconnect Slack.";
  if (err.includes("ratelimited")) return "Slack is rate limiting the app. It retries on its own; nothing to do.";
  return `Slack reported a problem (${err}). Reconnect Slack if this keeps happening.`;
}
