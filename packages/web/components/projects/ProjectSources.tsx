"use client";
// A project's sources: the channels and trigger events whose new items arrive
// as turns in the project's main session (agent_tasks.project_id), so its
// agent does the first pass before a person reads them. Each row says what it
// watches, when it last fired and how often; pause and remove act in place.
// Adding one arms agent runs, so it goes through the consequential review.
import Link from "next/link";
import { Hash, Pause, Play, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { CHAT_TRIGGER_EVENTS, TRIGGER_EVENT_NAMES, triggerEventLabel } from "@codecast/shared/contracts";
import { useInboxStore, isConvexId } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { RecordSection } from "../initiatives/InitiativeRecord";
import { SelectBox } from "../ui/select-box";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { relativeTime } from "../../lib/entityDisplay";
import { projectDefaultSessionOf, type ProjectRow, type RoleSeat } from "../../lib/projectDefaultSession";

type SourceRow = {
  _id: string;
  project_id?: string;
  title: string;
  status: string;
  event_filter?: { event_type: string; channel_id?: string };
  paused_by_project_id?: string;
  last_run_at?: number;
  last_run_failed?: boolean;
  last_run_summary?: string;
  last_run_conversation_id?: string;
  run_count: number;
};

const GONE = new Set(["completed", "cancelled"]);
const sourceSig = (t: SourceRow) => `${t.project_id ?? ""}|${t.status}|${t.title}|${t.last_run_at ?? 0}|${t.last_run_failed ? 1 : 0}|${t.run_count}|${t.paused_by_project_id ?? ""}|${t.event_filter?.channel_id ?? ""}`;
const channelSig = (c: any) => `${c.name}|${c.kind ?? ""}|${c.archived_at ? 1 : 0}`;
const EVENTS = TRIGGER_EVENT_NAMES.filter((n) => !CHAT_TRIGGER_EVENTS.includes(n));

/** The review an add opens: what it watches, where runs land, what each run gets. */
export function sourceLedger(r: { source: string; project: string; mainSession: string | null; channel: boolean }): SwitchLedger {
  return {
    name: "Add source",
    subject: r.project,
    shift: null,
    figures: [{ value: "1", label: r.channel ? "run per burst" : "run per event", tone: "warn" }],
    rows: [
      { k: "Watches", v: r.source },
      { k: "Runs in", v: r.mainSession ?? "New main session" },
      ...(r.channel ? [{ k: "A run gets", v: "Every line since the last" }, { k: "Skips", v: "Lines the session wrote" }] : []),
      { k: "Paused", v: "With the project", tone: "ok" as const },
    ],
    stop: "Pause or remove",
    confirm: `Watch ${r.source}`,
  };
}

export function ProjectSources({ project }: { project: ProjectRow & { _id: string; title: string } }) {
  const where = useMemo(() => (t: SourceRow) => t.project_id === project._id && !GONE.has(t.status), [project._id]);
  const sources = useCollectionRows<SourceRow>("agentTasks", { where, sig: sourceSig });
  const channelRows = useCollectionRows<any>("chatChannels", { sig: channelSig });
  const channels = useMemo(() => channelRows.filter((c) => c.kind !== "dm" && !c.archived_at).sort((a, b) => a.name.localeCompare(b.name)), [channelRows]);
  const channelName = useMemo(() => new Map(channelRows.map((c) => [String(c._id), c.name as string])), [channelRows]);
  const mainId = useInboxStore((s) => projectDefaultSessionOf(project, s.sessions, s.orgTree?.roles as RoleSeat[] | undefined));
  const mainTitle = useInboxStore((s) => (mainId ? s.sessions[mainId]?.title || mainId.slice(0, 7) : null));
  const [pick, setPick] = useState("");
  const [reviewing, setReviewing] = useState(false);

  const watched = useMemo(() => new Set(sources.map((s) => s.event_filter?.channel_id ?? `event:${s.event_filter?.event_type}`)), [sources]);
  const picked = pick.startsWith("ch:") ? { channel_id: pick.slice(3), title: `#${channelName.get(pick.slice(3)) ?? "channel"}` } : pick ? { event: pick.slice(3), title: triggerEventLabel(pick.slice(3)) } : null;

  const add = () => {
    if (!picked) return;
    const key = `ps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    useInboxStore.getState().addProjectSource(project._id, picked, key);
    setPick("");
  };

  return (
    <RecordSection name="sources" label="Sources" count={sources.length}>
      <ul className="flex flex-col" data-project-sources>
        {sources.map((t) => {
          const chat = !!t.event_filter?.channel_id;
          const name = chat ? `#${channelName.get(t.event_filter!.channel_id!) ?? "channel"}` : triggerEventLabel(t.event_filter?.event_type);
          const paused = t.status === "paused";
          const stub = !isConvexId(t._id);
          const fired = relativeTime(t.last_run_at);
          return (
            <li key={t._id} className="group flex items-center gap-2 rounded px-1.5 py-1 hover:bg-sol-bg-alt" data-project-source={t._id}>
              {chat ? <Hash className="h-3.5 w-3.5 shrink-0 text-sol-cyan" /> : <Zap className="h-3.5 w-3.5 shrink-0 text-sol-yellow" />}
              <Link href={chat ? `/chat/${t.event_filter!.channel_id}` : `/triggers?task=${t._id}`} className={`min-w-0 flex-1 truncate text-[13px] hover:text-sol-cyan ${paused ? "text-sol-text-dim" : "text-sol-text"}`}>
                {name}
              </Link>
              {paused && (
                <span className="shrink-0 text-meta text-sol-orange" data-source-paused>{t.paused_by_project_id ? "Paused with project" : "Paused"}</span>
              )}
              <span className={`shrink-0 text-meta tabular-nums ${t.last_run_failed ? "text-sol-red" : "text-sol-text-dim"}`} title={t.last_run_failed ? t.last_run_summary : undefined} data-source-last-fired>
                {t.last_run_conversation_id && fired ? <Link href={`/conversation/${t.last_run_conversation_id}`} className="hover:text-sol-cyan">{fired}</Link> : fired ?? "Never fired"}
              </span>
              <span className="w-10 shrink-0 text-right text-meta tabular-nums text-sol-text-dim" title="Runs">{t.run_count}×</span>
              <button
                type="button"
                disabled={stub}
                onClick={() => useInboxStore.getState().triggerAction(t._id, paused ? "resume" : "pause")}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-sol-text-dim hover:text-sol-text disabled:opacity-40"
                aria-label={`${paused ? "Resume" : "Pause"} ${name}`}
                data-source-toggle
              >
                {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}{paused ? "Resume" : "Pause"}
              </button>
              <button
                type="button"
                disabled={stub}
                onClick={() => useInboxStore.getState().deleteTrigger(t._id)}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-meta text-sol-text-dim opacity-0 transition-opacity hover:text-sol-red focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-40"
                aria-label={`Remove ${name}`}
                data-source-remove
              >
                <Trash2 className="h-3 w-3" />Remove
              </button>
            </li>
          );
        })}
      </ul>
      <div className="mt-1.5 flex items-center gap-2 px-1.5" data-project-source-add>
        <SelectBox variant="bare" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Source to add" className="text-[13px]">
          <option value="">Add a channel or event</option>
          {channels.length > 0 && (
            <optgroup label="Channels">
              {channels.map((c) => <option key={c._id} value={`ch:${c._id}`} disabled={watched.has(String(c._id))}>#{c.name}</option>)}
            </optgroup>
          )}
          <optgroup label="Events">
            {EVENTS.map((n) => <option key={n} value={`ev:${n}`} disabled={watched.has(`event:${n}`)}>{triggerEventLabel(n)}</option>)}
          </optgroup>
        </SelectBox>
        <button
          type="button"
          disabled={!picked}
          onClick={() => setReviewing(true)}
          className="rounded border border-sol-border px-2 py-0.5 text-meta text-sol-text hover:border-sol-cyan hover:text-sol-cyan disabled:opacity-40"
          aria-haspopup="dialog"
          data-source-add
        >
          Add
        </button>
      </div>
      {reviewing && picked && (
        <SwitchReview
          ledger={sourceLedger({ source: picked.title, project: project.title, mainSession: mainTitle, channel: !!picked.channel_id })}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); add(); }}
        />
      )}
    </RecordSection>
  );
}
