"use client";

// Bring Slack channels into codecast. The connected workspace's channels in
// one list, the ones already here marked as such, a checkbox per row, one
// choice of how much history to bring, one direction, one button. Each
// channel picked becomes a codecast channel of the same name, mirrored both
// ways by default, with a month of history: the defaults are the choice most
// teams would make, so the common case is search, tick, add.
//
// The import itself is visible: while history comes over, each row counts the
// lines that have landed (read from the store's link rows, which the server
// updates page by page), so nobody has to wonder whether it is still working.
import { useAction, useQuery } from "convex/react";
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { AlertTriangle, Check, ExternalLink, Hash, Loader2, Lock, Search, Users, UserRound } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  BACKFILL_WINDOWS,
  DEFAULT_BACKFILL,
  DIRECTION_LABEL,
  type BackfillWindow,
  type SlackDirection,
} from "@codecast/convex/convex/lib/slackMirror";
import { SlackLogo } from "../SlackLogo";
import { useTrackedStore } from "../../store/inboxStore";
import type { ChatSlackLinkRow } from "../../store/chatSlice";
import { slackLinksSig } from "../../hooks/useChatSync";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { DirectionPicker, type SlackChannelOption } from "./SlackSyncDialog";
import { SlackPeopleDialog } from "./SlackPeopleDialog";
import { SlackDmSwitch } from "./SlackDmSwitch";
import "./chat.css";

type RowState =
  | { kind: "idle" }
  | { kind: "adding" }
  | { kind: "added"; chatChannelId: string }
  | { kind: "failed"; error: string };

/** "since Mar 2024" for the row's meta, from Slack's creation time. */
function sinceLabel(created: number | null | undefined): string | null {
  if (!created) return null;
  return `since ${new Date(created).toLocaleDateString(undefined, { month: "short", year: "numeric" })}`;
}

function formatCount(n: number): string {
  return n.toLocaleString();
}

export function SlackChannelBrowser({
  teamId,
  onClose,
  /** Called with the first channel added, once everything has been queued. */
  onAdded,
}: {
  teamId: string;
  onClose: () => void;
  onAdded?: (chatChannelId: string) => void;
}) {
  const team = useQuery(api.slackSync.getTeamSlack, { team_id: teamId } as any);
  const listChannels = useAction(api.slackSync.listSlackChannels);
  const linkChannel = useAction(api.slackSync.linkChannel);
  const getInstallUrl = useAction(api.slack.getInstallUrl);

  const [channels, setChannels] = useState<SlackChannelOption[] | null>(null);
  // The person connected their own Slack account: private channels they are
  // in are listed and the app can be invited into one for them.
  const [canAddPrivate, setCanAddPrivate] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [people, setPeople] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [backfill, setBackfill] = useState<BackfillWindow>(DEFAULT_BACKFILL);
  const [direction, setDirection] = useState<SlackDirection>("both");
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);

  useWatchEffect(() => {
    let alive = true;
    listChannels({ team_id: teamId } as any)
      .then((res: any) => {
        if (!alive) return;
        if (res?.ok) {
          setChannels(res.channels ?? []);
          setCanAddPrivate(!!res.can_add_private);
        } else setLoadErr(res?.error ?? "Couldn't list Slack channels");
      })
      .catch((e: any) => alive && setLoadErr(e?.message ?? "Couldn't reach Slack"));
    return () => {
      alive = false;
    };
  }, [teamId, listChannels]);

  // The store's link rows are the live truth about what is mirrored and how
  // far each import has got: a channel added a moment ago shows its count
  // climbing here without a second fetch.
  const s = useTrackedStore([
    (st) => slackLinksSig(st.chatSlackLinks as any),
    (st) => Object.keys(st.chatChannels ?? {}).length,
  ]);
  const linkBySlackId = useMemo(() => {
    const map = new Map<string, ChatSlackLinkRow>();
    for (const l of Object.values(s.chatSlackLinks ?? {}) as ChatSlackLinkRow[]) map.set(l.slack_channel_id, l);
    return map;
  }, [s.chatSlackLinks]);
  // A codecast channel that already carries a Slack channel's name becomes
  // that channel's mirror rather than a duplicate: the row says so up front.
  const existingByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of Object.values(s.chatChannels ?? {}) as any[]) {
      if (!c.archived_at && String(c.team_id) === teamId && c.kind !== "dm") map.set(c.name, String(c._id));
    }
    return map;
  }, [s.chatChannels, teamId]);

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, running]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  useWatchEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = dialogRef.current?.querySelector<HTMLElement>("input, button:not(.ch-slack-close), [tabindex]:not([tabindex='-1'])");
    (focusable ?? dialogRef.current)?.focus();
    return () => opener?.focus?.();
  }, []);

  // Rows: the ones you can still add first, busiest first; already mirrored
  // channels sink to the bottom under their own heading so the list reads as
  // "what is left to bring over".
  const sorted = useMemo(() => {
    if (!channels) return { open: [] as SlackChannelOption[], here: [] as SlackChannelOption[] };
    const needle = q.trim().toLowerCase();
    const match = (c: SlackChannelOption) =>
      !needle || c.name.toLowerCase().includes(needle) || (c.purpose ?? "").toLowerCase().includes(needle);
    const isHere = (c: SlackChannelOption) => !!c.linked_chat_channel_id || linkBySlackId.has(c.id);
    const byBusy = (a: SlackChannelOption, b: SlackChannelOption) =>
      (b.num_members ?? 0) - (a.num_members ?? 0) || a.name.localeCompare(b.name);
    return {
      open: channels.filter((c) => match(c) && !isHere(c)).sort(byBusy),
      here: channels.filter((c) => match(c) && isHere(c)).sort(byBusy),
    };
  }, [channels, q, linkBySlackId]);

  const addable = (c: SlackChannelOption) => c.is_member || !c.is_private || (!!c.you_are_in && canAddPrivate);

  // Slack's consent screen for the person's own scopes; back here afterwards.
  const connectSelf = async () => {
    setConnecting(true);
    try {
      const res: any = await getInstallUrl({
        scope_type: "self",
        team_id: teamId,
        return_to: `${window.location.pathname}?slack=connected`,
        origin: window.location.origin,
      } as any);
      if (res?.ok && res.url) window.location.href = res.url;
      else setLoadErr(res?.error ?? "Couldn't start the Slack connection");
    } catch (e: any) {
      setLoadErr(e?.message ?? "Couldn't start the Slack connection");
    } finally {
      setConnecting(false);
    }
  };
  const pickedList = useMemo(
    () => (channels ?? []).filter((c) => picked.has(c.id)),
    [channels, picked],
  );
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const selectAllOpen = () => setPicked(new Set(sorted.open.filter(addable).map((c) => c.id)));
  const clear = () => setPicked(new Set());

  const start = async () => {
    if (pickedList.length === 0 || running) return;
    setRunning(true);
    let first: string | null = null;
    // One at a time: each link probes Slack, may join the channel, and posts a
    // notice there. Serial keeps the workspace's rate limits comfortable and
    // gives the list a readable progression.
    for (const c of pickedList) {
      setRows((r) => ({ ...r, [c.id]: { kind: "adding" } }));
      try {
        const res: any = await linkChannel({ team_id: teamId, slack_channel_id: c.id, direction, backfill } as any);
        if (res?.ok) {
          setRows((r) => ({ ...r, [c.id]: { kind: "added", chatChannelId: String(res.chat_channel_id) } }));
          first ??= String(res.chat_channel_id);
        } else {
          setRows((r) => ({ ...r, [c.id]: { kind: "failed", error: res?.error ?? "Couldn't add this channel" } }));
        }
      } catch (e: any) {
        setRows((r) => ({ ...r, [c.id]: { kind: "failed", error: e?.data?.message ?? e?.message ?? "Couldn't add this channel" } }));
      }
    }
    setPicked(new Set());
    setRunning(false);
    if (first) onAdded?.(first);
  };

  const added = Object.values(rows).filter((r) => r.kind === "added").length;
  const total = Object.values(rows).filter((r) => r.kind !== "idle").length;
  const historyWindow = BACKFILL_WINDOWS.find((w) => w.key === backfill)!;
  const canManage = !!team?.installation;
  const workspace = team?.installation?.workspace_name ?? null;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="ch-slack-overlay" onClick={running ? undefined : onClose} role="presentation">
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="ch-slack-dialog ch-slack-browser"
        role="dialog"
        aria-modal="true"
        aria-label="Add channels from Slack"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ch-slack-head">
          <SlackLogo className="w-5 h-5" />
          <div className="min-w-0">
            <div className="ch-slack-title">Add channels from Slack</div>
            <div className="ch-slack-sub">
              {workspace ?? "Slack"}
              {channels && (
                <span className="ch-slack-ws">
                  {" · "}
                  {formatCount(channels.length)} channels
                  {sorted.here.length + (channels.length - sorted.open.length - sorted.here.length) > 0 &&
                    !q &&
                    ` · ${formatCount(channels.length - sorted.open.length)} already here`}
                </span>
              )}
            </div>
          </div>
          <button type="button" className="ch-slack-close" aria-label="Close" onClick={onClose} disabled={running}>
            ×
          </button>
        </header>

        <div className="ch-slack-body ch-slack-browser-body">
          {team && !team.installation && (
            <p className="ch-slack-lede">
              This team has no Slack workspace connected yet. A team admin connects one under Settings → Integrations.
            </p>
          )}
          {loadErr && <div className="ch-slack-err"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{loadErr}</div>}

          <section className="ch-slack-section ch-slack-browser-pick">
            <div className="ch-slack-browser-tools">
              <label className="ch-slack-search">
                <Search className="w-3.5 h-3.5 text-sol-text-dim" />
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search channels and purposes"
                  aria-label="Search Slack channels"
                  disabled={!channels}
                />
              </label>
              <div className="ch-slack-browser-quick">
                <button type="button" className="ch-slack-quiet" onClick={selectAllOpen} disabled={!channels || running || sorted.open.filter(addable).length === 0}>
                  Select all{q ? " matching" : ""}
                </button>
                <button type="button" className="ch-slack-quiet" onClick={clear} disabled={picked.size === 0 || running}>
                  Clear
                </button>
              </div>
            </div>

            <div className="ch-slack-list ch-slack-browser-list" role="listbox" aria-multiselectable="true" aria-label="Slack channels">
              {!channels && !loadErr && (
                <div className="ch-slack-empty"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Reading the workspace…</div>
              )}
              {channels && sorted.open.length === 0 && sorted.here.length === 0 && (
                <div className="ch-slack-empty">{q ? `Nothing matches “${q}”.` : "Every channel is already here."}</div>
              )}
              {sorted.open.map((c) => (
                <BrowserRow
                  key={c.id}
                  c={c}
                  selected={picked.has(c.id)}
                  disabled={!addable(c) || running}
                  state={rows[c.id] ?? { kind: "idle" }}
                  link={linkBySlackId.get(c.id) ?? null}
                  joins={existingByName.has(c.name)}
                  onToggle={() => toggle(c.id)}
                />
              ))}
              {sorted.here.length > 0 && (
                <div className="ch-slack-browser-heading">Already here</div>
              )}
              {sorted.here.map((c) => (
                <BrowserRow
                  key={c.id}
                  c={c}
                  selected={false}
                  disabled
                  state={rows[c.id] ?? { kind: "idle" }}
                  link={linkBySlackId.get(c.id) ?? null}
                  onToggle={() => {}}
                />
              ))}
            </div>
            {channels && !canAddPrivate && (
              <div className="ch-slack-connect-self">
                <Lock className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
                <span>
                  Private channels you are in appear here once you connect your Slack account. The app is
                  then invited in for you; no <code>/invite</code> needed.
                </span>
                <button type="button" className="ch-slack-secondary" onClick={connectSelf} disabled={connecting || running}>
                  {connecting ? <Loader2 className="w-3 h-3 animate-spin" /> : <SlackLogo className="w-3 h-3" />}
                  Connect your Slack account
                </button>
              </div>
            )}
            {channels && canAddPrivate && <SlackDmSwitch teamId={teamId} />}
            {channels && canAddPrivate && sorted.open.some((c) => !addable(c)) && (
              <p className="ch-slack-fine">
                A greyed private channel is one you are not in. Join it in Slack, or have a member run <code>/invite @Codecast</code> there.
              </p>
            )}
          </section>

          <section className="ch-slack-section">
            <div className="ch-slack-label">History to bring in</div>
            <div className="ch-slack-windows" role="radiogroup" aria-label="History to bring in">
              {BACKFILL_WINDOWS.map((w) => {
                const on = backfill === w.key;
                return (
                  <button
                    key={w.key}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    className={`ch-slack-window ${on ? "ch-slack-window-on" : ""}`}
                    onClick={() => setBackfill(w.key)}
                    disabled={running}
                  >
                    <span className="ch-slack-window-label">
                      {w.label}
                      {w.key === DEFAULT_BACKFILL && <span className="ch-slack-tag ch-slack-tag-quiet">default</span>}
                    </span>
                    <span className="ch-slack-window-hint">{w.hint}</span>
                  </button>
                );
              })}
            </div>
            <p className="ch-slack-fine">
              Older lines keep their Slack time and wake nobody. Each channel takes the Slack channel's name and
              follows it if Slack renames it.
            </p>
          </section>

          <section className="ch-slack-section">
            <div className="ch-slack-label">Direction</div>
            <DirectionPicker value={direction} onChange={setDirection} />
          </section>
        </div>

        <footer className="ch-slack-foot ch-slack-browser-foot">
          <span className="ch-slack-fine ch-slack-browser-footnote">
            {total > 0 && !running && (
              <button type="button" className="ch-slack-quiet ch-slack-people-link" onClick={() => setPeople(true)}>
                <UserRound className="w-3 h-3" /> Match people from Slack to teammates
              </button>
            )}
            {running
              ? `Adding ${added + 1 > pickedList.length ? pickedList.length : added + 1} of ${pickedList.length}…`
              : total > 0 && picked.size === 0
                ? `${added} of ${total} added. Imports keep running in the background.`
                : picked.size === 0
                  ? "Tick the channels to bring over."
                  : `${picked.size} channel${picked.size === 1 ? "" : "s"} · ${historyWindow.label.toLowerCase()} of history · ${DIRECTION_LABEL[direction]}`}
          </span>
          {total > 0 && picked.size === 0 && !running ? (
            <button type="button" className="ch-slack-primary" onClick={onClose}>Done</button>
          ) : (
            <button
              type="button"
              className="ch-slack-primary"
              disabled={picked.size === 0 || running || !canManage}
              onClick={start}
            >
              {running ? <Loader2 className="w-3.5 h-3.5 animate-spin inline-block -mt-px" /> : null}
              {running ? " Adding…" : `Add ${picked.size || ""} channel${picked.size === 1 ? "" : "s"}`.replace("Add  ", "Add ")}
            </button>
          )}
        </footer>
      </div>
      {people && <SlackPeopleDialog teamId={teamId} onClose={() => setPeople(false)} />}
    </div>,
    document.body,
  );
}

function BrowserRow({
  c,
  selected,
  disabled,
  state,
  link,
  joins,
  onToggle,
}: {
  c: SlackChannelOption;
  selected: boolean;
  disabled: boolean;
  state: RowState;
  link: ChatSlackLinkRow | null;
  /** A codecast channel of this name already exists; the mirror joins it. */
  joins?: boolean;
  onToggle: () => void;
}) {
  const here = !!link || !!c.linked_chat_channel_id || state.kind === "added";
  const chatId = link?.chat_channel_id ?? c.linked_chat_channel_id ?? (state.kind === "added" ? state.chatChannelId : null);
  const needsInvite = c.is_private && !c.is_member && !here && disabled;
  const since = sinceLabel(c.created);
  const progress = link?.backfill;
  return (
    <div className={`ch-slack-row ch-slack-browser-row ${selected ? "ch-slack-row-on" : ""} ${here ? "ch-slack-browser-row-here" : ""}`}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        className="ch-slack-browser-main"
        disabled={disabled || here}
        onClick={onToggle}
        title={needsInvite ? "Private: the app is not in this channel yet" : c.purpose ?? undefined}
      >
        <span className={`ch-slack-box ${selected ? "ch-slack-box-on" : ""}`} aria-hidden="true">
          {selected && <Check className="w-3 h-3" />}
          {here && !selected && <Check className="w-3 h-3 opacity-50" />}
        </span>
        {c.is_private ? <Lock className="w-3 h-3 shrink-0" /> : <Hash className="w-3 h-3 shrink-0" />}
        <span className="ch-slack-row-name">{c.name}</span>
        {c.is_general && <span className="ch-slack-tag ch-slack-tag-quiet">general</span>}
        {joins && !here && <span className="ch-slack-tag ch-slack-tag-quiet" title={`A codecast #${c.name} already exists; it becomes this channel's mirror`}>joins #{c.name}</span>}
        {c.purpose && <span className="ch-slack-browser-purpose">{c.purpose}</span>}
        <span className="ch-slack-row-meta">
          {c.num_members != null && (
            <span className="inline-flex items-center gap-0.5"><Users className="w-3 h-3" />{formatCount(c.num_members)}</span>
          )}
          {since && <span className="ch-slack-browser-since">{since}</span>}
        </span>
      </button>
      <span className="ch-slack-browser-state">
        {state.kind === "adding" && <><Loader2 className="w-3 h-3 animate-spin" /> adding…</>}
        {state.kind === "failed" && <span className="ch-slack-browser-fail" title={state.error}><AlertTriangle className="w-3 h-3" />{state.error}</span>}
        {(state.kind === "added" || (here && state.kind === "idle")) && (
          <>
            {progress?.status === "running" && (
              <span className="ch-slack-browser-progress"><Loader2 className="w-3 h-3 animate-spin" />{formatCount(progress.fetched)} lines so far</span>
            )}
            {progress?.status === "done" && (
              <span className="ch-slack-browser-progress">{formatCount(progress.fetched)} lines{progress.capped ? " (capped)" : ""}</span>
            )}
            {progress?.status === "failed" && (
              <span className="ch-slack-browser-fail"><AlertTriangle className="w-3 h-3" />import stopped</span>
            )}
            {chatId && (
              <Link href={`/chat/${chatId}`} className="ch-slack-browser-open" title="Open in Chat">
                Open <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </>
        )}
        {needsInvite && state.kind === "idle" && <span className="ch-slack-browser-invite">{c.you_are_in ? "connect your Slack" : "not in it"}</span>}
        {c.is_private && !c.is_member && !here && !disabled && state.kind === "idle" && (
          <span className="ch-slack-browser-since" title="The app will be invited in as you">you're in</span>
        )}
      </span>
    </div>
  );
}
