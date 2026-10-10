"use client";
// Moving work on the chart: a session or a role dropped on a person or a role
// reports there from now on. A drop asks first (MoveConfirm), a pick from the
// node menu or the picker moves at once. Who may pick up what is decided here,
// so a card the server would refuse is never draggable and nothing snaps back
// silently: an admin moves anything, a role's host moves the role, a session's
// owner moves the session. A role never moves under itself or its own reports.
// The writes are the store's reparent actions: the card moves in the same tick
// and the server's answer comes back as a toast.
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowRightLeft, Search } from "lucide-react";
import { useMountEffect } from "../../hooks/useMountEffect";
import { useEventListener } from "../../hooks/useEventListener";
import { useInboxStore } from "../../store/inboxStore";
import { orgRoleReparentMakesCycle, reparentToastLine } from "../../store/orgSlice";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog";
import { Avatar } from "../tasks/TaskCommentStream";
import { OrgButton } from "./OrgButton";
import { parentNodeId, type OrgLayoutNode } from "./orgLayout";
import type { OrgReparentRequest } from "./OrgGraph";
import type { MoveSubject, OrgPeopleView } from "./useOrgPeopleView";
import { sameParent, type OrgParentRef, type OrgSession, type OrgTree } from "./orgTypes";

export type MoveTarget = { ref: OrgParentRef; id: string; title: string; sub: string; kind: "person" | "role"; image?: string };

export type OrgMoves = {
  canEditRole: (roleId: string) => boolean;
  canMoveSession: (s: OrgSession) => boolean;
  /** Which cards may be picked up at all. */
  canDrag: (n: OrgLayoutNode) => boolean;
  /** A drop on the People chart: checked, then confirmed. */
  requestMove: (req: OrgReparentRequest) => void;
  /** A move the person already chose (the menu, the picker, a drop on the Everything chart). */
  move: (subject: MoveSubject, target: OrgParentRef, targetTitle: string) => void;
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
  const canDrag = useCallback((n: OrgLayoutNode) => (n.kind === "session" ? canMoveSession(n.session) : n.kind === "role" ? canEditRole(n.role._id) : false), [canMoveSession, canEditRole]);

  const { findSession, currentParentOf, movePagedSession } = people;
  const commit = useCallback((subject: MoveSubject, target: OrgParentRef, targetTitle: string) => {
    const st = useInboxStore.getState();
    if (subject.kind === "session") {
      // The row may live only in a loaded page (past the tree's top N): the
      // slice gets it so counts move, and the pages draw it once, under the target.
      const row = findSession(subject.id);
      movePagedSession(subject.id, target, row);
      void st.reparentOrgSession(subject.id, target, { row })
        .then((r) => { if (r) toast.success(reparentToastLine(r.short_id ?? row?.short_id ?? "The session", targetTitle, "session", r.told)); })
        .catch(() => {});
    } else {
      // One toast says both things (S11): the role, and how many hands were told.
      const handle = tree?.roles.find((r) => r._id === subject.id)?.handle;
      void st.reparentOrgRole(subject.id, target)
        .then((r) => { if (r) toast.success(reparentToastLine(handle ? `@${handle}` : subject.title, targetTitle, "role", r.told)); })
        .catch(() => {});
    }
  }, [tree, findSession, movePagedSession]);

  /** Whether a subject may go under a target at all: allowed, not where it is, no loop. */
  const allowed = useCallback((subject: MoveSubject, target: OrgParentRef): boolean => {
    if (!tree) return false;
    if (subject.kind === "role") {
      if (!canEditRole(subject.id)) return false;
      if (target.kind === "role" && target.role_id === subject.id) return false;
      if (orgRoleReparentMakesCycle(tree, subject.id, target)) return false;
    } else {
      const s = findSession(subject.id);
      if (!s || !canMoveSession(s)) return false;
    }
    const cur = currentParentOf(subject);
    return !(cur && sameParent(cur, target));
  }, [tree, canEditRole, canMoveSession, findSession, currentParentOf]);

  const requestMove = useCallback((req: OrgReparentRequest) => {
    if (!allowed(req.subject, req.target)) { bump(); return; }
    setPending(req);
  }, [allowed, bump]);
  const move = useCallback((subject: MoveSubject, target: OrgParentRef, targetTitle: string) => {
    if (!allowed(subject, target)) return;
    setPicker(null);
    commit(subject, target, targetTitle);
  }, [allowed, commit]);
  const confirm = useCallback(() => {
    if (!pending) return;
    commit(pending.subject, pending.target, pending.targetTitle);
    setPending(null);
    bump();
  }, [pending, commit, bump]);
  const cancel = useCallback(() => { setPending(null); bump(); }, [bump]);

  const allTargets = useMemo<MoveTarget[]>(() => (tree ? [
    ...tree.people.map((p) => ({ ref: { kind: "user", user_id: p.user_id } as OrgParentRef, id: parentNodeId({ kind: "user", user_id: p.user_id }), title: p.name, sub: p.is_me ? "you" : p.role, kind: "person" as const, image: p.image })),
    ...tree.roles.filter((r) => r.status !== "retired").map((r) => ({ ref: { kind: "role", role_id: r._id } as OrgParentRef, id: parentNodeId({ kind: "role", role_id: r._id }), title: r.name, sub: `@${r.handle}`, kind: "role" as const })),
  ] : []), [tree]);
  const targetsFor = useCallback((subject: MoveSubject) => allTargets.filter((t) => !(subject.kind === "role" && t.ref.kind === "role" && (t.ref.role_id === subject.id || (tree && orgRoleReparentMakesCycle(tree, subject.id, t.ref))))), [allTargets, tree]);

  const ui = (
    <>
      {pending && <MoveConfirm req={pending} onConfirm={confirm} onCancel={cancel} />}
      {picker && <MovePicker subject={picker} current={currentParentOf(picker)} targets={targetsFor(picker)} onPick={(t) => move(picker, t.ref, t.title)} onClose={() => setPicker(null)} />}
    </>
  );
  return { canEditRole, canMoveSession, canDrag, requestMove, move, targetsFor, openPicker: setPicker, resetKey, ui };
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
          Move <b className="font-semibold">{req.subject.title}</b> under <b className="font-semibold">{req.targetTitle}</b>?
        </div>
        <div className="mt-1 text-[11px]" style={{ color: "var(--sol-text-dim)" }}>
          {req.subject.kind === "session"
            // A drop on a person ADDS them as an owner and hands them the
            // reporting line (performReparentSession defaults a bare user target to `add`).
            ? req.target.kind === "user" ? "This person also owns the session, and it reports to them." : "The session keeps its owners and reports to this role."
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
          <DialogTitle className="text-[15px]" style={{ fontFamily: "var(--font-serif)" }}>Move {subject.kind === "role" ? "role" : "session"}</DialogTitle>
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
            const isCurrent = !!current && sameParent(current, t.ref);
            return (
              <button key={t.id} type="button" disabled={isCurrent} onClick={() => onPick(t)} className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors hover:bg-sol-bg-highlight/70 disabled:opacity-50 disabled:cursor-default">
                {t.kind === "person" ? <Avatar name={t.title} image={t.image} /> : <span className="w-5 h-5 rounded-md inline-flex items-center justify-center text-[9px] font-semibold" style={{ background: "var(--sol-violet)", color: "var(--sol-bg)", fontFamily: "var(--font-mono)" }}>@</span>}
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
