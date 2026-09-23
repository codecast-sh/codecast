import { useCallback, useMemo } from "react";
import { useConvex } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import {
  ACTIVE_AGENT_STATUSES,
  formatTranscriptChunk,
  huddleFeedBriefing,
  isRecRoomKey,
  transcriptChunkHeader,
} from "@codecast/shared/contracts";
import { AVATAR_KEYS } from "@codecast/shared/contracts/orgAvatars";
import { characterNameFor, defaultCharacterFor, type Character } from "@codecast/shared/contracts/sessionCharacter";
import { useInboxStore, useTrackedStore } from "../../store/inboxStore";
import { startTranscribing } from "../../lib/calls/callManager";
import { agentRoomName, findSessionRow } from "../../lib/calls/findSessionRow";
import { characterFor, identitySig } from "../../lib/sessionIdentity";
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
      confirmLabel: feed ? "Add" : "Send",
      extras: [
        {
          key: "new-session",
          label: feed ? "A new agent session" : "Send to a new agent session",
          description: feed
            ? "Hears the room and answers here"
            : "Spawns an agent that reads along and replies here",
          icon: "sparkles",
          primary: true,
        },
        ...(feed
          ? []
          : [{ key: "new-doc", label: "Save as a new doc", icon: "doc" as const }]),
        ...(opts.showSlack
          ? [{ key: "slack", label: "The Slack channel id typed above", icon: "slack" as const, needsQuery: true }]
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
//
// `body` may be written for the stub (a huddle briefing names the character
// the session will wear, decided from the stub id), and `onReady` runs with
// the real id before the message is sent, so a write the briefing promises
// (that character) lands before the agent reads it.
function spawnSessionWithMessage(
  body: string | ((stubId: string) => string),
  onReady?: (convexId: string) => void,
): Promise<string> {
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
  const text = typeof body === "function" ? body(stubId) : body;
  const clientId = store.addOptimisticMessage(stubId, text);
  store.openSidePanel(stubId);
  return (store.awaitConvexId(stubId) as Promise<string>).then((convexId: string) => {
    onReady?.(convexId);
    store.sendMessage(convexId, text, undefined, clientId);
    return convexId;
  });
}

/** The character a session spawned FOR a huddle wears (session-characters.md
 *  S1): the hash default for `seed`, unless an agent already in the room
 *  wears that face or that name, in which case the next free face and its
 *  name. Two agents called Ember in one room would answer each other's asks.
 *  Written as a CHOSEN character (the seed is the stub, not the row's final
 *  id), so the room's name for it holds on every surface. */
export function characterForRoom(seed: string, taken: Character[]): Character {
  const clash = (c: { avatar: string; name: string }) =>
    taken.some((t) => t.avatar === c.avatar || t.name.toLowerCase() === c.name.toLowerCase());
  const own = defaultCharacterFor(seed);
  if (!clash(own)) return { ...own, chosen: true };
  const start = AVATAR_KEYS.indexOf(own.avatar);
  for (let i = 1; i < AVATAR_KEYS.length; i++) {
    const avatar = AVATAR_KEYS[(start + i) % AVATAR_KEYS.length];
    const c = { avatar, name: characterNameFor(seed, avatar) };
    if (!clash(c)) return { ...c, chosen: true };
  }
  return { ...own, chosen: true };
}

/** The characters of the agents a live transcript already feeds, read from
 *  the store, so a newcomer can avoid their faces and names. */
function charactersInRoom(routes: Array<{ kind: string; target: string }>): Character[] {
  const st = useInboxStore.getState() as any;
  return routes
    .filter((r) => r.kind === "session")
    .map((r) => findSessionRow(st, r.target))
    .filter(Boolean)
    .map((row) => characterFor(row));
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
        title: excerpt.title ? `${excerpt.title} · huddle notes` : `Huddle notes · ${when}`,
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
  /** The live transcript's routes, so a session spawned for the room takes a
   *  character no agent already in it wears. */
  routes?: Array<{ kind: string; target: string }>;
  getRoom: () => any;
}) {
  const convex = useConvex();
  const { roomKey, liveTranscriptId, routes, getRoom } = opts;

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
        // The session's character is the name the room says to address it
        // and the name beside its lines in the chat, so it is chosen the
        // moment the id exists and named in the briefing the agent reads
        // first. The stub's bubble shows the stub's own default; the sent
        // message names the real one.
        let character: Character | null = null;
        const convexId = await spawnSessionWithMessage(
          (stubId) => {
            character = characterForRoom(stubId, charactersInRoom(routes ?? []));
            return huddleFeedBriefing({ name: character.name, label });
          },
          (id) => {
            if (character) st.setSessionCharacter(id, { avatar: character.avatar, name: character.name });
          },
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
              ? "That recording has ended. Its words are already saved."
              : "Join the huddle to start its transcription",
          );
        }
        if (!(await startTranscribing(roomKey, [{ ...route, mode: "live" }]))) {
          throw new Error("Somebody else is transcribing this huddle. Pick the feed again once their words show here.");
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
            "The huddle feed could not be attached, so no transcript will arrive. Disregard the briefing above.",
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

// ── The agents in the room ─────────────────────────────────────────────────

export type AgentInRoom = {
  id: string;
  target: string;
  addedBy: string;
  /** What the room calls it: its character (agentRoomName). */
  name: string;
  agentType: string;
  working: boolean;
  /** The store row, for its face; null until the row lands. */
  row: any | null;
};

/** The sessions the live transcript feeds, as participants: name, kind, and
 *  whether one is mid-turn. Read from the store's session rows, subscribed
 *  through a signature of the fields shown so the thread's header and the
 *  stage's button do not re-render on every heartbeat of every session. */
export function useAgentsInRoom(routes: Array<{ kind: string; target: string; added_by: string }>): AgentInRoom[] {
  const targets = routes.filter((r) => r.kind === "session");
  const sig = targets.map((r) => r.target).join("|");
  const s = useTrackedStore([
    (st: any) =>
      targets
        .map((r) => {
          const row = findSessionRow(st, r.target);
          return row ? `${identitySig(row)}:${row.title ?? ""}:${row.agent_type ?? ""}:${row.agent_status ?? ""}` : r.target;
        })
        .join("|"),
  ]);
  return useMemo(
    () =>
      targets.map((r) => {
        const row = findSessionRow(s, r.target);
        return {
          id: String(row?._id ?? r.target),
          target: r.target,
          addedBy: r.added_by,
          name: (row ? agentRoomName(row) : "new agent").slice(0, 40),
          agentType: row?.agent_type ?? "claude_code",
          working: ACTIVE_AGENT_STATUSES.has(row?.agent_status ?? ""),
          row,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sig stands in for the routes list
    [sig, s],
  );
}
