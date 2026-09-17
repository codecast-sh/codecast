// The hands a standing session started (org.handsStartedBy, scopes-and-feed.md
// F4.2): a per view query for the conversation on stage, not a registry feed.
// A wake card asks for the standing session's hands and keeps the ones whose
// start falls inside its own turn. Enrichment only: a wake card without its
// hands still renders the frame, so the query never throws into the view.
import { api as _api } from "@codecast/convex/convex/_generated/api";
import type { WorkState } from "@codecast/shared/contracts";
import { useQueryNoThrow } from "./useQueryNoThrow";

const api = _api as any;

export type HandStarted = {
  _id: string;
  short_id: string | null;
  title: string;
  state: WorkState;
  started_at: number;
  updated_at: number;
  task_short_id: string | null;
  state_line: string | null;
  state_status: string | null;
  state_at: number | null;
};

export function useHandsStartedBy(conversationId: string | null | undefined): HandStarted[] {
  const { data } = useQueryNoThrow(api.org.handsStartedBy, conversationId ? { conversation_id: conversationId } : "skip");
  return (data as HandStarted[] | undefined) ?? [];
}
