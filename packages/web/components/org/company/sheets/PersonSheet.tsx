"use client";
// A person's sheet (cohesive build spec §5.5): the same head their hover
// card and their line say (their place, presence, what they answer for,
// since when; the goals they own), Message and Call, then Now (their work
// role by role, and any open change that names them), what carries them
// (the roles they host or that report to them, the projects those lead),
// their Focus as each role that keeps it has it, and their activity profile.
import { useCallback, useLayoutEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Phone } from "lucide-react";
import { useInboxStore } from "../../../../store/inboxStore";
import { useBoardTasks, useTasksBackfilled } from "../../../../hooks/useInitiatives";
import { useRoleBrief } from "../../../../hooks/useScopeQueries";
import { useCallsAvailable } from "../../../../lib/teamFeatures";
import { AssigneeFace } from "../../../identity/AssigneeFace";
import { useMemberHuddle } from "../../../presence/useMemberHuddle";
import { firstName } from "../../../calls/speakers";
import { PersonGoals } from "../../scope/PersonGoals";
import { lineProjectOf, ProjectLine, RoleLine, usePersonHead } from "../../lines";
import { rolesInTreeOrder } from "../../staffingModel";
import type { OrgRole, OrgSession, OrgTree, StateCounts } from "../../orgTypes";
import { NowBar, NowBlock, NowLine } from "../NowBlock";
import { liveWords } from "../nowModel";
import { SheetFolds, SheetFrame, SheetSection } from "../SheetFrame";
import { useSheetHost } from "../sheetHost";
import type { SheetRef } from "../sheetStack";
import { useCompanyRows } from "../useCompanyRows";
import { CarriedLines, NotHere, RoleNowLine } from "./sheetParts";
import { roleNow, workspaceCrumb } from "./sheetModel";

const DIM = "var(--sol-text-dim)";
const RULE = "var(--cc-panel-rule, color-mix(in srgb, var(--sol-border) 45%, transparent))";

export function PersonSheet({ sheet }: { sheet: SheetRef }) {
  const rows = useCompanyRows();
  const head = usePersonHead(sheet.ref);
  // The full tree, for the sessions under each of their roles.
  const tree = useInboxStore((s) => s.orgTree) as OrgTree | null;
  const callsOn = useCallsAvailable();
  const tasks = useBoardTasks();
  const counted = useTasksBackfilled();
  const roles = useMemo(() => rolesInTreeOrder(tree), [tree]);

  if (!head) {
    return (
      <SheetFrame kind="person" idRef={null} glyph={null} title={sheet.ref.replace(/^@/, "")} crumbs={[workspaceCrumb(rows)]} loading={rows.members.length === 0}>
        <NotHere what="person" />
      </SheetFrame>
    );
  }
  const { userId, name, line, handle } = head;
  const me = line.me;
  // Every mention after the title: their first name, or "you" on your own sheet.
  const first = firstName(name);
  // Their roles as the full tree has them, sessions included.
  const theirRoles = head.roles.map((r) => roles.find((x) => x._id === r._id) ?? r);
  const person = tree?.people.find((p) => p.user_id === userId);
  const own = person?.sessions ?? [];
  const profile = `/team/${encodeURIComponent(line.ref)}`;
  // The roles that keep their focus: every role they report into, whoever hosts it.
  const keepers = roles.filter((r) => (r.reports_user_ids ?? []).includes(userId));
  // What is live for them now; with nothing live the Now is left out.
  const busy = theirRoles.filter((r) => roleNow(r)?.live);
  // Their own sessions in the words the head uses (the server's count of the
  // sessions filed under them, outside any role); the bar draws the sample the tree carries.
  const ownLine = ownWords(line.sessions, own.length, person?.total ?? own.length);
  const hosted = theirRoles.filter((r) => r.host_user_id === userId);
  const reporting = theirRoles.filter((r) => r.host_user_id !== userId);

  return (
    <SheetFrame
      kind="person"
      idRef={null}
      idLabel={handle ? (me ? `@${handle} · you` : `@${handle}`) : (me ? "you" : null)}
      linkRef={line.ref}
      glyph={<AssigneeFace info={{ name, image: head.image }} size={20} hover={false} />}
      title={name}
      crumbs={[workspaceCrumb(rows)]}
      facts={head.facts}
      serves={head.serves}
      ask={me ? null : { person: { userId, name } }}
      actions={!me && callsOn ? <CallButton userId={userId} name={name} /> : null}
    >
      <NowBlock
        subject={{ keys: [...head.goals.map((g) => `goal:${g._id}`), ...theirRoles.map((r) => `role:${r.handle.toLowerCase()}`)], refs: head.goals.map((g) => g.short_id).filter(Boolean) as string[], users: [userId] }}
        sessions={[...own, ...theirRoles.flatMap((r) => r.sessions)]}
        rows={rows}
        lead={busy.length > 0 || ownLine ? <PersonNow who={me ? "Your" : `${first}'s`} busy={busy} own={own} ownLine={ownLine} /> : undefined}
      />

      {(theirRoles.length > 0 || head.leads.length > 0) && (
        <SheetSection title="Carried by">
          {/* Each relation said once, as a small label over its lines; every line keeps what the role or project is. */}
          <CarriedLines>
            {hosted.length > 0 && <CarriedGroup label={me ? "You host" : `${first} hosts`} data="hosts" />}
            {hosted.map((r) => <RoleLine key={r._id} line={{ role: r, reportsTo: r.reports_to.kind === "user" && r.reports_to.user_id === userId ? { name } : null, leads: [], goals: [], charter: r.charter }} now={head.now} />)}
            {reporting.length > 0 && <CarriedGroup label={`Reports to ${me ? "you" : first}`} data="reports" />}
            {reporting.map((r) => <RoleLine key={r._id} line={{ role: r, reportsTo: null, leads: [], goals: [], charter: r.charter }} now={head.now} />)}
            {head.leads.length > 0 && <CarriedGroup label="Led by these roles" data="leads" />}
            {head.leads.map((p) => <ProjectLine key={p._id} project={lineProjectOf(p, { tree, roles, tasks, tasksCounted: counted })} now={head.now} />)}
          </CarriedLines>
        </SheetSection>
      )}

      {keepers.length > 0 && <PersonFocus keepers={keepers} userId={userId} name={name} first={first} me={me} now={head.now} />}

      <SheetFolds>
        <Link href={profile} className="flex w-full items-center gap-2 px-1 py-2.5 text-[12.5px] no-underline hover:text-[var(--sol-text)]" style={{ color: "var(--sol-text-muted)" }} data-sheet-activity-profile>
          <ArrowUpRight className="h-3 w-3" />
          Activity profile
          <span className="ml-auto truncate text-[11.5px]" style={{ color: DIM }}>what {me ? "you" : first} did, day by day</span>
        </Link>
      </SheetFolds>
    </SheetFrame>
  );
}

/** "7 sessions at work, 49 waiting on input · 8 shown": the live counts the
 *  head reads, and how many of them the bar beside it draws when the tree
 *  carries only a sample. Null when nothing of theirs is live. */
function ownWords(counts: Partial<StateCounts> | null, drawn: number, total: number): string | null {
  const words = liveWords(counts);
  if (!words) return null;
  return drawn < total ? `${words} · ${drawn} shown` : words;
}

/** A small label over a group of Carried by lines: how they carry this person, said once. */
function CarriedGroup({ label, data }: { label: string; data: string }) {
  return <p className="mb-0.5 mt-2 px-1 text-[11.5px] first:mt-0" style={{ color: DIM }} data-carried-group={data}>{label}</p>;
}

/** Their work right now, role by role: each role with something live, in
 *  the words its own sheet uses, and their own sessions outside any role. A
 *  role's name opens its sheet. */
function PersonNow({ who, busy, own, ownLine }: { who: string; busy: OrgRole[]; own: readonly OrgSession[]; ownLine: string | null }) {
  const host = useSheetHost();
  return (
    <>
      {busy.map((r) => <RoleNowLine key={r._id} role={r} onOpen={host ? () => host.open("role", r.short_id) : undefined} />)}
      {ownLine && (
        <NowLine data={{ "data-now-own": "" }}>
          <NowBar sessions={own} />
          <span className="shrink-0" style={{ color: "var(--sol-text)" }}>{who} own sessions</span>
          <span className="min-w-0 truncate" data-now-own-words>· {ownLine}</span>
        </NowLine>
      )}
    </>
  );
}

/** What one keeper's brief holds for them: "held" when it has their focus, "empty" when it has none. */
type Kept = "held" | "empty";

/** Their Focus, as each role that keeps it has it. Drawn once every keeper's
 *  brief has answered (or the first that holds some has), so it never
 *  flashes in; when none holds any, one line says who keeps it, and the
 *  role's name opens its sheet, where its Ask box can set it. */
function PersonFocus({ keepers, userId, name, first, me, now }: { keepers: OrgRole[]; userId: string; name: string; first: string; me: boolean; now: number }) {
  const host = useSheetHost();
  const [kept, setKept] = useState<Record<string, Kept>>({});
  const report = useCallback((id: string, k: Kept) => setKept((m) => (m[id] === k ? m : { ...m, [id]: k })), []);
  const held = keepers.some((r) => kept[r._id] === "held");
  const settled = keepers.every((r) => kept[r._id]);
  const empty = settled && !held;
  const whose = me ? "your" : `${first}'s`;
  return (
    <div hidden={!held && !settled} data-sheet-focus>
      <SheetSection title="Focus" data="focus" action={keepers.length === 1 && !empty ? <span className="text-[11.5px]" style={{ color: DIM }}>kept by {keepers[0].name}</span> : undefined}>
        {keepers.map((r) => <FocusFrom key={r._id} role={r} userId={userId} name={name} me={me} now={now} labelled={keepers.length > 1} report={report} />)}
        {empty && (
          <p className="px-1 text-[12.5px] leading-relaxed" style={{ color: DIM }} data-focus-empty>
            {keepers.map((r, i) => (
              <span key={r._id}>
                {i > 0 && (i === keepers.length - 1 ? " and " : ", ")}
                {host
                  ? <button type="button" onClick={() => host.open("role", r.short_id)} className="hover:underline underline-offset-2" style={{ color: "var(--sol-text-muted)" }} data-focus-keeper={r.short_id}>{r.name}</button>
                  : <span style={{ color: "var(--sol-text-muted)" }}>{r.name}</span>}
              </span>
            ))}
            {keepers.length === 1 ? ` keeps ${whose} focus and has none yet.` : ` keep ${whose} focus and have none yet.`}
          </p>
        )}
      </SheetSection>
    </div>
  );
}

/** The person's focus as one role keeps it (their brief's goals section, read
 *  against the work). Nothing until the role holds some; it tells the Focus
 *  what it found once the brief answers. */
function FocusFrom({ role, userId, name, me, now, labelled, report }: { role: OrgRole; userId: string; name: string; me: boolean; now: number; /** Several roles keep some: each says which it is. */ labelled: boolean; report: (id: string, k: Kept) => void }) {
  const { data: brief, error } = useRoleBrief(role._id);
  const person = brief?.facts?.people?.find((p) => p.user_id === userId);
  const has = !!person?.has_section && person.goals.length > 0;
  const answered = brief !== undefined || !!error;
  // Before paint, so the section is drawn in the same frame the answer lands.
  useLayoutEffect(() => { if (answered) report(role._id, has ? "held" : "empty"); }, [answered, has, role._id, report]);
  if (!has) return null;
  return (
    <div className="mb-2 last:mb-0" data-focus-from={role.short_id}>
      {labelled && <p className="mb-0.5 text-[11.5px]" style={{ color: DIM }}>kept by {role.name}</p>}
      <div className="-mx-2.5"><PersonGoals person={{ ...person!, name }} roleHandle={role.handle} now={now} own={me} /></div>
    </div>
  );
}

/** Ring them into a huddle (or join the one they are in), the gesture their face offers everywhere. */
function CallButton({ userId, name }: { userId: string; name: string }) {
  const meId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : ""));
  // The two fields the gesture reads; the roster re-pushes on every heartbeat.
  const inRoom = useInboxStore((s) => ((s.teamMembers ?? []) as { _id: string; in_room_key?: string }[]).find((m) => String(m._id) === userId)?.in_room_key);
  const member = useMemo(() => ({ _id: userId, in_room_key: inRoom }), [userId, inRoom]);
  const huddle = useMemberHuddle(member, meId, null, name);
  return (
    <button
      type="button"
      onClick={huddle.go}
      disabled={huddle.waiting}
      className="inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] transition-colors hover:bg-sol-bg-highlight/60 disabled:opacity-60"
      style={{ borderColor: RULE, color: "var(--sol-text-secondary)" }}
      title={huddle.title}
      data-sheet-call={userId}
    >
      {/* "Call" is the sheet's word for ringing them (spec §5.5); the other states keep theirs. */}
      <Phone className="h-3 w-3" /> {huddle.label === "Huddle" ? "Call" : huddle.label}
    </button>
  );
}
