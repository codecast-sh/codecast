// The person's controls over a priority, its milestones and its sessions, on
// the list, the pri-N page and the card. Each press runs a store action
// (lib/priorityWrites), which paints at once and rides dispatch to the
// override the pass then keeps. Only the owner sees a write; a teammate's
// menu holds Copy link alone. A drop and a merge cannot be taken back, so
// each opens the confirm flow (components/consequential) first. Correct…
// opens a popover on the menu's own button; its box is uncontrolled, so a
// keystroke commits nothing.
import { useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { MoreHorizontal } from "lucide-react";
import type { PriorityRow, PriorityStep } from "@codecast/shared/contracts/priorities";
import { effectivePriorityOrder } from "@codecast/shared/contracts/priorities";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";
import { Button } from "../ui/button";
import { SwitchReview, type SwitchLedger } from "../consequential/ConsequentialSwitch";
import { usePriorities, usePriorityWrites } from "../../hooks/usePriorities";
import { priorityHref, rankProvenance } from "../../lib/priorities";
import { COARSE_TALL, type SessionLine } from "../../lib/priorityList";
import { cn } from "../../lib/utils";
import { useMountEffect } from "../../hooks/useMountEffect";

const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
/** Opens a popover after the menu that asked for it has closed, so the menu's own close does not take its focus. */
const afterMenu = (open: () => void) => () => { setTimeout(open, 0); };
/**
 * A submenu of names (Merge into…, Move to…): never wider than the screen
 * leaves beside its parent menu, 8px clear of the edge, its names wrapping.
 */
const SUB_LIST = "max-h-[60vh] max-w-[min(20rem,var(--radix-dropdown-menu-content-available-width))] overflow-y-auto";
const SUB_PROPS = { collisionPadding: 8 } as const;
const WRAP = "min-w-0 whitespace-normal break-words";
/** On a touch screen every menu row is a 44px target. */
const TOUCH_ITEMS = "[@media(pointer:coarse)]:[&_[role=menuitem]]:min-h-11";

/** The owner's active priorities in the row's workspace, in order: the places a move or a merge can go. */
function useOwnActive(row: PriorityRow): PriorityRow[] {
  const rows = usePriorities();
  return effectivePriorityOrder(rows.filter((r) => r.mine && r.workspace === row.workspace && r.status === "active"));
}

/**
 * A ⋯ button: it looks 24px, and a coarse pointer presses a 44px area around
 * it. `reveal`: on a mouse it shows while its line is hovered (the class
 * names that group); on a touch screen and while its menu is open it always
 * shows.
 */
function menuButtonClass(reveal?: string) {
  return cn(
    "relative flex size-6 shrink-0 items-center justify-center rounded text-sol-text-dim hover:bg-sol-bg-highlight hover:text-sol-text focus-visible:opacity-100 data-[state=open]:opacity-100",
    "[@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-2.5 [@media(pointer:coarse)]:after:content-['']",
    reveal && cn("opacity-0 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100", reveal),
  );
}

/** "Correct…": what the pass got wrong about a priority or one of its milestones. Saved, the row reads "correction pending" until a pass reads it. */
export function CorrectPopover({ open, onOpenChange, subject, onSave, children }: { open: boolean; onOpenChange: (open: boolean) => void; subject: string; onSave: (text: string) => void; children: ReactNode }) {
  const box = useRef<HTMLTextAreaElement>(null);
  const save = () => {
    const text = box.current?.value.trim() ?? "";
    if (!text) return box.current?.focus();
    onSave(text);
    onOpenChange(false);
  };
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent align="end" sideOffset={6} className="w-80 max-w-[calc(100vw-2rem)] p-3" onClick={stop} onKeyDown={stop} data-correct-popover>
        <div className="truncate text-meta text-sol-text-dim">Correct <span className="font-medium text-sol-text">{subject}</span></div>
        <textarea
          ref={box}
          autoFocus
          data-correct-text
          placeholder="What did it get wrong?"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
          className="mt-2 h-24 w-full resize-none rounded-control border border-sol-border bg-sol-bg px-2.5 py-2 text-[16px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-text-dim focus:outline-none sm:text-ui"
        />
        <div className="mt-1.5 text-meta text-sol-text-dim">The next pass keeps this.</div>
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" data-correct-cancel onClick={() => onOpenChange(false)} className={COARSE_TALL}>Cancel</Button>
          <Button size="sm" variant="primary" data-correct-save onClick={save} className={COARSE_TALL}>Save</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const copyLink = (shortId: string) => {
  void navigator.clipboard?.writeText(window.location.origin + priorityHref(shortId));
  toast("Link copied");
};

/**
 * The sessions linked to a priority's milestones (or to one of them), each
 * once, plus the ones each link counts but does not carry: what the rows
 * draw, so a merge and a drop count the same way.
 */
function linkedSessionCount(row: Pick<PriorityRow, "links">, stepKey?: string): number {
  const links = (row.links ?? []).filter((l) => stepKey == null || l.key === stepKey);
  const ids = new Set(links.flatMap((l) => l.sessions.map((s) => s.conversation_id)));
  return ids.size + links.reduce((n, l) => n + l.sessions_more, 0);
}

/** A merge: what moves and what ends, before it happens (there is no unmerge). */
function mergeLedger(from: PriorityRow, into: PriorityRow): SwitchLedger {
  const n = from.steps.length;
  const sessions = linkedSessionCount(from);
  return {
    name: "Merge priority",
    subject: `${from.title} into ${into.title}`,
    shift: null,
    figures: [
      { value: String(n), label: n === 1 ? "milestone moves" : "milestones move" },
      { value: String(sessions), label: sessions === 1 ? "session moves" : "sessions move" },
    ],
    rows: [
      { k: "Keeps", v: into.title },
      { k: "Ends", v: from.title, tone: "warn" },
      { k: "Undo", v: "None", tone: "warn" },
    ],
    confirm: "Merge",
    keep: "Cancel",
  };
}

/** A drop: the milestone leaves the priority, and the pass never proposes it again. Its sessions stay on the priority. */
function dropLedger(row: PriorityRow, step: Pick<PriorityStep, "key" | "title">): SwitchLedger {
  const sessions = linkedSessionCount(row, step.key);
  return {
    name: "Drop milestone",
    subject: step.title,
    shift: null,
    figures: [{ value: String(sessions), label: sessions === 1 ? "linked session" : "linked sessions" }],
    rows: [
      { k: "Priority", v: row.title },
      { k: "Sessions", v: "Stay on the priority, without that milestone" },
      { k: "The pass", v: "Never proposes it again" },
      { k: "Undo", v: "None", tone: "warn" },
    ],
    confirm: "Drop",
    keep: "Cancel",
  };
}

/**
 * The priority's ⋯: who placed it, then the owner's moves, done, set aside or
 * restore, merge, Correct…, and Copy link for anyone. Rename is a double-click
 * on the title; only a coarse pointer keeps it here (`onRename`).
 */
export function PriorityMenu({ row, reveal, label, className, onRename }: { row: PriorityRow; reveal?: string; label?: string; className?: string; onRename?: () => void }) {
  const writes = usePriorityWrites();
  const [correcting, setCorrecting] = useState(false);
  const [merging, setMerging] = useState<PriorityRow | null>(null);
  const why = row.status === "active" && row.rank != null ? rankProvenance(row) : null;
  return (
    <span className={cn("inline-flex", className)} onClick={stop} onKeyDown={stop}>
      <CorrectPopover open={correcting} onOpenChange={setCorrecting} subject={row.title} onSave={(text) => writes.correct(row.short_id, text, null)}>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-priority-menu={row.short_id} aria-label={label ?? `More for ${row.title}`} onClick={stop} className={menuButtonClass(reveal)}>
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={cn("min-w-[12rem]", TOUCH_ITEMS)} onClick={stop} onCloseAutoFocus={(e) => e.preventDefault()}>
              {why && <DropdownMenuLabel data-menu-rank-by className="text-meta font-normal text-sol-text-dim">#{row.rank} · {why}</DropdownMenuLabel>}
              {row.mine && onRename && <DropdownMenuItem data-act="rename" onSelect={afterMenu(onRename)} className="[@media(pointer:fine)]:hidden">Rename</DropdownMenuItem>}
              {row.mine && <OwnerPriorityItems row={row} onCorrect={afterMenu(() => setCorrecting(true))} onMerge={setMerging} />}
              <DropdownMenuItem data-act="copy-link" onSelect={() => copyLink(row.short_id)}>Copy link</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </CorrectPopover>
      {merging && (
        <SwitchReview
          ledger={mergeLedger(row, merging)}
          onClose={() => setMerging(null)}
          onConfirm={() => { writes.merge(row.short_id, merging.short_id); setMerging(null); }}
        />
      )}
    </span>
  );
}

function OwnerPriorityItems({ row, onCorrect, onMerge }: { row: PriorityRow; onCorrect: () => void; onMerge: (into: PriorityRow) => void }) {
  const writes = usePriorityWrites();
  const own = useOwnActive(row);
  const rank = row.status === "active" ? row.rank : null;
  const count = Math.max(own.length, rank ?? 0);
  const others = own.filter((r) => r.short_id !== row.short_id);
  return (
    <>
      {rank != null && rank > 1 && <DropdownMenuItem data-act="move-up" onSelect={() => writes.move(row.short_id, "up")}>Move up</DropdownMenuItem>}
      {rank != null && rank < count && <DropdownMenuItem data-act="move-down" onSelect={() => writes.move(row.short_id, "down")}>Move down</DropdownMenuItem>}
      {rank != null && count > 1 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-act="move-to">Move to #…</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className={cn("max-h-[60vh] min-w-[8rem] overflow-y-auto", TOUCH_ITEMS)} onClick={stop}>
            {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
              <DropdownMenuItem key={n} data-move-to={n} disabled={n === rank} onSelect={() => writes.move(row.short_id, n)} className="tabular-nums">
                #{n}{n === rank && <span className="text-sol-text-dim">(now)</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      {/* Only a group that has a move in it ends in a separator. */}
      {rank != null && count > 1 && <DropdownMenuSeparator />}
      {row.status !== "done" && <DropdownMenuItem data-act="mark-done" onSelect={() => writes.markDone(row.short_id)}>Mark done</DropdownMenuItem>}
      {row.status === "active" && <DropdownMenuItem data-act="set-aside" onSelect={() => writes.setAside(row.short_id)}>Set aside</DropdownMenuItem>}
      {(row.status === "set_aside" || row.status === "done") && <DropdownMenuItem data-act="restore" onSelect={() => writes.restore(row.short_id)}>Restore</DropdownMenuItem>}
      {row.status === "active" && others.length > 0 && (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-act="merge">Merge into…</DropdownMenuSubTrigger>
          <DropdownMenuSubContent {...SUB_PROPS} data-sub-list="merge" className={cn(SUB_LIST, TOUCH_ITEMS)} onClick={stop}>
            {others.map((r) => (
              <DropdownMenuItem key={r.short_id} data-merge-into={r.short_id} onSelect={() => onMerge(r)} className="items-start">
                <span className="w-6 shrink-0 text-right tabular-nums text-sol-text-dim">{r.rank}</span>
                <span className={WRAP}>{r.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )}
      <DropdownMenuItem data-act="correct" onSelect={onCorrect}>Correct…</DropdownMenuItem>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * A milestone's ⋯, for the owner: Done or Undone, its tier, Drop, Correct….
 * Rename is a double-click on the title; only a coarse pointer, which has no
 * double-click to speak of, keeps it here.
 */
export function MilestoneMenu({ row, step, onRename, reveal, className }: {
  row: PriorityRow;
  step: PriorityStep;
  onRename: () => void;
  reveal?: string;
  className?: string;
}) {
  const writes = usePriorityWrites();
  const [correcting, setCorrecting] = useState(false);
  const [dropping, setDropping] = useState(false);
  const polish = step.tier === "polish";
  return (
    <span className={cn("inline-flex", className)} onClick={stop} onKeyDown={stop}>
      <CorrectPopover open={correcting} onOpenChange={setCorrecting} subject={step.title} onSave={(text) => writes.correct(row.short_id, text, step.key)}>
        <span className="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" data-milestone-menu={step.key} aria-label={`More for ${step.title}`} onClick={stop} className={menuButtonClass(reveal)}>
                <MoreHorizontal className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={cn("min-w-[11rem]", TOUCH_ITEMS)} onClick={stop} onCloseAutoFocus={(e) => e.preventDefault()}>
              <DropdownMenuItem data-act="step-done" onSelect={() => writes.setStepDone(row.short_id, step.key, !step.done)}>{step.done ? "Undone" : "Done"}</DropdownMenuItem>
              <DropdownMenuItem data-act="rename" onSelect={afterMenu(onRename)} className="[@media(pointer:fine)]:hidden">Rename</DropdownMenuItem>
              <DropdownMenuItem data-act="tier" onSelect={() => writes.setStepTier(row.short_id, step.key, polish ? "critical" : "polish")}>{polish ? "Move to critical" : "Move to polish"}</DropdownMenuItem>
              <DropdownMenuItem data-act="drop" onSelect={() => setDropping(true)}>Drop…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-act="correct" onSelect={afterMenu(() => setCorrecting(true))}>Correct…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </CorrectPopover>
      {dropping && (
        <SwitchReview
          ledger={dropLedger(row, step)}
          onClose={() => setDropping(false)}
          onConfirm={() => { writes.dropStep(row.short_id, step.key); setDropping(false); }}
        />
      )}
    </span>
  );
}

/** A session's ⋯ under a milestone, for the owner of both: off this milestone, off this priority, or to another milestone. */
export function SessionMenu({ row, s, stepKey }: { row: PriorityRow; s: Pick<SessionLine, "short_id" | "title">; stepKey: string | null }) {
  const writes = usePriorityWrites();
  return (
    <span className="inline-flex" onClick={stop} onKeyDown={stop}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" data-session-menu={s.short_id} aria-label={`Fix the link to ${s.title || "this session"}`} onClick={stop} className={menuButtonClass("group-hover/session:opacity-100")}>
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={cn("min-w-[12rem]", TOUCH_ITEMS)} onClick={stop}>
          {stepKey && <DropdownMenuItem data-act="not-milestone" onSelect={() => writes.moveSession(s.short_id, row.short_id, row.short_id, null)}>Not this milestone</DropdownMenuItem>}
          <DropdownMenuItem data-act="not-priority" onSelect={() => writes.sessionNotThis(s.short_id, row.short_id)}>Not this priority</DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-act="move-session">Move to…</DropdownMenuSubTrigger>
            <DropdownMenuSubContent {...SUB_PROPS} data-sub-list="move-session" className={cn(SUB_LIST, TOUCH_ITEMS)} onClick={stop}>
              <MoveTargets row={row} session={s.short_id} stepKey={stepKey} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/**
 * Where a session can move: this priority's other milestones under its name
 * (critical, then polish after a separator), then each of the owner's other
 * active priorities and its milestones.
 */
function MoveTargets({ row, session, stepKey }: { row: PriorityRow; session: string; stepKey: string | null }) {
  const writes = usePriorityWrites();
  const others = useOwnActive(row).filter((r) => r.short_id !== row.short_id);
  const steps = (r: PriorityRow) => r.steps.filter((st) => !st.done && !st.dropped);
  const item = (to: PriorityRow, st: PriorityStep) => (
    <DropdownMenuItem key={`${to.short_id}/${st.key}`} data-move-session-to={`${to.short_id}/${st.key}`} onSelect={() => writes.moveSession(session, row.short_id, to.short_id, st.key)}>
      <span className={WRAP}>{st.title}</span>
    </DropdownMenuItem>
  );
  const here = steps(row).filter((st) => st.key !== stepKey);
  const critical = here.filter((st) => st.tier === "critical");
  const polish = here.filter((st) => st.tier === "polish");
  return (
    <>
      {here.length > 0 && <DropdownMenuLabel data-move-here className="text-mark font-semibold uppercase tracking-wide text-sol-text-dim">{row.title}</DropdownMenuLabel>}
      {critical.map((st) => item(row, st))}
      {critical.length > 0 && polish.length > 0 && <DropdownMenuSeparator data-move-polish />}
      {polish.map((st) => item(row, st))}
      {here.length > 0 && others.length > 0 && <DropdownMenuSeparator />}
      {others.map((r) => (
        <DropdownMenuSub key={r.short_id}>
          <DropdownMenuSubTrigger data-move-session-priority={r.short_id} className="items-start">
            <span className="w-5 shrink-0 text-right tabular-nums text-sol-text-dim">{r.rank}</span>
            <span className={WRAP}>{r.title}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent {...SUB_PROPS} className={cn(SUB_LIST, TOUCH_ITEMS)} onClick={stop}>
            {steps(r).length ? steps(r).map((st) => item(r, st)) : <DropdownMenuLabel className="text-meta font-normal text-sol-text-dim">No open milestones</DropdownMenuLabel>}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ))}
      {here.length === 0 && others.length === 0 && <DropdownMenuLabel className="text-meta font-normal text-sol-text-dim">No other milestone</DropdownMenuLabel>}
    </>
  );
}

/**
 * "Looks done?": the milestone is open, yet every task it names is done. For
 * the owner it is a button that marks it done, the same store action as its
 * box (a refusal puts the paint back); for anyone else, the words alone.
 */
export function LooksDone({ row, step }: { row: PriorityRow; step: Pick<PriorityStep, "key"> }) {
  const writes = usePriorityWrites();
  const look = "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-sol-border px-1.5 text-mark leading-[18px] text-sol-text-muted";
  if (!row.mine) return <span data-looks-done title="Every task it names is done" className={look}>Looks done?</span>;
  // The button is the press (44px tall under a coarse pointer); the pill inside it is the look.
  return (
    <button
      type="button"
      data-looks-done
      title="Every task it names is done: mark it done"
      onClick={(e) => { e.stopPropagation(); writes.setStepDone(row.short_id, step.key, true); }}
      onKeyDown={stop}
      className="group/looks inline-flex shrink-0 items-center [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
    >
      <span className={cn(look, "group-hover/looks:border-sol-text-dim group-hover/looks:text-sol-text")}>Looks done?</span>
    </button>
  );
}

/**
 * Where focus goes once a rename ends by key: the title the input stood in
 * for when it can hold focus (`data-rename-return`), else the row around it.
 * Read from the input's parent, which outlives the input.
 */
function returnFocus(host: HTMLElement | null) {
  setTimeout(() => {
    const target = host?.querySelector<HTMLElement>("[data-rename-return]") ?? host?.closest<HTMLElement>("[tabindex], a[href], button");
    target?.focus();
  }, 0);
}

/**
 * A milestone's (or, with its `label`, a priority's) title being renamed in
 * place: Enter keeps it, Escape takes it back, and so does leaving it, unless
 * the person left on purpose (a press outside the box, or Tab), which keeps
 * it. A browser extension can swallow Escape and just blur the box, and a
 * window switch blurs it too: neither may save an edit the person was
 * abandoning. Uncontrolled, so typing commits nothing. Ended by Enter,
 * Escape or a bare blur, focus goes back to the title (returnFocus), never to
 * the page.
 */
export function MilestoneTitleInput({ title, onDone, className, label = "Milestone title" }: { title: string; onDone: (title: string | null) => void; className?: string; label?: string }) {
  const done = useRef(false);
  const box = useRef<HTMLInputElement>(null);
  const leaving = useRef(false);
  const finish = (value: string | null) => {
    if (done.current) return;
    done.current = true;
    const next = value?.trim();
    onDone(next && next !== title ? next : null);
  };
  useMountEffect(() => {
    // On a touch screen the focus moves only once the tap ends, so the press alone marks the leaving.
    const press = (e: Event) => { if (!box.current?.contains(e.target as Node)) leaving.current = true; };
    document.addEventListener("pointerdown", press, true);
    return () => document.removeEventListener("pointerdown", press, true);
  });
  return (
    <input
      ref={box}
      autoFocus
      data-rename-input
      defaultValue={title}
      aria-label={label}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onClick={stop}
      onKeyDown={(e) => {
        e.stopPropagation();
        // Typing on after a press outside that kept the focus here: still editing.
        leaving.current = e.key === "Tab";
        if (e.key !== "Enter" && e.key !== "Escape") return;
        const host = e.currentTarget.parentElement;
        finish(e.key === "Enter" ? e.currentTarget.value : null);
        returnFocus(host);
      }}
      onBlur={(e) => {
        if (leaving.current) return finish(e.currentTarget.value);
        // A bare blur is a cancel (an Escape an extension ate): focus goes back to the title, as Escape's does, never to the page.
        const host = e.currentTarget.parentElement;
        finish(null);
        returnFocus(host);
      }}
      className={cn("min-w-0 flex-1 rounded-control border border-sol-border bg-sol-bg px-1.5 py-0.5 text-[16px] text-sol-text focus:border-sol-text-dim focus:outline-none sm:text-ui", className)}
    />
  );
}
