// Proposed answers on a session's open questions and permission prompts
// (convex teamSuggestions.ts). A teammate's press on a question card or a
// permission row becomes a proposal; the owner sees each one on that card and
// submits it in one press. The view says which side of that it is on.
import { createContext, useContext } from "react";
import { Check, Lightbulb, Send, X } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useSessionSuggestions } from "../../hooks/useGuestSuggestions";
import { proposalText } from "../../lib/steering";
import { AvatarImg } from "../../lib/avatarCache";
import { toast } from "sonner";
import { serverErrorText } from "../../lib/errorCause";
import { teamMembersOf } from "../../lib/activeTeam";

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

const firstName = (n: string) => n.split(/\s+/)[0] || n;

function AuthorFace({ authorId, name }: { authorId?: string | null; name: string }) {
  const image = useInboxStore((s) => {
    if (!authorId) return undefined;
    const m = teamMembersOf(s).find((x: any) => String(x?._id) === String(authorId));
    return m?.image || m?.github_avatar_url || undefined;
  });
  return (
    <AvatarImg
      src={image}
      alt={name}
      className="w-5 h-5 rounded-full shrink-0 object-cover"
      fallback={<div className="w-5 h-5 rounded-full shrink-0 grid place-items-center bg-sol-violet/20 text-sol-violet text-meta font-semibold">{(name || "?").charAt(0).toUpperCase()}</div>}
    />
  );
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

/** Owner: proposed answers under an open question card, each one press to send. */
export function AnswerProposals({ toolUseId, onSending, onNotSent }: { toolUseId: string; onSending?: () => void; onNotSent?: () => void }) {
  const rows = useProposalsFor((r) => r.kind === "answer" && r.tool_use_id === toolUseId);
  const send = useInboxStore((s) => s.sendGuestSuggestion);
  const dismiss = useInboxStore((s) => s.dismissGuestSuggestion);
  if (rows.length === 0) return null;
  return (
    <div data-answer-proposals className="mb-3 space-y-1.5">
      {rows.map((r) => (
        <div key={r._id} className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-sol-violet/30 bg-sol-violet/10">
          <AuthorFace authorId={r.author_user_id} name={r.guest_name} />
          <span className="text-meta text-sol-violet font-semibold shrink-0">{firstName(r.guest_name)}</span>
          <span className="flex-1 min-w-0 text-xs text-sol-text whitespace-pre-wrap break-words max-h-24 overflow-y-auto">{proposalText(r.body)}</span>
          <button
            onClick={() => {
              // The card closes on the press, so it cannot send a second
              // answer during the round trip; it reopens if this one did not go.
              onSending?.();
              void send(r._id).then((res: any) => { if (res?.status !== "sent") onNotSent?.(); }).catch(() => onNotSent?.());
            }}
            className="shrink-0 h-7 px-3 rounded-full text-xs font-medium border border-sol-green/50 bg-sol-green/20 text-sol-green hover:bg-sol-green/30 transition-colors inline-flex items-center gap-1"
          ><Send className="w-3 h-3" />Send</button>
          <button
            onClick={() => dismiss(r._id)}
            aria-label={`Dismiss ${r.guest_name}'s answer`}
            className="shrink-0 h-7 w-7 grid place-items-center rounded-full border border-sol-border text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
          ><X className="w-3 h-3" /></button>
        </div>
      ))}
    </div>
  );
}

/** Teammate: what became of my proposal on a row. */
export function MyProposalStatus({ row, onWithdraw }: { row: any | null; onWithdraw?: () => void }) {
  const ctx = useTeamProposalRole();
  if (!row || !ctx) return null;
  const owner = firstName(ctx.ownerName);
  const state = row.status === "pending"
    ? { icon: <Lightbulb className="w-3 h-3" />, tone: "text-sol-violet", label: `Proposed to ${owner}` }
    : row.status === "sent"
    ? { icon: <Check className="w-3 h-3" />, tone: "text-sol-green", label: `${owner} went with it` }
    : row.status === "closed"
    ? { icon: <X className="w-3 h-3" />, tone: "text-sol-text-dim", label: "Closed" }
    : { icon: <X className="w-3 h-3" />, tone: "text-sol-text-dim", label: `${owner} passed` };
  return (
    <div data-my-proposal={row.status} className="mb-3 flex items-center gap-2 text-meta">
      <span className={`shrink-0 inline-flex items-center gap-1 font-medium ${state.tone}`}>{state.icon}{state.label}</span>
      <span className="flex-1 min-w-0 truncate text-sol-text-muted">{proposalText(row.body)}</span>
      {row.status === "pending" && onWithdraw && (
        <button onClick={onWithdraw} className="shrink-0 h-6 px-2.5 rounded-full font-medium border border-sol-border text-sol-text-dim hover:text-sol-text transition-colors">Withdraw</button>
      )}
    </div>
  );
}

/** Teammate: the session's pending permissions, each with a proposed answer for the owner. */
export function TeammatePermissions({ permissions }: { permissions: Array<{ _id: string; tool_name: string; arguments_preview?: string }> }) {
  const ctx = useTeamProposalRole();
  const propose = useInboxStore((s) => s.proposePermission);
  const me = useMyName();
  if (!ctx || permissions.length === 0) return null;
  return (
    <div data-teammate-permissions className="space-y-1.5">
      {permissions.map((p) => (
        <TeammatePermissionRow key={p._id} permission={p} onPropose={(d) => { const key = newProposalKey(); proposeOrExplain(propose(ctx.conversationId, p._id, d, key, me), key, ctx.conversationId); }} />
      ))}
    </div>
  );
}

function TeammatePermissionRow({ permission, onPropose }: { permission: { _id: string; tool_name: string; arguments_preview?: string }; onPropose: (d: "approved" | "denied") => void }) {
  const ctx = useTeamProposalRole()!;
  const mine = useMyProposalFor((r) => r.kind === "permission" && String(r.permission_id) === String(permission._id));
  const withdraw = useInboxStore((s) => s.withdrawTeamSuggestion);
  const picked = mine?.status === "pending" ? mine.decision : null;
  const pick = (d: "approved" | "denied") => (picked === d ? withdraw(mine._id, ctx.conversationId) : onPropose(d));
  return (
    <div className="rounded border border-sol-yellow/20 bg-sol-yellow/[0.03] px-2.5 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow flex-shrink-0" />
        <span className="text-meta font-semibold font-mono text-sol-text-muted shrink-0">{permission.tool_name}</span>
        <span className="flex-1 min-w-0 truncate text-meta font-mono text-sol-text-dim" title={permission.arguments_preview}>{permission.arguments_preview}</span>
        <span className="shrink-0 text-meta text-sol-text-dim">Waiting on {firstName(ctx.ownerName)}</span>
        <button
          onClick={() => pick("approved")}
          aria-pressed={picked === "approved"}
          className={`shrink-0 px-2.5 py-0.5 text-meta font-medium rounded border transition-colors ${picked === "approved" ? "border-sol-green bg-sol-green/20 text-sol-green" : "border-sol-green/40 text-sol-green hover:bg-sol-green/15"}`}
        >{picked === "approved" && <Check className="inline w-3 h-3 mr-0.5 -mt-px" />}Suggest allow</button>
        <button
          onClick={() => pick("denied")}
          aria-pressed={picked === "denied"}
          className={`shrink-0 px-2.5 py-0.5 text-meta font-medium rounded border transition-colors ${picked === "denied" ? "border-sol-red bg-sol-red/15 text-sol-red" : "border-sol-border/60 text-sol-text-dim hover:text-sol-red hover:border-sol-red/40"}`}
        >{picked === "denied" && <Check className="inline w-3 h-3 mr-0.5 -mt-px" />}Suggest deny</button>
      </div>
    </div>
  );
}

/** Owner: teammates' proposed answers on the pending permissions, one press each. */
export function PermissionProposals({ permissions }: { permissions: Array<{ _id: string; tool_name: string; arguments_preview?: string }> }) {
  const ids = new Set(permissions.map((p) => String(p._id)));
  const rows = useProposalsFor((r) => r.kind === "permission" && ids.has(String(r.permission_id)));
  const resolve = useInboxStore((s) => s.resolvePermission);
  const dismiss = useInboxStore((s) => s.dismissGuestSuggestion);
  if (rows.length === 0) return null;
  const promptOf = (id: string) => permissions.find((p) => String(p._id) === id);
  return (
    <div data-permission-proposals className="mb-1.5 space-y-1">
      {rows.map((r) => {
        const allow = r.decision === "approved";
        const prompt = promptOf(String(r.permission_id));
        return (
          <div key={r._id} className="flex items-center gap-2 px-2.5 py-1 rounded-lg border border-sol-violet/30 bg-sol-violet/10">
            <AuthorFace authorId={r.author_user_id} name={r.guest_name} />
            <span className="text-meta text-sol-text min-w-0 truncate flex-1">
              <b className="text-sol-violet">{firstName(r.guest_name)}</b> suggests {allow ? "allowing" : "denying"} <span className="font-mono text-sol-text-muted" title={prompt?.arguments_preview}>{prompt?.tool_name} {prompt?.arguments_preview}</span>
            </span>
            <button
              onClick={() => resolve(String(r.permission_id), allow ? "approved" : "denied")}
              className={`shrink-0 px-2.5 py-0.5 text-meta font-medium rounded border transition-colors ${allow ? "border-sol-green/50 bg-sol-green/20 text-sol-green hover:bg-sol-green/30" : "border-sol-red/40 bg-sol-red/10 text-sol-red hover:bg-sol-red/20"}`}
            >{allow ? "Approve" : "Deny"}</button>
            <button
              onClick={() => dismiss(r._id)}
              aria-label={`Dismiss ${r.guest_name}'s suggestion`}
              className="shrink-0 h-6 w-6 grid place-items-center rounded-full border border-sol-border text-sol-text-muted hover:bg-sol-bg-alt transition-colors"
            ><X className="w-3 h-3" /></button>
          </div>
        );
      })}
    </div>
  );
}
