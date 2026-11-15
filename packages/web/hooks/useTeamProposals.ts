// The state side of team proposals (components/conversation/teamProposals.tsx
// draws them): which side of a proposal this view is on, and the rows for it.
import { createContext, useContext } from "react";
import { toast } from "sonner";
import { useInboxStore } from "../store/inboxStore";
import { useSessionSuggestions } from "./useGuestSuggestions";
import { serverErrorText } from "../lib/errorCause";

export type TeamProposalRole = { conversationId: string; role: "owner" | "teammate"; ownerName: string } | null;

export const TeamProposalContext = createContext<TeamProposalRole>(null);
export const useTeamProposalRole = () => useContext(TeamProposalContext);

/** Send a proposal; a refusal takes the painted row back and says why. */
export function proposeOrExplain(pending: Promise<unknown>, clientKey: string, conversationId: string) {
  pending.catch((e) => {
    useInboxStore.getState().withdrawTeamSuggestion(clientKey, conversationId);
    toast.error(serverErrorText(e));
  });
}

export const newProposalKey = () => `prop_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;

export function useMyName(): string {
  return useInboxStore((s) => {
    const u: any = s.currentUser;
    return u?.name || u?.github_username || u?.email?.split("@")[0] || "A teammate";
  });
}

/** Owner: the teammates' waiting proposals for one row (a question or a permission). */
export function useProposalsFor(match: (r: any) => boolean): any[] {
  const ctx = useTeamProposalRole();
  const rows = useSessionSuggestions(ctx?.conversationId ?? "", null);
  return ctx?.role === "owner" ? rows.filter((r) => r.status === "pending" && match(r)) : [];
}

/** My latest proposal on one row, in whatever state it is in. */
export function useMyProposalFor(match: (r: any) => boolean): any | null {
  const ctx = useTeamProposalRole();
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const rows = useSessionSuggestions(ctx?.conversationId ?? "", meId);
  const mine = rows.filter(match);
  return mine[mine.length - 1] ?? null;
}
