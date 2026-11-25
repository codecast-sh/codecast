"use client";
// What an object's page and a role's page share beyond the frame: what a
// role is doing in a Now, and the one line an object not in the store says
// instead.
import { EntityIdPill, TextWithMentions } from "../../../EntityIdPill";
import { RoleFace } from "../../RoleFace";
import type { OrgRole } from "../../orgTypes";
import { NowBar, NowLine } from "../NowBlock";
import { roleNow, roleNowRefs, roleNowSession } from "./sheetModel";
import { roleWords } from "../../orgStaffingTypes";
import { compactAge } from "../../../../lib/threadState";
import { useCoarseNow } from "../../../../hooks/useCoarseNow";
import { useOpenLinkedSession } from "../../../../hooks/useOpenLinkedSession";
import { useInboxStore } from "../../../../store/inboxStore";

/** What a sheet says when the store holds no such object for this workspace. */
export function NotHere({ what }: { what: string }) {
  return <p className="mt-6 text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }} data-sheet-missing title={`This ${what} may belong to another team, or it was removed`}>Not in this workspace.</p>;
}

/** A role's line in a Now. `onOpen` names the role (its face and name open
 *  its sheet), for a sheet that is not the role's own. Its own state line
 *  carries its age quietly. Nothing when the role has nothing live and wrote
 *  no line. The words open the work they name: each object they name by id
 *  is a link to it; words that name none open the session at work (see
 *  roleNowSession), never the one already on screen, and stay plain text
 *  when nothing is left to open. */
export function RoleNowLine({ role, onOpen }: { role: OrgRole; onOpen?: () => void }) {
  const now = roleNow(role);
  const clock = useCoarseNow(60_000);
  const openLinked = useOpenLinkedSession();
  const onScreen = useInboxStore((s) => s.currentSessionId);
  if (!now) return null;
  const named = roleNowRefs(now.words).length > 0;
  const target = named ? null : roleNowSession(role, onScreen);
  return (
    <NowLine data={{ "data-role-now": role.short_id }}>
      <NowBar sessions={role.sessions} />
      {onOpen && (
        <button type="button" onClick={onOpen} className="inline-flex shrink-0 items-center gap-2 hover:underline underline-offset-2" style={{ color: "var(--sol-text)" }} data-role-now-open>
          <RoleFace role={role} size={16} className="shrink-0" />
          {roleWords(role).title}
        </button>
      )}
      {onOpen && <span aria-hidden className="-mx-1" style={{ color: "var(--sol-text-dim)" }}>·</span>}
      {named ? (
        <span className="min-w-0 truncate" title={now.words} data-role-now-words><TextWithMentions text={now.words} bareIds /></span>
      ) : target ? (
        <button type="button" onClick={() => openLinked(target)} className="min-w-0 truncate text-left hover:underline underline-offset-2" title={now.words} data-role-now-words>{now.words}</button>
      ) : (
        <span className="min-w-0 truncate" title={now.words} data-role-now-words>{now.words}</span>
      )}
      {now.at && <span className="-ml-1 shrink-0" style={{ color: "var(--sol-text-dim)" }} data-role-now-age>· {compactAge(clock - now.at)}</span>}
      {now.current && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 pl-1">
          <span style={{ color: "var(--sol-text-dim)" }}>{now.current.state === "working" ? "on" : "waiting in"}</span>
          <EntityIdPill id={now.current._id} shortId={now.current.short_id} type="session" compact />
        </span>
      )}
    </NowLine>
  );
}
