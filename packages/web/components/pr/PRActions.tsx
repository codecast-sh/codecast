import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CircleDot,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MoreHorizontal,
  Radio,
  RotateCcw,
  Send,
  Trash2,
  UserPlus,
  XCircle,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { accentVar } from "../../lib/externalEvents";
import { mergeStateMeta, notePlace, prStateKey, type CodeCommentRow } from "../../lib/prView";

// The verbs of a pull request, in codecast, reaching GitHub. Every one calls
// the same server function `cast pr` calls (prCli), so the page and the CLI
// cannot drift. A refusal comes back in GitHub's own words and is shown as is.

const api = _api as any;

type Verdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

const VERDICTS: { key: Verdict; label: string; hint: string; icon: typeof Check; accent: string }[] = [
  { key: "COMMENT", label: "Comment", hint: "Feedback without a verdict", icon: MessageSquare, accent: "blue" },
  { key: "APPROVE", label: "Approve", hint: "Good to merge", icon: Check, accent: "green" },
  { key: "REQUEST_CHANGES", label: "Request changes", hint: "Must change before it lands", icon: XCircle, accent: "red" },
];

/** What the server answered, or why it refused, as one toast. */
function report(result: any, done: string): boolean {
  if (result?.error) {
    toast.error(result.error);
    return false;
  }
  toast.success(done);
  return true;
}

/**
 * The review: what is waiting, the verdict, the summary, and where it goes.
 * "Submit" sends one GitHub review under the reader's own account. "Send to
 * session" hands the same notes to the shepherd as one message and keeps them
 * pending, so the agent can act first and GitHub can hear later.
 */
export function ReviewMenu({
  pr,
  notes,
  authorLogin,
  onNavigate,
  open,
  onOpenChange,
}: {
  pr: any;
  notes: CodeCommentRow[];
  authorLogin?: string;
  onNavigate: (note: CodeCommentRow) => void;
  /** Owned by the page, so a key can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const submit = useAction(api.reviews.submitPending);
  const hand = useMutation(api.reviews.handPendingToSession);
  const discard = useMutation(api.codeComments.discardPendingReview);
  const setOpen = onOpenChange;
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"submit" | "hand" | null>(null);

  const own = authorLogin && pr.author_github_username?.toLowerCase() === authorLogin.toLowerCase();
  const openPr = pr.state === "open";
  const count = notes.length;

  const run = async (kind: "submit" | "hand") => {
    setBusy(kind);
    try {
      if (kind === "submit") {
        const result = await submit({ pull_request_id: pr._id, event: verdict, body: body.trim() || undefined });
        if (report(result, count ? `Review sent with ${count} ${count === 1 ? "note" : "notes"}` : "Review sent")) {
          setBody("");
          setOpen(false);
        }
      } else {
        const result = await hand({ pull_request_id: pr._id });
        toast.success(`${result.sent} ${result.sent === 1 ? "note" : "notes"} sent to the session`);
        setOpen(false);
      }
    } catch (e: any) {
      toast.error(e?.message ?? "Something refused");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`pr-verb inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${count ? "" : "opacity-90"}`}
          title="Review this pull request (r)"
        >
          <CircleDot className="w-3.5 h-3.5" />
          {count ? `Review · ${count}` : "Review"}
          <ChevronDown className="w-3 h-3 opacity-70" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[380px] p-0 bg-sol-bg border-sol-border">
        <div className="px-3.5 pt-3 pb-2 border-b border-sol-border/50">
          <div className="text-[10px] uppercase tracking-wider text-sol-text-dim">Your review</div>
          {count === 0 ? (
            <p className="mt-1 text-[12px] text-sol-text-muted leading-relaxed">
              No notes yet. Open Files, choose a line, and write with <em>Add to review</em> on. Or leave a verdict alone.
            </p>
          ) : (
            <ul className="mt-1.5 max-h-40 overflow-y-auto space-y-1">
              {notes.map((note) => (
                <li key={note._id}>
                  <button
                    type="button"
                    className="w-full text-left flex items-baseline gap-2 rounded px-1 py-0.5 hover:bg-sol-bg-alt/60"
                    onClick={() => { setOpen(false); onNavigate(note); }}
                  >
                    <span className="font-mono text-[11px] text-sol-yellow shrink-0">{notePlace(note)}</span>
                    <span className="text-[12px] text-sol-text-muted truncate">{note.content}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="px-3.5 py-2.5 space-y-2.5">
          <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="Verdict">
            {VERDICTS.map(({ key, label, hint, icon: Icon, accent }) => {
              const disabled = key !== "COMMENT" && !!own;
              const active = verdict === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  title={disabled ? "GitHub does not let you judge your own pull request" : hint}
                  onClick={() => setVerdict(key)}
                  className={`flex flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition-colors disabled:opacity-40 ${
                    active ? "border-current" : "border-sol-border/50 hover:border-sol-border"
                  }`}
                  style={active ? { color: accentVar(accent as any), background: `color-mix(in srgb, ${accentVar(accent as any)} 10%, transparent)` } : undefined}
                >
                  <span className="flex items-center gap-1 text-[12px] font-medium">
                    <Icon className="w-3.5 h-3.5" />
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder={verdict === "APPROVE" ? "Anything to add? (optional)" : "Summary for the author"}
            className="w-full resize-none rounded-md border border-sol-border/60 bg-sol-bg-alt/40 px-2.5 py-2 text-[13px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan focus:outline-none"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!openPr || busy !== null}
              onClick={() => run("submit")}
              className="pr-verb inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium"
              title={openPr ? "One GitHub review, under your account" : "Only an open pull request takes a review"}
            >
              <Send className="w-3.5 h-3.5" />
              {busy === "submit" ? "Sending" : "Submit to GitHub"}
            </button>
            {pr.shepherd_conversation_id && count > 0 && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run("hand")}
                className="inline-flex items-center gap-1.5 rounded-md border border-sol-border/60 px-3 py-1.5 text-[12px] text-sol-text-muted hover:text-sol-text hover:border-sol-cyan/50 transition-colors"
                title="The notes go to the shepherd session as one message and stay pending here"
              >
                <Radio className="w-3.5 h-3.5" />
                {busy === "hand" ? "Sending" : "Send to session"}
              </button>
            )}
            {count > 0 && (
              <button
                type="button"
                className="ml-auto inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-red transition-colors"
                onClick={async () => {
                  await discard({ pull_request_id: pr._id });
                  toast.success("Notes discarded");
                }}
              >
                <Trash2 className="w-3 h-3" /> Discard
              </button>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type MergeMethod = "squash" | "merge" | "rebase";
const METHODS: { key: MergeMethod; label: string; hint: string }[] = [
  { key: "squash", label: "Squash and merge", hint: "One commit on the base branch" },
  { key: "merge", label: "Merge commit", hint: "Keep every commit, add a merge commit" },
  { key: "rebase", label: "Rebase and merge", hint: "Replay the commits on the base branch" },
];

/** Merge: the method is remembered on this device; the branch goes by default. */
export function MergeMenu({ pr }: { pr: any }) {
  const merge = useAction(api.prCli.merge);
  const [method, setMethod] = useState<MergeMethod>(() => (localStorage.getItem("pr.mergeMethod") as MergeMethod) || "squash");
  const [deleteBranch, setDeleteBranch] = useState(() => localStorage.getItem("pr.deleteBranch") !== "no");
  const [busy, setBusy] = useState(false);

  if (prStateKey(pr) !== "open") return null;
  const state = mergeStateMeta(pr);
  const blocked = pr.mergeable === false || pr.mergeable_state === "blocked" || pr.mergeable_state === "dirty";
  const reason = blocked ? state?.label : pr.checks_state === "pending" ? "Checks are still running" : undefined;

  const go = async () => {
    setBusy(true);
    try {
      const result = await merge({ repository: pr.repository, number: pr.number, method, delete_branch: deleteBranch });
      report(result, result?.branch_deleted ? `Merged, ${pr.head_ref} deleted` : "Merged");
    } catch (e: any) {
      toast.error(e?.message ?? "Merge refused");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-stretch rounded-full overflow-hidden border" style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 40%, transparent)" }}>
      <button
        type="button"
        disabled={busy || blocked}
        onClick={go}
        title={reason ? `${reason}. GitHub decides; try anyway from the menu.` : `${METHODS.find((m) => m.key === method)!.label}${deleteBranch ? ", then delete the branch" : ""}`}
        className="inline-flex items-center gap-1.5 px-3 py-1 text-[12px] font-medium text-sol-violet hover:bg-sol-violet/10 disabled:opacity-50 transition-colors"
      >
        <GitMerge className="w-3.5 h-3.5" />
        {busy ? "Merging" : "Merge"}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className="px-1.5 border-l text-sol-violet hover:bg-sol-violet/10 transition-colors" style={{ borderColor: "color-mix(in srgb, var(--sol-violet) 30%, transparent)" }} aria-label="Merge options">
            <ChevronDown className="w-3 h-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 bg-sol-bg border-sol-border">
          {METHODS.map((m) => (
            <DropdownMenuItem
              key={m.key}
              className="flex flex-col items-start gap-0 cursor-pointer"
              onClick={() => { setMethod(m.key); localStorage.setItem("pr.mergeMethod", m.key); }}
            >
              <span className="flex items-center gap-2 text-[12px] text-sol-text">
                {method === m.key ? <Check className="w-3 h-3 text-sol-cyan" /> : <span className="w-3" />}
                {m.label}
              </span>
              <span className="pl-5 text-[11px] text-sol-text-dim">{m.hint}</span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="bg-sol-border" />
          <DropdownMenuItem
            className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-text"
            onClick={() => { const next = !deleteBranch; setDeleteBranch(next); localStorage.setItem("pr.deleteBranch", next ? "yes" : "no"); }}
          >
            {deleteBranch ? <Check className="w-3 h-3 text-sol-cyan" /> : <span className="w-3" />}
            Delete {pr.head_ref ?? "the branch"} after merging
          </DropdownMenuItem>
          {blocked && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              <DropdownMenuItem className="cursor-pointer text-[12px] text-sol-text-muted" onClick={go}>
                Try to merge anyway
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** Everything else a pull request can have done to it, behind one button. */
export function MoreMenu({ pr }: { pr: any }) {
  const close = useAction(api.prCli.close);
  const reopen = useAction(api.prCli.reopen);
  const draft = useAction(api.prCli.draft);
  const reviewers = useAction(api.prCli.reviewers);
  const [asking, setAsking] = useState(false);
  const [login, setLogin] = useState("");
  const locator = { repository: pr.repository, number: pr.number };
  const state = prStateKey(pr);

  const act = async (fn: () => Promise<any>, done: string) => {
    try {
      report(await fn(), done);
    } catch (e: any) {
      toast.error(e?.message ?? "Refused");
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-full border border-sol-border/60 w-7 h-7 text-sol-text-muted hover:text-sol-text hover:border-sol-border transition-colors"
            aria-label="More actions"
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 bg-sol-bg border-sol-border">
          {(state === "open" || state === "draft") && (
            <DropdownMenuItem className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-text" onClick={() => setAsking(true)}>
              <UserPlus className="w-3.5 h-3.5 text-sol-text-dim" /> Request a review
            </DropdownMenuItem>
          )}
          {state === "open" && (
            <DropdownMenuItem
              className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-text"
              onClick={() => act(() => draft({ ...locator, draft: true }), "Back to draft")}
            >
              <GitPullRequestDraft className="w-3.5 h-3.5 text-sol-text-dim" /> Convert to draft
            </DropdownMenuItem>
          )}
          {state === "draft" && (
            <DropdownMenuItem
              className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-text"
              onClick={() => act(() => draft({ ...locator, draft: false }), "Ready for review")}
            >
              <CircleDot className="w-3.5 h-3.5 text-sol-green" /> Ready for review
            </DropdownMenuItem>
          )}
          {(state === "open" || state === "draft") && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              <DropdownMenuItem
                className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-red"
                onClick={() => act(() => close(locator), "Closed")}
              >
                <GitPullRequestClosed className="w-3.5 h-3.5" /> Close without merging
              </DropdownMenuItem>
            </>
          )}
          {state === "closed" && (
            <DropdownMenuItem
              className="flex items-center gap-2 cursor-pointer text-[12px] text-sol-text"
              onClick={() => act(() => reopen(locator), "Reopened")}
            >
              <RotateCcw className="w-3.5 h-3.5 text-sol-text-dim" /> Reopen
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator className="bg-sol-border" />
          <div className="px-2 py-1.5 text-[10px] text-sol-text-dim flex items-center gap-1.5">
            <KeyCap size="xs">r</KeyCap> review <KeyCap size="xs">n</KeyCap> <KeyCap size="xs">p</KeyCap> threads <KeyCap size="xs">m</KeyCap> viewed
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Popover open={asking} onOpenChange={setAsking}>
        <PopoverTrigger asChild><span /></PopoverTrigger>
        <PopoverContent align="end" className="w-72 bg-sol-bg border-sol-border">
          <form
            className="space-y-2"
            onSubmit={async (e) => {
              e.preventDefault();
              const who = login.trim().replace(/^@/, "");
              if (!who) return;
              await act(() => reviewers({ ...locator, add: [who] }), `Review requested from ${who}`);
              setLogin("");
              setAsking(false);
            }}
          >
            <div className="text-[10px] uppercase tracking-wider text-sol-text-dim">Request a review</div>
            <input
              autoFocus
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="GitHub login"
              className="w-full h-8 rounded-md border border-sol-border/60 bg-sol-bg-alt/40 px-2.5 font-mono text-[12px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan focus:outline-none"
            />
            <button type="submit" className="pr-verb rounded-md px-3 py-1.5 text-[12px] font-medium">Ask</button>
          </form>
        </PopoverContent>
      </Popover>
    </>
  );
}
