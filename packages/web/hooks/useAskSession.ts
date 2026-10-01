// "Ask this session" state: the questions asked about a conversation and their
// answers, from the same server action as `cast read <id> --ask`.
//
// The questions and answers are ephemeral UI state, not synced server data:
// they live in a module map keyed by conversation, so switching sessions and
// back keeps them while the app is open, and an answer that lands after the
// panel closed is waiting when it reopens.
import { useSyncExternalStore } from "react";
import { useAction } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { AskResult } from "@codecast/shared/contracts";
import { askErrorMessage } from "../lib/askSession";

export type AskEntry = {
  id: number;
  question: string;
  started_at: number;
  result?: AskResult;
  error?: string;
};

// ── Ephemeral per-conversation thread ─────────────────────────────────────
const threads = new Map<string, AskEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: AskEntry[] = [];
let nextId = 1;

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function writeThread(conversationId: string, update: (entries: AskEntry[]) => AskEntry[]) {
  threads.set(conversationId, update(threads.get(conversationId) ?? EMPTY));
  listeners.forEach((l) => l());
}
export function useAskThread(conversationId: string): AskEntry[] {
  return useSyncExternalStore(subscribe, () => threads.get(conversationId) ?? EMPTY, () => EMPTY);
}

/** Ask a question about a conversation; the answer lands in its thread. */
export function useAskSession(conversationId: string) {
  const ask = useAction(api.sessionAsk.askFromWeb);
  return (question: string) => {
    const q = question.trim();
    if (!q) return;
    const id = nextId++;
    const patch = (p: Partial<AskEntry>) => writeThread(conversationId, (es) => es.map((e) => (e.id === id ? { ...e, ...p } : e)));
    writeThread(conversationId, (es) => [...es, { id, question: q, started_at: Date.now() }]);
    ask({ conversation_id: conversationId, question: q })
      .then((result) => patch({ result }))
      .catch((error) => patch({ error: askErrorMessage(error) }));
  };
}
