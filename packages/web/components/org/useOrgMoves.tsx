"use client";
// Moving work on the chart: a session or a role dropped on a person or a role
// reports there from now on. A drop asks first (MoveConfirm), a pick from the
// node menu or the picker moves at once. Who may pick up what is decided here,
// so a card the server would refuse is never draggable and nothing snaps back
// silently: an admin moves anything, a role's host moves the role, a session's
// owner moves the session. A role never moves under itself or its own reports.
// A person moves under a person: an admin moves anyone, a person moves
// themself, anyone takes a person under themself, and a manager lets a report
// go (to the top of the chart). Never under someone who reports to them.
// The writes are the store's reparent actions: the card moves in the same tick
// and the server's answer comes back as a toast.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, ArrowUpToLine, Search } from "lucide-react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { sessionWorkState, useInboxStore, type InboxSession } from "../../store/inboxStore";
import { orgPersonReparentMakesCycle, orgRoleReparentMakesCycle, reparentToastLine } from "../../store/orgSlice";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Avatar } from "../tasks/TaskCommentStream";
import { OrgButton } from "./OrgButton";
import { parentNodeId, type OrgLayoutNode } from "./orgLayout";
import type { OrgReparentRequest } from "./OrgGraph";
import type { MoveSubject, OrgPeopleView } from "./useOrgPeopleView";
import { sameParent, type OrgParentRef, type OrgSession, type OrgTree } from "./orgTypes";

/** `ref` null: the top of the chart (a person who reports to nobody). */
export type MoveTarget = { ref: OrgParentRef | null; id: string; title: string; sub: string; kind: "person" | "role" | "top"; image?: string };

const TOP_TARGET_ID = "top";
export const sameTarget = (a: OrgParentRef | null, b: OrgParentRef | null) => (a && b ? sameParent(a, b) : a === b);

export type OrgMoves = {
  canEditRole: (roleId: string) => boolean;
  canMoveSession: (s: OrgSession) => boolean;
  /** Whether `userId` may go under `managerId` (null: the top) by this viewer's hand. */
  canMovePerson: (userId: string, managerId: string | null) => boolean;
  canDropPerson: (userId: string, managerId: string) => boolean;
  /** Which cards may be picked up at all. */
  canDrag: (n: OrgLayoutNode) => boolean;
  /** A drop on the People chart: checked, then confirmed. */
  requestMove: (req: OrgReparentRequest) => void;
  /** A move the person already chose (the menu, the picker, a drop on the Everything chart). */
  move: (subject: MoveSubject, target: OrgParentRef | null, targetTitle: string) => void;
  /** Sessions dropped from the inbox (one card or its whole selection): each moves at once, then one toast. */
  dropSessions: (conversationIds: readonly string[], target: OrgParentRef, targetTitle: string) => void;
  /** Every person and live role a subject could report to, minus where it would close a loop. */
  targetsFor: (subject: MoveSubject) => MoveTarget[];
  openPicker: (subject: MoveSubject) => void;
  /** Bumped after a cancelled or settled drop, so the chart puts the card back in its slot. */
  resetKey: number;
  /** The confirm and the picker; render them anywhere on the screen. */
  ui: ReactNode;
};

export function useOrgMoves(tree: OrgTree | null, people: Pick<OrgPeopleView, "findSession" | "currentParentOf" | "movePagedSession">): OrgMoves {
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const [pending, setPending] = useState<OrgReparentRequest | null>(null);
  const [picker, setPicker] = useState<MoveSubject | null>(null);
  const [resetKey, setResetKey] = useState(0);
  const bump = useCallback(() => setResetKey((k) => k + 1), []);

  const me = tree?.people.find((p) => p.is_me) ?? (meId ? tree?.people.find((p) => p.user_id === meId) : undefined);
  const myId = me?.user_id ?? meId;
  const isAdmin = me?.role === "admin" || me?.role === "owner" || tree?.workspace.kind === "user";
  const canEditRole = useCallback((roleId: string) => {
    const r = tree?.roles.find((x) => x._id === roleId);
    return !!r && (isAdmin || r.host_user_id === myId);
  }, [tree, isAdmin, myId]);
  const canMoveSession = useCallback((s: OrgSession) => isAdmin || s.owner_user_id === myId, [isAdmin, myId]);
  const teamId = tree?.workspace.kind === "team" ? tree.workspace.id : null;
  const canMovePerson = useCallback((userId: string, managerId: string | null) => {
    if (!teamId || !myId) return false;
    if (isAdmin || userId === myId || managerId === myId) return true;
    return managerId === null && tree?.people.find((p) => p.user_id === userId)?.reports_to_user_id === myId;
  }, [teamId, myId, isAdmin, tree]);
  const canDropPerson = useCallback((userId: string, managerId: string) => canMovePerson(userId, managerId), [canMovePerson]);
  // Anyone may take a teammate under themself, so every person card in a team is draggable.
  const canDrag = useCallback((n: OrgLayoutNode) => (n.kind === "session" ? canMoveSession(n.session) : n.kind === "role" ? canEditRole(n.role._id) : n.kind === "person" ? !!teamId : false), [canMoveSession, canEditRole, teamId]);

  const { findSession, currentParentOf, movePagedSession } = people;
  /** `quiet`: part of a group move, which says it once. */
  const commit = useCallback((subject: MoveSubject, target: OrgParentRef | null, targetTitle: string, quiet = false) => {
    const say = (line: string) => { if (!quiet) toast.success(line); };
    const st = useInboxStore.getState();
    if (subject.kind === "person") {
      if (!teamId || (target && target.kind !== "user")) return;
      st.reparentOrgPerson(teamId, subject.id, target?.user_id ?? null);
      say(target ? `${subject.title} now reports to ${targetTitle}` : `${subject.title} now reports to nobody`);
      return;
    }
    if (!target) return;
    if (subject.kind === "session") {
      // The row may live only in a loaded page (past the tree's top N) or only
      // in the inbox: the slice gets it so counts move, and the pages draw it once, under the target.
      const row = findSession(subject.id) ?? inboxOrgSession(subject.id, st.sessions[subject.id]);
      movePagedSession(subject.id, target, row);
      void st.reparentOrgSession(subject.id, target, { row })
        .then((r) => { if (r) say(reparentToastLine(r.short_id ?? "The session", targetTitle, "session", r.told)); })
        .catch(() => {});
    } else {
      // One toast says both things (S11): the role, and how many hands were told.
      const handle = tree?.roles.find((r) => r._id === subject.id)?.handle;
      void st.reparentOrgRole(subject.id, target)
        .then((r) => { if (r) say(reparentToastLine(handle ? `@${handle}` : subject.title, targetTitle, "role", r.told)); })
        .catch(() => {});
    }
  }, [tree, teamId, findSession, movePagedSession]);

  /** Whether a subject may go under a target at all: allowed, not where it is, no loop. */
  const allowed = useCallback((subject: MoveSubject, target: OrgParentRef | null): boolean => {
    if (!tree) return false;
    if (subject.kind === "person") {
      if (target && (target.kind !== "user" || target.user_id === subject.id || orgPersonReparentMakesCycle(tree, subject.id, target.user_id))) return false;
      if (!canMovePerson(subject.id, target?.user_id ?? null)) return false;
    } else if (!target) {
      return false;
    } else if (subject.kind === "role") {
      if (!canEditRole(subject.id)) return false;
      if (target.kind === "role" && target.role_id === subject.id) return false;
      if (orgRoleReparentMakesCycle(tree, subject.id, target)) return false;
    } else {
      // A session the chart does not hold yet comes from the inbox; the server decides who may file it.
      const s = findSession(subject.id);
      if (s ? !canMoveSession(s) : !useInboxStore.getState().sessions[subject.id]) return false;
    }
    return !sameTarget(currentParentOf(subject), target);
  }, [tree, canEditRole, canMoveSession, canMovePerson, findSession, currentParentOf]);

  const requestMove = useCallback((req: OrgReparentRequest) => {
    // A multi-selection moves what may move; the rest stays where it is.
    const [subject, ...also] = [req.subject, ...(req.also ?? [])].filter((x) => allowed(x, req.target));
    if (!subject) { bump(); return; }
    setPending({ ...req, subject, also });
  }, [allowed, bump]);
  const move = useCallback((subject: MoveSubject, target: OrgParentRef | null, targetTitle: string) => {
    if (!allowed(subject, target)) return;
    setPicker(null);
    commit(subject, target, targetTitle);
  }, [allowed, commit]);
  /** Several subjects under one target, said once. */
  const commitAll = useCallback((subjects: MoveSubject[], target: OrgParentRef, targetTitle: string) => {
    if (subjects.length === 1) { commit(subjects[0], target, targetTitle); return; }
    for (const x of subjects) commit(x, target, targetTitle, true);
    toast.success(`${subjects.length} now report to ${targetTitle}.`);
  }, [commit]);
  const dropSessions = useCallback((ids: readonly string[], target: OrgParentRef, targetTitle: string) => {
    const subjects = ids.map((id): MoveSubject => ({ kind: "session", id, title: "" })).filter((x) => allowed(x, target));
    if (subjects.length) commitAll(subjects, target, targetTitle);
  }, [allowed, commitAll]);
  const confirm = useCallback(() => {
    if (!pending) return;
    commitAll([pending.subject, ...(pending.also ?? [])], pending.target, pending.targetTitle);
    setPending(null);
    bump();
  }, [pending, commitAll, bump]);
  const cancel = useCallback(() => { setPending(null); bump(); }, [bump]);

  const allTargets = useMemo<MoveTarget[]>(() => (tree ? [
    ...tree.people.map((p) => ({ ref: { kind: "user", user_id: p.user_id } as OrgParentRef, id: parentNodeId({ kind: "user", user_id: p.user_id }), title: p.name, sub: p.is_me ? "you" : p.role, kind: "person" as const, image: p.image })),
    ...tree.roles.filter((r) => r.status !== "retired").map((r) => ({ ref: { kind: "role", role_id: r._id } as OrgParentRef, id: parentNodeId({ kind: "role", role_id: r._id }), title: r.name, sub: `@${r.handle}`, kind: "role" as const })),
  ] : []), [tree]);
  const targetsFor = useCallback((subject: MoveSubject): MoveTarget[] => {
    if (subject.kind === "person") {
      // People only, plus the top of the chart, each one this viewer may pick.
      const top: MoveTarget = { ref: null, id: TOP_TARGET_ID, title: "Nobody", sub: "top of the chart", kind: "top" };
      return [...allTargets, top].filter((t) => (t.ref === null || t.ref.kind === "user") && allowed(subject, t.ref)
        || sameTarget(currentParentOf(subject), t.ref));
    }
    return allTargets.filter((t) => !(subject.kind === "role" && t.ref?.kind === "role" && (t.ref.role_id === subject.id || (tree && orgRoleReparentMakesCycle(tree, subject.id, t.ref)))));
  }, [allTargets, tree, allowed, currentParentOf]);

  const ui = (
    <>
      {pending && <MoveConfirm req={pending} onConfirm={confirm} onCancel={cancel} />}
      {picker && <MovePicker subject={picker} current={currentParentOf(picker)} targets={targetsFor(picker)} onPick={(t) => move(picker, t.ref, t.title)} onClose={() => setPicker(null)} />}
    </>
  );
  return { canEditRole, canMoveSession, canMovePerson, canDropPerson, canDrag, requestMove, move, dropSessions, targetsFor, openPicker: setPicker, resetKey, ui };
}

/** An inbox row the chart does not hold yet, as the chart's session row, so the move paints under its target at once. */
function inboxOrgSession(id: string, s: InboxSession | undefined): OrgSession | null {
  if (!s) return null;
  return { _id: id, short_id: id.slice(0, 7), title: s.title ?? "", agent_type: s.agent_type, state: sessionWorkState(s), updated_at: s.updated_at, subagent_count: 0, is_anchor: false, project_path: s.project_path, git_branch: s.git_branch };
}

// ---------------------------------------------------------------- confirm popover

export function MoveConfirm({ req, onConfirm, onCancel }: { req: OrgReparentRequest; onConfirm: () => void; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useMountEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("button[data-primary]")?.focus();
  });
  useEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
  }, undefined, { capture: true });
  const w = 280;
  const x = Math.max(12, Math.min(req.at.x - w / 2, (typeof window !== "undefined" ? window.innerWidth : 1200) - w - 12));
  const y = Math.max(12, req.at.y + 14);
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onCancel} />
      <div ref={ref} className="fixed z-50 rounded-xl border p-3 org-pop-in" style={{ left: x, top: y, width: w, background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", boxShadow: "0 18px 48px -18px rgba(0,0,0,0.5), 0 3px 10px rgba(0,0,0,0.12)" }} role="dialog" aria-modal="false" aria-label="Confirm move" data-move-confirm>
        <div className="text-[12.5px] leading-snug" style={{ color: "var(--sol-text)" }}>
          Move <b className="font-semibold">{req.subject.title}</b>{req.also?.length ? <> and {req.also.length} more</> : null} under <b className="font-semibold">{req.targetTitle}</b>?
        </div>
        <div className="mt-1 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
          {req.subject.kind === "session"
            // A drop on a person ADDS them as an owner and hands them the
            // reporting line (performReparentSession defaults a bare user target to `add`).
            ? req.target.kind === "user" ? "This person also owns the session, and it reports to them." : "The session keeps its owners and reports to this role."
            : req.subject.kind === "person" ? "They and everyone under them move together."
            : "The role and everything under it move together."}
        </div>
        <div className="mt-2.5 flex items-center justify-end gap-1.5">
          <button type="button" onClick={onCancel} className="h-7 px-2.5 rounded-md text-[12px] hover:bg-sol-bg-highlight" style={{ color: "var(--sol-text-muted)" }} data-move-cancel>Cancel</button>
          <OrgButton primary data-primary onClick={onConfirm} size="sm">Move</OrgButton>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- move picker

function MovePicker({ subject, current, targets, onPick, onClose }: { subject: MoveSubject; current: OrgParentRef | null; targets: MoveTarget[]; onPick: (t: MoveTarget) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const needle = q.toLowerCase();
  const list = targets.filter((t) => !q || t.title.toLowerCase().includes(needle) || t.sub.toLowerCase().includes(needle));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[380px] p-0 gap-0 overflow-hidden" style={{ background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }}>
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-[15px]" style={{ fontFamily: "var(--font-serif)" }}>Move {subject.kind}</DialogTitle>
          <DialogDescription className="text-[12px] truncate" style={{ color: "var(--sol-text-muted)" }}>{subject.title}</DialogDescription>
        </DialogHeader>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 h-9 px-2.5 rounded-lg border" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: "var(--sol-bg-alt)" }}>
            <Search className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Person or role…" className="flex-1 bg-transparent outline-none text-[13px]" style={{ color: "var(--sol-text)" }} />
          </div>
        </div>
        <div className="max-h-[320px] overflow-y-auto px-2 pb-3">
          {list.length === 0 && <p className="px-2.5 py-3 text-[12px]" style={{ color: "var(--sol-text-dim)" }}>No match.</p>}
          {list.map((t) => {
            const isCurrent = sameTarget(current, t.ref);
            return (
              <button key={t.id} type="button" disabled={isCurrent} onClick={() => onPick(t)} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-sol-bg-highlight/70 disabled:opacity-50 disabled:cursor-default">
                {t.kind === "person" ? <Avatar name={t.title} image={t.image} /> : t.kind === "top" ? <ArrowUpToLine className="w-4 h-4" style={{ color: "var(--sol-text-dim)" }} /> : <span className="w-5 h-5 rounded-md inline-flex items-center justify-center text-[9px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{t.title}</span>
                  <span className="block truncate text-[10.5px]" style={{ color: "var(--sol-text-dim)" }}>{t.sub}{isCurrent ? " · current" : ""}</span>
                </span>
                {!isCurrent && <ArrowRightLeft className="w-3.5 h-3.5" style={{ color: "var(--sol-text-dim)" }} />}
              </button>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}
