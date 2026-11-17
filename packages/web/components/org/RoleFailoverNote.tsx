"use client";
// The owner's line when the failover sweep moved a role's standing session off
// a dead host, or found nowhere to move it (convex roleFailover.ts). It sits
// where the paused note does, above the conversation, and carries the two ways
// to settle a move: Move back, or Keep here, which leaves the session on its
// new host and clears the line. A move back that changes the account the role
// runs and bills under goes through the consequential review first.
import { useState } from "react";
import { ArrowRight, Check, TriangleAlert, Undo2 } from "lucide-react";
import { moveBackRefusal, roleFailoverBillsUnder, roleFailoverReasonWords, type MoveBackState, type RoleFailover } from "@codecast/shared/contracts/roleFailover";
import { useRoleMoveBack } from "../../hooks/useRoleMoveBack";
import { cn } from "../../lib/utils";
import { OrgButton } from "./OrgButton";
import { SwitchReview } from "../consequential/ConsequentialSwitch";
import { moveRoleBackLedger } from "../consequential/roleOnline";

type NoteProps = {
  role: { handle: string; name: string };
  failover: RoleFailover;
  viewerId: string | null;
  nameOf: (userId: string) => string;
  /** Absent when the viewer may not move the role. */
  onMoveBack?: () => void;
  /** Keep here; absent when the viewer may not move the role. */
  onKeep?: () => void;
  className?: string;
};

/** The line as the role page mounts it: whether this viewer can move it back
 *  is read from their machines in the store. */
export function RoleFailoverLine(props: NoteProps) {
  const back = useRoleMoveBack(props.failover);
  return <RoleFailoverNote {...props} back={back} />;
}

/** `back`: what a press would meet (roleMoveBackState). Move back is offered
 *  only to a viewer who can make it: a host they may not use shows who can
 *  instead, and a host still offline shows the button held. */
export function RoleFailoverNote({ role, failover: f, viewerId, nameOf, onMoveBack, onKeep, back, className }: NoteProps & { back: MoveBackState | null }) {
  const [reviewing, setReviewing] = useState(false);
  const stuck = !f.to;
  const tone = stuck ? "var(--sol-red)" : "var(--sol-orange)";
  const under = roleFailoverBillsUnder(f, viewerId, nameOf);
  const backRunner = f.from.user_id === viewerId ? "you" : nameOf(f.from.user_id);
  const press = () => (f.cross_user ? setReviewing(true) : onMoveBack?.());
  return (
    <div className={cn("shrink-0 rounded-lg border px-3 py-2 flex items-center gap-2 text-[12px] min-w-0", className)} data-head-failover={stuck ? "stuck" : "moved"} style={{ borderColor: `color-mix(in srgb, ${tone} 45%, transparent)`, background: `color-mix(in srgb, ${tone} 8%, transparent)`, color: "var(--sol-text-secondary)" }}>
      <TriangleAlert className="w-3.5 h-3.5 shrink-0" style={{ color: tone }} />
      <b className="shrink-0 font-semibold" style={{ color: tone }}>{stuck ? "Stuck" : "Moved"}</b>
      <span className="min-w-0 flex-1 flex items-center gap-1.5 truncate">
        <span className="truncate" data-failover-from>{f.from.label}</span>
        {back === "offline" && <span className="shrink-0 text-meta px-1.5 h-[16px] inline-flex items-center rounded-md" style={{ background: "color-mix(in srgb, var(--sol-red) 14%, transparent)", color: "var(--sol-red)" }} data-failover-from-offline>offline</span>}
        {f.to && <><ArrowRight className="w-3 h-3 shrink-0" style={{ color: "var(--sol-text-dim)" }} /><span className="truncate font-medium" style={{ color: "var(--sol-text)" }} data-failover-to>{f.to.label}</span></>}
        <span className="shrink-0" style={{ color: "var(--sol-text-dim)" }}>·</span>
        <span className="truncate" style={{ color: "var(--sol-text-muted)" }}>{roleFailoverReasonWords(f.reason)}</span>
        {stuck && <><span className="shrink-0" style={{ color: "var(--sol-text-dim)" }}>·</span><span className="truncate" style={{ color: "var(--sol-text-muted)" }}>no always-on machine</span></>}
        {under && <><span className="shrink-0" style={{ color: "var(--sol-text-dim)" }}>·</span><span className="shrink-0 font-medium" style={{ color: "var(--sol-orange)" }} data-failover-bills>bills under {under}</span></>}
      </span>
      {f.to && onMoveBack && back === "not_yours" && <span className="shrink-0 truncate max-w-[40%]" style={{ color: "var(--sol-text-dim)" }} data-failover-back-who>{moveBackRefusal(f, back, nameOf)}</span>}
      {f.to && onMoveBack && (back === "ok" || back === "offline") && (
        <OrgButton size="sm" onClick={press} disabled={back === "offline"} title={back === "offline" ? moveBackRefusal(f, back, nameOf) : undefined} data-failover-back={back}><Undo2 className="w-3 h-3" /> Move back</OrgButton>
      )}
      {f.to && onKeep && <OrgButton size="sm" onClick={onKeep} data-failover-keep><Check className="w-3 h-3" /> Keep here</OrgButton>}
      {reviewing && f.to && onMoveBack && (
        <SwitchReview
          ledger={moveRoleBackLedger({ handle: role.handle, name: role.name, here: f.to.label, there: f.from.label, runner: backRunner })}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); onMoveBack(); }}
        />
      )}
    </div>
  );
}
