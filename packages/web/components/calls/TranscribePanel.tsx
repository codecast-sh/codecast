import { useMemo, useState, useSyncExternalStore } from "react";
import { Captions, CaptionsOff, Plus, X } from "lucide-react";
import { useConvex } from "convex/react";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  GAP_MS,
  getScribeStatus,
  startScribe,
  stopScribe,
  subscribeScribe,
} from "../../lib/calls/transcription";

// Transcription controls + live captions for the call dock. The person who
// toggles Transcribe becomes the scribe (their client streams every audio
// track to ASR); routes decide where the words land. Live routes deliver on
// conversation gaps — pointing one at an agent session makes the agent a
// participant that answers whenever the room pauses.

export type TranscriptRoute = {
  kind: "session" | "doc" | "slack";
  target: string;
  mode: "live" | "after";
  label: string;
};

export function TranscribeControls({ getRoom }: { getRoom: () => any }) {
  const convex = useConvex();
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [],
  }));
  const roomKey = useInboxStore((s) => s.call.roomKey);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [routes, setRoutes] = useState<TranscriptRoute[]>([]);

  const toggle = async () => {
    if (scribe.active) {
      await stopScribe();
      return;
    }
    const room = getRoom();
    if (!room || !roomKey) return;
    await startScribe({
      convex: convex as any,
      room,
      roomKey,
      routes: routes.map(({ label: _l, ...r }) => r),
    });
  };

  return (
    <span className="relative">
      <button
        onClick={() => (scribe.active ? void toggle() : setPickerOpen((o) => !o))}
        className={`rounded-md p-1.5 transition-colors ${
          scribe.active
            ? "bg-sol-green/15 text-sol-green"
            : "text-sol-text-muted hover:bg-sol-base02"
        }`}
        title={scribe.active ? "Stop transcribing" : "Transcribe this huddle"}
      >
        {scribe.active ? <Captions className="h-4 w-4" /> : <CaptionsOff className="h-4 w-4" />}
      </button>
      {pickerOpen && !scribe.active && (
        <RoutePicker
          routes={routes}
          onChange={setRoutes}
          onStart={() => {
            setPickerOpen(false);
            void toggle();
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </span>
  );
}

// Live caption strip for the expanded panel: the last few attributed lines,
// exactly what the scribe has heard.
export function CaptionStrip() {
  const scribe = useSyncExternalStore(subscribeScribe, getScribeStatus, () => ({
    active: false,
    transcriptId: null,
    trackCount: 0,
    error: null,
    tail: [] as Array<{ speaker: string; text: string }>,
  }));
  if (!scribe.active) return null;
  return (
    <div className="mb-2 rounded-md border border-sol-border/60 bg-sol-bg px-2 py-1.5">
      <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-sol-green">
        <Captions className="h-3 w-3" />
        transcribing · {scribe.trackCount} voice{scribe.trackCount === 1 ? "" : "s"}
      </div>
      {scribe.error && (
        <div className="mb-1 text-[11px] text-sol-orange">{scribe.error}</div>
      )}
      {scribe.tail.length === 0 ? (
        <div className="text-[11px] italic text-sol-text-dim">Listening…</div>
      ) : (
        <div className="space-y-0.5">
          {scribe.tail.slice(-3).map((s, i) => (
            <div key={i} className="text-[11px] leading-snug text-sol-text-muted">
              <span className="font-medium text-sol-text">{s.speaker.split(/\s+/)[0]}</span>: {s.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RoutePicker({
  routes,
  onChange,
  onStart,
  onClose,
}: {
  routes: TranscriptRoute[];
  onChange: (r: TranscriptRoute[]) => void;
  onStart: () => void;
  onClose: () => void;
}) {
  const s = useTrackedStore([
    (st: any) => st.currentSessionId,
    (st: any) => (st.chatRail ?? []).length,
  ]);
  // Workspace chokepoint, not a raw store enumeration — cached rows from
  // other workspaces must not surface as route targets.
  const wsDocs = useWorkspaceCollection<any>("docs");
  // Candidate targets, deliberately shallow: the current session, the most
  // recent sessions, recent docs. (Slack targets are linked channels; typing
  // the channel id is the v1 affordance.)
  const candidates = useMemo(() => {
    const st = useInboxStore.getState();
    const sessions = Object.values(st.sessions ?? {})
      .filter((x: any) => x && x.session_id && (x.message_count ?? 0) > 0)
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 5)
      .map((x: any) => ({
        kind: "session" as const,
        target: String(x.session_id ?? x._id),
        label: (x.title || "untitled session").slice(0, 40),
      }));
    const docs = wsDocs
      .slice()
      .sort((a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
      .slice(0, 4)
      .map((d: any) => ({
        kind: "doc" as const,
        target: String(d._id),
        label: (d.title || d.display_title || "untitled doc").slice(0, 40),
      }));
    return { sessions, docs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.currentSessionId, wsDocs]);
  const [slackChannel, setSlackChannel] = useState("");

  const add = (r: Omit<TranscriptRoute, "mode">) => {
    if (routes.some((x) => x.kind === r.kind && x.target === r.target)) return;
    onChange([...routes, { ...r, mode: "live" }]);
  };

  return (
    <div
      className="absolute bottom-full left-0 z-10 mb-2 w-[340px] rounded-lg border border-sol-border bg-sol-bg-alt p-2.5 shadow-xl"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[11px] font-medium text-sol-text-muted">
          Transcribe — send the words to…
        </span>
        <button onClick={onClose} className="rounded px-1 text-sol-text-dim hover:text-sol-text" title="Close">
          <X className="h-3 w-3" />
        </button>
      </div>

      {routes.length > 0 && (
        <div className="mb-2 space-y-1">
          {routes.map((r, i) => (
            <div key={`${r.kind}:${r.target}`} className="flex items-center gap-1.5 text-[11px]">
              <span className="rounded bg-sol-base02 px-1 text-[9px] uppercase text-sol-text-dim">{r.kind}</span>
              <span className="min-w-0 flex-1 truncate text-sol-text">{r.label}</span>
              <button
                onClick={() =>
                  onChange(routes.map((x, j) => (j === i ? { ...x, mode: x.mode === "live" ? "after" : "live" } : x)))
                }
                className={`rounded px-1.5 py-0.5 text-[9px] uppercase ${
                  r.mode === "live" ? "bg-sol-green/15 text-sol-green" : "bg-sol-base02 text-sol-text-muted"
                }`}
                title={
                  r.mode === "live"
                    ? `Delivers whenever the room goes quiet (~${GAP_MS / 1000}s gap) — a routed agent replies on the lull`
                    : "Delivers the whole transcript when you stop"
                }
              >
                {r.mode}
              </button>
              <button
                onClick={() => onChange(routes.filter((_, j) => j !== i))}
                className="rounded px-0.5 text-sol-text-dim hover:text-sol-red"
                title="Remove"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="max-h-[180px] space-y-1.5 overflow-y-auto">
        <div className="text-[9px] uppercase tracking-wide text-sol-text-dim">Agent sessions</div>
        {candidates.sessions.map((c: any) => (
          <button
            key={c.target}
            onClick={() => add(c)}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-sol-text-muted hover:bg-sol-base02 hover:text-sol-text"
          >
            <Plus className="h-3 w-3 shrink-0" />
            <span className="truncate">{c.label}</span>
          </button>
        ))}
        <div className="pt-1 text-[9px] uppercase tracking-wide text-sol-text-dim">Docs</div>
        {candidates.docs.map((c: any) => (
          <button
            key={c.target}
            onClick={() => add(c)}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-sol-text-muted hover:bg-sol-base02 hover:text-sol-text"
          >
            <Plus className="h-3 w-3 shrink-0" />
            <span className="truncate">{c.label}</span>
          </button>
        ))}
        <div className="pt-1 text-[9px] uppercase tracking-wide text-sol-text-dim">Slack channel id</div>
        <div className="flex gap-1">
          <input
            value={slackChannel}
            onChange={(e) => setSlackChannel(e.target.value)}
            placeholder="C0123456789 (linked channel)"
            className="min-w-0 flex-1 rounded border border-sol-border bg-sol-bg px-1.5 py-0.5 text-[11px] text-sol-text"
          />
          <button
            onClick={() => {
              const id = slackChannel.trim();
              if (!id) return;
              add({ kind: "slack", target: id, label: id });
              setSlackChannel("");
            }}
            className="rounded bg-sol-base02 px-2 text-[11px] text-sol-text-muted hover:text-sol-text"
          >
            add
          </button>
        </div>
      </div>

      <button
        onClick={onStart}
        className="mt-2 w-full rounded-md bg-sol-green/15 py-1.5 text-[12px] font-medium text-sol-green transition-colors hover:bg-sol-green/25"
      >
        Start transcribing{routes.length ? ` · ${routes.length} route${routes.length > 1 ? "s" : ""}` : ""}
      </button>
    </div>
  );
}
