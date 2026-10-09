"use client";
// A role on the canvas (essence spec §4.2). The whole card is one button that
// opens the role. Its face and title, "Sorrel · @cold-email", its state word
// and the age of its latest line, the line itself with ids drawn as
// reference pills, the projects it leads, and the sessions working under it.
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { bareEntityIdRegex, entityMentionRegex } from "@codecast/shared/entities";
import { EntityIdPill } from "../../EntityIdPill";
import { compactAge } from "../../../lib/threadState";
import { RoleFace } from "../RoleFace";
import type { PanelRef } from "../panelTarget";
import type { CanvasRole, RoleState } from "./canvasModel";
import { ProjectBlock } from "./ProjectBlock";

/** A role's state in one word, in the canvas's one vocabulary: Waiting on
 *  you (orange, the only orange), Working (green), else Quiet, Paused, Not
 *  started or Handing over, said plainly. `age` follows it: "Quiet · 4h". */
export function StateWord({ state, at, now }: { state: RoleState; at?: number | null; now?: number }) {
  const age = at && now ? compactAge(Math.max(0, now - at)) : null;
  return (
    <span className="oc-state" data-state={state.kind}>
      <i aria-hidden />
      {state.label}{age ? ` · ${age}` : ""}
    </span>
  );
}

/** A role's own words with every id in them drawn as a live reference pill
 *  (its title and state), never as bare `ct-123`. */
export function IdText({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const mention = entityMentionRegex();
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (chunk: string, base: number) => {
    const bare = bareEntityIdRegex();
    let at = 0;
    let b: RegExpExecArray | null;
    while ((b = bare.exec(chunk))) {
      if (b.index > at) parts.push(chunk.slice(at, b.index));
      parts.push(<EntityIdPill key={base + b.index} shortId={b[0]} />);
      at = b.index + b[0].length;
    }
    if (at < chunk.length) parts.push(chunk.slice(at));
  };
  while ((m = mention.exec(text))) {
    if (m.index > last) plain(text.slice(last, m.index), last);
    parts.push(m[2] ? <EntityIdPill key={`m${m.index}`} shortId={m[2]} label={m[1].trim()} /> : `@${m[1].trim()}`);
    last = mention.lastIndex;
  }
  if (last < text.length) plain(text.slice(last), last);
  // A pill opens its object; it never also opens the card around it.
  return <span onClick={(e: MouseEvent) => { if ((e.target as Element).closest?.("a,button,[role=link]")) e.stopPropagation(); }}>{parts}</span>;
}

/** Enter or Space on the card itself opens it, as a click does. */
export const onCardKey = (open: () => void) => (e: KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
};

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
