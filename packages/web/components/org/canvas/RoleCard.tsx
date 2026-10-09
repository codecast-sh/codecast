"use client";
// A role on the canvas (essence spec §4.2). The whole card is one button that
// opens the role. Its face and title, "Wren · @newsletter", its state word
// and the age of its latest line, the line itself with ids drawn as
// reference pills, the projects it leads, and the sessions working under it.
import { RoleFace } from "../RoleFace";
import type { PanelRef } from "../panelTarget";
import type { CanvasRole } from "./canvasModel";
import { IdText, onCardKey, StateWord } from "./cardParts";
import { ProjectBlock } from "./ProjectBlock";

const GHOST_WORDS = { new: "New role, proposed", retires: "Retires" } as const;

export function RoleCard({ role, open, now, onOpen }: { role: CanvasRole; open: boolean; now: number; onOpen: (ref: PanelRef) => void }) {
  const isNew = role.ghost?.kind === "new";
  const openIt = () => { if (!isNew) onOpen({ kind: "role", ref: role.ref }); };
  return (
    <div
      role={isNew ? undefined : "button"} tabIndex={isNew ? undefined : 0}
      className="oc-card" data-canvas-open-key={`role:${role.id}`} data-canvas-role={role.ref}
      {...(open ? { "data-open": "" } : {})}
      {...(role.ghost ? { "data-ghost": role.ghost.kind } : {})}
      {...(role.ghost?.kind === "new" && role.ghost.solid ? { "data-solid": "" } : {})}
      title={role.ghost?.line}
      onClick={openIt}
      onKeyDown={onCardKey(openIt)}
    >
      <div className="oc-chead">
        <RoleFace role={{ handle: role.handle, avatar: role.avatar, name: role.title }} size={34} />
        <div className="min-w-0">
          <div className="oc-title">{role.title}</div>
          <div className="oc-sub">{role.persona} · @{role.handle}{role.under ? ` · under ${role.under}` : ""}</div>
        </div>
      </div>
      {!isNew && <div className="oc-state-row"><StateWord state={role.state} at={role.at} now={now} /></div>}
      {role.line && <div className="oc-latest"><IdText text={role.line} /></div>}
      {role.projects.map((p) => <ProjectBlock key={p.id} project={p} onOpen={onOpen} />)}
      {role.area && <div className="oc-area">{role.area}</div>}
      {role.working.length > 0 && (
        <div className="oc-sessions">
          {role.working.map((s) => (
            <button key={s.id} type="button" className="oc-sess" data-canvas-session={s.id} onClick={(e) => { e.stopPropagation(); onOpen({ kind: "session", id: s.id }); }}>
              <i aria-hidden {...(s.state === "needs_input" ? { "data-input": "" } : {})} />
              <span>{s.title}</span>
              <small>{s.state === "working" ? "working" : "waits for input"}</small>
            </button>
          ))}
        </div>
      )}
      {role.ghost && <div className="oc-ghost">{role.ghost.kind === "moves" ? `moves under ${role.ghost.to}` : GHOST_WORDS[role.ghost.kind]}</div>}
    </div>
  );
}
