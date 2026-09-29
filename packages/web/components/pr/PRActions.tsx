import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  CircleDot,
  GitBranch,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Radio,
  RotateCcw,
  Send,
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
import { formatAcceleratorParts } from "../../shortcuts";
import { ConfirmButton } from "../integrations/parts";
import { CodeMenuItem, CodeShareItems } from "../menus/CodeShareItems";
import { copyText } from "../../lib/copyText";
import { sharePageUrl } from "../../lib/utils";
import { useInboxStore } from "../../store/inboxStore";
import { accentVar } from "../../lib/externalEvents";
import { mergeStateMeta, notePlace, prStateKey, type CodeCommentRow } from "../../lib/prView";
import { prPageHref, toStandaloneHref } from "../../lib/repoView";
import { useRepoFamily, useRepoLocation } from "../repo/useRepoFamily";

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

/** The submit button says what it will do. */
const SUBMIT_LABEL: Record<Verdict, string> = {
  COMMENT: "Submit review",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
};

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
  sessionChoices = [],
  openThreads = 0,
  onWalk,
  placement = "header",
}: {
  pr: any;
  notes: CodeCommentRow[];
  authorLogin?: string;
  onNavigate: (note: CodeCommentRow) => void;
  /** Owned by the page, so a key can open it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sessions the notes can go to when no shepherd is bound. */
  sessionChoices?: { id: string; title: string }[];
  /** Open threads on the pull request, and the jump to the first: where a review starts. */
  openThreads?: number;
  onWalk?: () => void;
  /** "bar" is the review bar pinned to the bottom of the page: a plain
   *  button that opens the review upward, above itself. */
  placement?: "header" | "bar";
}) {
  const submit = useAction(api.reviews.submitPending);
  const hand = useMutation(api.reviews.handPendingToSession);
  const discard = useMutation(api.codeComments.discardPendingReview);
  const setOpen = onOpenChange;
  const [verdict, setVerdict] = useState<Verdict>("COMMENT");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"submit" | "hand" | null>(null);
  const [picking, setPicking] = useState(false);
  const shepherd = pr.shepherd_conversation_id as string | undefined;

  const own = authorLogin && pr.author_github_username?.toLowerCase() === authorLogin.toLowerCase();
  const openPr = pr.state === "open";
  const count = notes.length;

  const run = async (kind: "submit" | "hand", conversationRef?: string) => {
    setBusy(kind);
    try {
      if (kind === "submit") {
        const result = await submit({ pull_request_id: pr._id, event: verdict, body: body.trim() || undefined });
        const withNotes = count ? ` with ${count} ${count === 1 ? "note" : "notes"}` : "";
        const toSession = result?.delivered_to?.short_id ? `, delivered to session ${result.delivered_to.short_id}` : "";
        if (report(result, `Review sent${withNotes}${toSession}`)) {
          setBody("");
          setOpen(false);
        }
      } else {
        const result = await hand({ pull_request_id: pr._id, conversation_ref: conversationRef });
        toast.success(`${result.sent} ${result.sent === 1 ? "note" : "notes"} sent to the session`);
        setPicking(false);
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
        {placement === "bar" ? (
          <button
            type="button"
            className="pr-verb inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors"
            title="Choose a verdict and send your notes (r)"
          >
            <Send className="w-3.5 h-3.5" />
            Finish review
            <KeyCap size="xs">r</KeyCap>
          </button>
        ) : (
          <button
            type="button"
            className={`pr-verb inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium transition-colors ${count ? "" : "opacity-90"}`}
            title={count ? `${count} ${count === 1 ? "note" : "notes"} waiting in your review (r)` : "Review this pull request (r)"}
          >
            <CircleDot className="w-3.5 h-3.5" />
            {count ? `Review · ${count}` : "Review"}
            <ChevronDown className="w-3 h-3 opacity-70" />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side={placement === "bar" ? "top" : "bottom"}
        sideOffset={8}
        className="w-[480px] p-0 overflow-hidden bg-sol-bg border-sol-border"
      >
        {/* What is waiting: the notes, each a way back to its line. */}
        <div className="px-4 pt-3.5 pb-3 border-b border-sol-border/50">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[13px] font-medium text-sol-text">{count ? "Finish your review" : "Review"}</h3>
            {count > 0 && (
              <span className="ml-auto text-[11px] text-sol-text-dim tabular-nums">
                {count} {count === 1 ? "note" : "notes"}
              </span>
            )}
          </div>
          {count === 0 ? (
            <div className="mt-1.5 space-y-2">
              <p className="text-[12px] text-sol-text-muted leading-relaxed">
                No notes yet. In Files, hover a line and press <span className="font-mono text-sol-blue">+</span> to write one, or give a verdict on its own.
              </p>
              {!!openThreads && onWalk && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-full bg-sol-cyan/10 px-2.5 py-1 text-[11px] text-sol-cyan hover:bg-sol-cyan/20 transition-colors"
                  onClick={() => { setOpen(false); onWalk(); }}
                >
                  Start with the {openThreads} open {openThreads === 1 ? "thread" : "threads"}
                  <KeyCap size="xs">n</KeyCap>
                </button>
              )}
            </div>
          ) : (
            <ul className="mt-2 -mx-1.5 max-h-60 overflow-y-auto">
              {notes.map((note) => (
                <li key={note._id}>
                  <button
                    type="button"
                    className="w-full text-left flex items-baseline gap-2.5 rounded-md px-1.5 py-1 hover:bg-sol-bg-alt/60 transition-colors"
                    onClick={() => { setOpen(false); onNavigate(note); }}
                    title="Show this note on its line"
                  >
                    <span className="font-mono text-[11px] text-sol-text-dim shrink-0">{notePlace(note)}</span>
                    <span className="text-[12px] text-sol-text truncate">{note.content}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* What to tell the author comes first and gets the room; the
            verdict is a small choice beside the send. */}
        <div className="px-4 pt-3 pb-3 space-y-2.5">
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && openPr && busy === null) {
                e.preventDefault();
                run("submit");
              }
            }}
            rows={6}
            placeholder={count ? "Anything else for the author?" : "Leave a review comment"}
            className="w-full resize-y min-h-[8rem] rounded-lg border border-sol-border/70 bg-sol-bg-alt/40 px-3 py-2.5 text-[13px] leading-relaxed text-sol-text placeholder:text-sol-text-dim focus:border-sol-cyan focus:outline-none"
          />
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Verdict">
            {VERDICTS.map(({ key, label, hint, icon: Icon, accent }) => {
              const disabled = key !== "COMMENT" && !!own;
              const active = verdict === key;
              const color = accentVar(accent as any);
              return (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  title={disabled ? "It is your pull request: GitHub takes a comment from you, not a verdict" : hint}
                  onClick={() => setVerdict(key)}
                  className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors disabled:opacity-35 ${
                    active ? "" : "border-sol-border/60 text-sol-text-muted hover:text-sol-text hover:border-sol-border"
                  }`}
                  style={active ? { color, borderColor: color, background: `color-mix(in srgb, ${color} 12%, transparent)` } : undefined}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              );
            })}
          </div>
          {picking && !shepherd && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-sol-text-dim">Send the notes to</span>
              {sessionChoices.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => run("hand", session.id)}
                  className="rounded-full border border-sol-border/50 px-2 py-0.5 text-[11px] text-sol-text-muted hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors max-w-[220px] truncate"
                >
                  {session.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-sol-border/50 bg-sol-bg-alt/30">
          <div className="flex items-center gap-3">
            {count > 0 && (
              <ConfirmButton
                label="Discard"
                question={`${count} ${count === 1 ? "note is" : "notes are"} thrown away.`}
                onConfirm={() => {
                  void discard({ pull_request_id: pr._id }).then(() => toast.success("Notes discarded"));
                }}
              />
            )}
            {count > 0 && (shepherd || sessionChoices.length > 0) && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => (shepherd ? run("hand") : setPicking((v) => !v))}
                className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-sol-text-muted hover:text-sol-text transition-colors"
                title={shepherd ? "The agent session watching this pull request gets the notes as one message; nothing goes to GitHub, and the notes stay here" : "Pick a linked session to send the notes to; nothing goes to GitHub"}
              >
                <Radio className="w-3.5 h-3.5" />
                {busy === "hand" ? "Sending" : "Send to session"}
              </button>
            )}
            <button
              type="button"
              disabled={!openPr || busy !== null}
              onClick={() => run("submit")}
              className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-[12px] font-medium text-sol-bg transition-opacity hover:opacity-90 disabled:opacity-40"
              style={{ background: accentVar((VERDICTS.find((v) => v.key === verdict)?.accent ?? "blue") as any) }}
              title={
                !openPr ? "Only an open pull request takes a review"
                : "One review on GitHub, under your account, with your notes on their lines"
              }
            >
              <Send className="w-3.5 h-3.5" />
              {busy === "submit" ? "Sending" : SUBMIT_LABEL[verdict]}
              {openPr && formatAcceleratorParts("meta+enter").map((part) => <KeyCap key={part} size="xs">{part}</KeyCap>)}
            </button>
          </div>
          {!openPr && (
            <p className="mt-1.5 text-[11px] text-sol-text-dim">
              This pull request is {pr.state === "merged" ? "merged" : "closed"}, so GitHub takes no more reviews.
            </p>
          )}
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
  // The method and the branch choice follow the person, through the same
  // synced preference bag as every other reading habit.
  const method: MergeMethod = useInboxStore((s) => s.clientState.ui?.pr_merge_method) ?? "squash";
  const deleteBranch = useInboxStore((s) => s.clientState.ui?.pr_delete_branch) ?? true;
  const setMethod = (next: MergeMethod) => useInboxStore.getState().updateClientUI({ pr_merge_method: next });
  const setDeleteBranch = (next: boolean) => useInboxStore.getState().updateClientUI({ pr_delete_branch: next });
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
              onClick={() => setMethod(m.key)}
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
            onClick={() => setDeleteBranch(!deleteBranch)}
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

/** Everything else a pull request can have done to it, behind one button.
 *
 *  Share sits first, because handing the page to someone does not change it.
 *  Edits follow. Closing it is last, on its own, so it is never next to a
 *  copy. */
export function MoreMenu({
  pr,
  canWrite = false,
  onEditTitle,
}: {
  pr: any;
  /** Signed in, so the verbs that reach GitHub are offered. */
  canWrite?: boolean;
  onEditTitle?: () => void;
}) {
  const close = useAction(api.prCli.close);
  const reopen = useAction(api.prCli.reopen);
  const draft = useAction(api.prCli.draft);
  const reviewers = useAction(api.prCli.reviewers);
  const family = useRepoFamily();
  const [asking, setAsking] = useState(false);
  const [login, setLogin] = useState("");
  const locator = { repository: pr.repository, number: pr.number };
  const state = prStateKey(pr);
  // The link is to where the reader is (the view, the file, the lines), in
  // the public form that opens for anyone, in a browser or in the app.
  const loc = useRepoLocation();
  const here = loc.pathname.includes(`/${pr.number}`) ? `${loc.pathname}${loc.hash}` : prPageHref(pr.repository, pr.number, family);
  const pageUrl = sharePageUrl(toStandaloneHref(here));
  const githubUrl = `https://github.com/${pr.repository}/pull/${pr.number}`;
  const branch = pr.head_ref && pr.base_ref ? `${pr.head_ref} -> ${pr.base_ref}` : "";
  const openish = state === "open" || state === "draft";

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
          <CodeShareItems
            url={pageUrl}
            label="pull request"
            previewTitle={pr.title}
            githubUrl={githubUrl}
          />

          {(canWrite && onEditTitle || branch) && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              {canWrite && onEditTitle && (
                <CodeMenuItem icon={Pencil} onSelect={onEditTitle}>Edit title</CodeMenuItem>
              )}
              {branch && (
                <CodeMenuItem icon={GitBranch} onSelect={() => { void copyText(branch, "Branch copied"); }}>
                  Copy branch
                </CodeMenuItem>
              )}
            </>
          )}

          {canWrite && openish && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              <CodeMenuItem icon={UserPlus} onSelect={() => setAsking(true)}>Request a review</CodeMenuItem>
              {state === "open" && (
                <CodeMenuItem
                  icon={GitPullRequestDraft}
                  onSelect={() => { void act(() => draft({ ...locator, draft: true }), "Back to draft"); }}
                >
                  Convert to draft
                </CodeMenuItem>
              )}
              {state === "draft" && (
                <CodeMenuItem
                  icon={CircleDot}
                  onSelect={() => { void act(() => draft({ ...locator, draft: false }), "Ready for review"); }}
                >
                  Ready for review
                </CodeMenuItem>
              )}
            </>
          )}

          {canWrite && openish && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              <CodeMenuItem
                icon={GitPullRequestClosed}
                tone="danger"
                onSelect={() => { void act(() => close(locator), "Closed"); }}
              >
                Close without merging
              </CodeMenuItem>
            </>
          )}
          {canWrite && state === "closed" && (
            <>
              <DropdownMenuSeparator className="bg-sol-border" />
              <CodeMenuItem
                icon={RotateCcw}
                onSelect={() => { void act(() => reopen(locator), "Reopened"); }}
              >
                Reopen
              </CodeMenuItem>
            </>
          )}

          <DropdownMenuSeparator className="bg-sol-border" />
          <div className="px-2 py-1.5 text-[10px] text-sol-text-dim flex items-center gap-1.5 flex-wrap">
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
