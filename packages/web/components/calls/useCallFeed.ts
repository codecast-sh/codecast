import { useCallback } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  formatTranscriptChunk,
  isRecRoomKey,
  transcriptChunkHeader,
} from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { startTranscribing } from "../../lib/calls/callManager";
import type { PalettePickTarget, PalettePickResult } from "../../lib/palettePick";

// The two gestures that connect a huddle's words to the rest of the product:
//
//  - a LIVE FEED (route): the transcript keeps flowing to a session or doc on
//    every silence gap. Adding one auto-starts transcription when nobody is
//    scribing yet — feeding an agent must never require a separate
//    "transcribe" step first.
//  - a ONE-SHOT SEND: all or a section of an existing transcript handed to an
//    agent session once, over the same local-first rails the composer uses
//    (optimistic bubble, side panel opens immediately, agent replies inline).
//
// "New agent session" is the quick default target for both.

export type FeedTarget =
  | { kind: "new-session" }
  | { kind: "session"; id: string; label: string }
  | { kind: "new-doc" }
  | { kind: "doc"; id: string; label: string }
  | { kind: "slack"; id: string };

// Choosing a target is the command palette in pick mode (lib/palettePick.ts):
// title, optional instruction, the promoted "new" rows, then every session /
// doc the palette can already find. One vocabulary for both gestures.
export function openFeedTargetPicker(opts: {
  title: string;
  // "feed" (live) or "send" (one-shot) — picks the promoted rows' wording.
  gesture: "feed" | "send";
  // Offer an instruction to lead the excerpt with.
  withNote?: boolean;
  // Offer a Slack channel id typed into the search box.
  showSlack?: boolean;
  onPick: (t: FeedTarget, note?: string) => void;
}) {
  const feed = opts.gesture === "feed";
  useInboxStore.getState().openPalette({
    pick: {
      title: opts.title,
      kinds: ["session", "doc"],
      notePlaceholder: opts.withNote ? "Tell the agent what to do with it (optional)" : undefined,
      extras: [
        {
          key: "new-session",
          label: feed ? "Feed a new agent session" : "Send to a new agent session",
          description: "Spawns an agent that reads along and replies here",
          icon: "sparkles",
          primary: true,
        },
        ...(feed
          ? []
          : [{ key: "new-doc", label: "Save as a new doc", icon: "doc" as const }]),
        ...(opts.showSlack
          ? [{ key: "slack", label: "Feed the Slack channel id typed above", icon: "slack" as const, needsQuery: true }]
          : []),
      ],
      onPick: (t: PalettePickTarget, r: PalettePickResult) => {
        const target: FeedTarget | null =
          t.kind === "session" || t.kind === "doc"
            ? { kind: t.kind, id: t.id, label: t.label }
            : t.kind === "extra" && t.key === "slack"
              ? r.query ? { kind: "slack", id: r.query } : null
              : t.kind === "extra"
                ? ({ kind: t.key } as FeedTarget)
                : null;
        if (target) opts.onPick(target, r.note);
      },
    },
  });
}

export type TranscriptExcerpt = {
  segments: Array<{ speaker_name: string; text: string }>;
  title?: string | null;
  startedAt: number;
  live: boolean;
  partial: boolean;
};

// The most recent project the viewer worked in — a fresh call-spawned session
// should land where their work lives, not in $HOME.
function latestProjectPath(): { projectPath?: string; gitRoot?: string } {
  const st = useInboxStore.getState() as any;
  const rows = Object.values(st.sessions ?? {}) as any[];
  const recent = rows
    .filter((r) => r && (r.project_path || r.git_root))
    .sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))[0];
  return {
    projectPath: recent?.project_path ?? recent?.git_root,
    gitRoot: recent?.git_root ?? recent?.project_path,
  };
}

// Local-first "new session seeded with a message": stub + optimistic bubble +
// side panel now, durable create + send resolve behind it. Same lifecycle as
// ContextChatInput. Returns a promise of the real conversation id.
function spawnSessionWithMessage(body: string): Promise<string> {
  const store = useInboxStore.getState() as any;
  const { projectPath, gitRoot } = latestProjectPath();
  const { stubId } = store.beginOptimisticSession({
    agentType: "claude_code",
    projectPath,
    gitRoot,
    create: (sid: string) =>
      store.createSession({
        agent_type: "claude_code",
        project_path: projectPath,
        git_root: gitRoot,
        session_id: sid,
      }),
  });
  const clientId = store.addOptimisticMessage(stubId, body);
  store.openSidePanel(stubId);
  return (store.awaitConvexId(stubId) as Promise<string>).then((convexId: string) => {
    store.sendMessage(convexId, body, undefined, clientId);
    return convexId;
  });
}

export function excerptBody(excerpt: TranscriptExcerpt, note?: string): string {
  const header = transcriptChunkHeader({
    title: excerpt.title,
    startedAt: excerpt.startedAt,
    live: excerpt.live,
    partial: excerpt.partial,
  });
  const chunk = formatTranscriptChunk(excerpt.segments);
  const lead = (note ?? "").trim();
  return `${lead ? lead + "\n\n" : ""}${header}\n\n${chunk}`;
}

const DEFAULT_ASK =
  "Read this and help with what it implies — answer the open questions, pick up the action items, or continue the thinking.";

// One-shot: hand an excerpt to a target. Returns the conversation id for
// session targets (so callers can follow up), null otherwise.
export function useSendExcerpt() {
  return useCallback(async (target: FeedTarget, excerpt: TranscriptExcerpt, note?: string) => {
    const store = useInboxStore.getState() as any;
    if (target.kind === "session") {
      store.sendMessage(target.id, excerptBody(excerpt, note));
      store.openSidePanel(target.id);
      return target.id;
    }
    if (target.kind === "new-session") {
      const body = excerptBody(excerpt, note) + ((note ?? "").trim() ? "" : `\n\n${DEFAULT_ASK}`);
      return await spawnSessionWithMessage(body);
    }
    if (target.kind === "new-doc") {
      const when = new Date(excerpt.startedAt).toLocaleDateString([], {
        month: "short",
        day: "numeric",
      });
      await store.createDoc({
        title: excerpt.title ? `${excerpt.title} — huddle notes` : `Huddle notes · ${when}`,
        content: excerptBody(excerpt, note),
      });
      return null;
    }
    return null;
  }, []);
}

// Live feed: point the flowing words at a target. If nobody is scribing yet,
// the caller becomes the scribe — one gesture, no separate transcribe toggle.
export function useAddLiveFeed(opts: {
  roomKey: string | null;
  liveTranscriptId: string | null;
  getRoom: () => any;
}) {
  const convex = useConvex();
  const { roomKey, liveTranscriptId, getRoom } = opts;

  return useCallback(
    async (target: FeedTarget) => {
      if (!roomKey) return;
      let route: { kind: "session" | "doc" | "slack"; target: string } | null = null;
      if (target.kind === "session") route = { kind: "session", target: target.id };
      else if (target.kind === "doc") route = { kind: "doc", target: target.id };
      else if (target.kind === "slack") route = { kind: "slack", target: target.id };
      else if (target.kind === "new-session") {
        const st = useInboxStore.getState() as any;
        const label = st.call?.roomKey === roomKey ? "this huddle" : "a huddle";
        const convexId = await spawnSessionWithMessage(
          `You're being attached to a live team huddle (${label}). Attributed transcript chunks will arrive here whenever the room pauses. Follow along and reply with anything genuinely useful — answers to questions raised, relevant context, pushback. Keep replies short; the room is mid-conversation.`,
        );
        route = { kind: "session", target: convexId };
      }
      if (!route) return;

      // Attach the route; if the transcript ended between paint and click but
      // the room is still up, fall back to becoming the scribe with the same
      // route (same gesture, fresh transcript).
      const attach = async () => {
        if (liveTranscriptId) {
          try {
            await convex.mutation(api.transcripts.addRoute, {
              transcript_id: liveTranscriptId as any,
              kind: route.kind,
              target: route.target,
              mode: "live",
            });
            return;
          } catch (err) {
            if (!String(err).includes("ended")) throw err;
          }
        }
        const room = getRoom();
        if (!room) {
          // A recording has no room to fall back into: its transcript IS the
          // run, so when that ended there is nothing left to point words at.
          throw new Error(
            isRecRoomKey(roomKey)
              ? "That recording has ended — its words are already saved"
              : "Join the huddle to start its transcription",
          );
        }
        if (!(await startTranscribing(roomKey, [{ ...route, mode: "live" }]))) {
          throw new Error("Somebody else is transcribing this huddle — pick the feed again once their words show here");
        }
      };
      try {
        await attach();
      } catch (err) {
        // The new-session path spawns the agent BEFORE the route attaches; a
        // refusal must not leave that session waiting forever for words that
        // will never come.
        if (target.kind === "new-session") {
          (useInboxStore.getState() as any).sendMessage(
            route.target,
            "The huddle feed could not be attached — no transcript will arrive. Disregard the briefing above.",
          );
        }
        throw err;
      }
    },
    [convex, roomKey, liveTranscriptId, getRoom],
  );
}

export function useRemoveLiveFeed(liveTranscriptId: string | null) {
  const convex = useConvex();
  return useCallback(
    async (kind: string, target: string) => {
      if (!liveTranscriptId) return;
      await convex.mutation(api.transcripts.removeRoute, {
        transcript_id: liveTranscriptId as any,
        kind,
        target,
      });
    },
    [convex, liveTranscriptId],
  );
}
