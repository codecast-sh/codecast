// What the priorities' icons mean, behind a quiet ⓘ at the top right of the
// list: the milestone and session states (the two bordered ones are the
// actions), the task states, and the other kinds an open milestone lists.
import type { ReactNode } from "react";
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, Info, Map as MapIcon, Workflow } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "../ui/dialog";
import { SessionStatusMark } from "../inbox/SessionStatusMark";
import { TASK_STATUS } from "../TaskStatusBadge";
import { MILESTONE_STATE_WORD, TOUCH_AREA } from "../../lib/priorityList";
import { SESSION_STATUS } from "../../lib/sessionStatus";
import { cn } from "../../lib/utils";
import { DeployMark, NeedsYouMark, NewSessionMark, UnknownTaskMark } from "./parts";

const TASK_STATES = ["backlog", "open", "in_progress", "in_review", "done", "dropped"] as const;

function Row({ icon, word }: { icon: ReactNode; word: string }) {
  return (
    <li data-legend-row={word} className="flex items-center gap-2.5 py-0.5">
      <span className="flex size-6 items-center justify-center">{icon}</span>
      <span className="text-ui text-sol-text">{word}</span>
    </li>
  );
}

/** A section head, 16px below the section before it; `className` takes that gap away where a head starts a column. */
const Head = ({ children, className }: { children: ReactNode; className?: string }) => <div data-legend-head className={cn("mb-1 mt-4 text-mark font-semibold uppercase tracking-wide text-sol-text-dim", className)}>{children}</div>;

/** The dialog's own close X (its last child) presses 44px under a coarse pointer: an 8px ::after around its 28px. */
const CLOSE_TOUCH = "[@media(pointer:coarse)]:[&>button:last-child]:after:absolute [@media(pointer:coarse)]:[&>button:last-child]:after:-inset-2 [@media(pointer:coarse)]:[&>button:last-child]:after:content-['']";

export function Legend() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" data-legend aria-label="What the icons mean" title="What the icons mean" className={cn("flex size-6 items-center justify-center rounded-full text-sol-text-dim/70 hover:bg-sol-bg-alt hover:text-sol-text", TOUCH_AREA)}>
          <Info className="size-3.5" aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent className={cn("max-w-xl", CLOSE_TOUCH)} aria-describedby={undefined}>
        <DialogTitle>What the icons mean</DialogTitle>
        <div className="grid gap-x-8 px-1 pb-2 sm:grid-cols-2">
          <div>
            <Head className="mt-0">Milestones and sessions</Head>
            <ul>
              <Row icon={<NeedsYouMark />} word={MILESTONE_STATE_WORD.needs_you} />
              <Row icon={<NewSessionMark />} word={MILESTONE_STATE_WORD.start} />
              <Row icon={<SessionStatusMark status="working" size={13} />} word={MILESTONE_STATE_WORD.working} />
              <Row icon={<SessionStatusMark status="dormant" size={13} />} word={MILESTONE_STATE_WORD.dormant} />
              <Row icon={<SessionStatusMark status="idle" size={13} />} word={MILESTONE_STATE_WORD.idle} />
              <Row icon={<SessionStatusMark status="done" size={13} />} word={MILESTONE_STATE_WORD.done} />
              <Row icon={<SessionStatusMark status="killed" size={13} />} word="Closed" />
              {/* A session row draws its inbox's mark, these three included. */}
              <Row icon={<SessionStatusMark status="starting" size={13} />} word={SESSION_STATUS.starting.word} />
              <Row icon={<SessionStatusMark status="error" size={13} />} word={SESSION_STATUS.error.word} />
              <Row icon={<SessionStatusMark status="stashed" size={13} />} word={SESSION_STATUS.stashed.word} />
              <Row icon={<Workflow className="size-3.5 text-sol-text-dim" />} word="Workflow run" />
            </ul>
          </div>
          <div>
            {/* Two columns side by side: Tasks heads the second. One column (a phone): it follows the first. */}
            <Head className="sm:mt-0">Tasks</Head>
            <ul>
              {TASK_STATES.map((k) => {
                const { icon: Icon, color, label } = TASK_STATUS[k];
                return <Row key={k} icon={<span className={color}><Icon className="size-3.5" /></span>} word={label} />;
              })}
              <Row icon={<UnknownTaskMark />} word="Not loaded yet" />
            </ul>
            <Head>Other</Head>
            <ul>
              <Row icon={<GitPullRequest className="size-3.5 text-sol-green" />} word="Pull request, open" />
              <Row icon={<GitMerge className="size-3.5 text-sol-violet" />} word="Pull request, merged" />
              <Row icon={<GitPullRequestClosed className="size-3.5 text-sol-red" />} word="Pull request, closed" />
              <Row icon={<GitBranch className="size-3.5 text-sol-text-dim" />} word="Branch" />
              <Row icon={<MapIcon className="size-3.5 text-sol-text-dim" />} word="Plan" />
              <Row icon={<DeployMark status="live" />} word="Deploy, live" />
              <Row icon={<DeployMark status="failed" />} word="Deploy, failed" />
              <Row icon={<DeployMark status="running" />} word="Deploy, not live yet" />
            </ul>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
