"use client";
// A person's sheet (cohesive build spec §5.5): the same head their hover
// card and their line say (their place, presence, what they answer for,
// since when; the goals they own), Message and Call, then Now (their work
// role by role, and any open change that names them), what carries them
// (the roles they host or that report to them, the projects those lead),
// their Focus as each role that keeps it has it, and their activity profile.
import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Phone } from "lucide-react";
import { useInboxStore } from "../../../../store/inboxStore";
import { useBoardTasks, useTasksBackfilled } from "../../../../hooks/useInitiatives";
import { useRoleBrief } from "../../../../hooks/useScopeQueries";
import { useCallsAvailable } from "../../../../lib/teamFeatures";
import { AssigneeFace } from "../../../identity/AssigneeFace";
import { useMemberHuddle } from "../../../presence/useMemberHuddle";
import { PersonGoals } from "../../scope/PersonGoals";
import { lineProjectOf, ProjectLine, RoleLine, usePersonHead } from "../../lines";
import { rolesInTreeOrder } from "../../staffingModel";
import type { OrgRole, OrgSession, OrgTree } from "../../orgTypes";
import { NowBar, NowBlock, NowLine } from "../NowBlock";
import { sessionsLine } from "../nowModel";
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
  const router = useRouter();
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
  const { userId, name, line } = head;
  const me = line.me;
  // Their roles as the full tree has them, sessions included.
  const theirRoles = head.roles.map((r) => roles.find((x) => x._id === r._id) ?? r);
  const own = tree?.people.find((p) => p.user_id === userId)?.sessions ?? [];
  const profile = `/team/${encodeURIComponent(line.ref)}`;
  // The roles that keep their focus: every role they report into, whoever hosts it.
  const keepers = roles.filter((r) => (r.reports_user_ids ?? []).includes(userId));
  // What is live for them now; with nothing live the Now is left out.
  const busy = theirRoles.filter((r) => roleNow(r));
  const ownLine = sessionsLine(own);

  return (
    <SheetFrame
      kind="person"
      idRef={null}
      idLabel={me ? "you" : null}
      linkRef={line.ref}
      glyph={<AssigneeFace info={{ name, image: head.image }} size={20} hover={false} />}
      title={name}
      crumbs={[workspaceCrumb(rows)]}
      facts={head.facts}
      serves={head.serves}
      ask={me ? null : { person: { userId, name } }}
      actions={!me && callsOn ? <CallButton userId={userId} name={name} /> : null}
      menu={[{ label: "Activity profile", onSelect: () => router.push(profile) }]}
    >
      <NowBlock
        subject={{ keys: [...head.goals.map((g) => `goal:${g._id}`), ...theirRoles.map((r) => `role:${r.handle.toLowerCase()}`)], refs: head.goals.map((g) => g.short_id).filter(Boolean) as string[], users: [userId] }}
        sessions={[...own, ...theirRoles.flatMap((r) => r.sessions)]}
        rows={rows}
        lead={busy.length > 0 || ownLine ? <PersonNow name={name} busy={busy} own={own} ownLine={ownLine} /> : undefined}
      />

      {(theirRoles.length > 0 || head.leads.length > 0) && (
        <SheetSection title="Carried by">
          <CarriedLines>
            {theirRoles.map((r) => <RoleLine key={r._id} line={{ role: r, reportsTo: r.reports_to.kind === "user" && r.reports_to.user_id === userId ? { name } : null, leads: [], goals: [], charter: r.charter }} now={head.now} sub={r.host_user_id === userId ? "hosts" : "reports to them"} />)}
            {head.leads.map((p) => <ProjectLine key={p._id} project={lineProjectOf(p, { tree, roles, tasks, tasksCounted: counted })} now={head.now} sub="leads" />)}
          </CarriedLines>
        </SheetSection>
      )}

      {keepers.length > 0 && (
        // One Focus, each role that keeps some for them under its own small label; not drawn until one holds some.
        <div className="[&:not(:has([data-focus-from]))]:hidden" data-sheet-focus>
          <SheetSection title="Focus" data="focus" action={keepers.length === 1 ? <span className="text-[11.5px]" style={{ color: DIM }}>kept by {keepers[0].name}</span> : undefined}>
            {keepers.map((r) => <FocusFrom key={r._id} role={r} userId={userId} name={name} me={me} now={head.now} labelled={keepers.length > 1} />)}
          </SheetSection>
        </div>
      )}

      <SheetFolds>
        <Link href={profile} className="flex w-full items-center gap-2 px-1 py-2.5 text-[12.5px] no-underline hover:text-[var(--sol-text)]" style={{ color: "var(--sol-text-muted)" }} data-sheet-activity-profile>
          <ArrowUpRight className="h-3 w-3" />
          Activity profile
          <span className="ml-auto truncate text-[11.5px]" style={{ color: DIM }}>what {me ? "you" : name} did, day by day</span>
        </Link>
      </SheetFolds>
    </SheetFrame>
  );
}

/** Their work right now, role by role: each role with something live, in
 *  the words its own sheet uses, and their own sessions outside any role. A
 *  role's name opens its sheet. */
function PersonNow({ name, busy, own, ownLine }: { name: string; busy: OrgRole[]; own: readonly OrgSession[]; ownLine: ReturnType<typeof sessionsLine> }) {
  const host = useSheetHost();
  return (
    <>
      {busy.map((r) => <RoleNowLine key={r._id} role={r} onOpen={host ? () => host.open("role", r.short_id) : undefined} />)}
      {ownLine && (
        <NowLine data={{ "data-now-own": "" }}>
          <NowBar sessions={own} />
          <span className="shrink-0" style={{ color: "var(--sol-text)" }}>{name}'s own sessions</span>
          <span className="min-w-0 truncate">· {ownLine.line}</span>
        </NowLine>
      )}
    </>
  );
}

/** The person's focus as one role keeps it (their brief's goals section, read
 *  against the work). Nothing until the role holds some. */
function FocusFrom({ role, userId, name, me, now, labelled }: { role: OrgRole; userId: string; name: string; me: boolean; now: number; /** Several roles keep some: each says which it is. */ labelled: boolean }) {
  const { data: brief } = useRoleBrief(role._id);
  const person = brief?.facts?.people?.find((p) => p.user_id === userId);
  if (!person?.has_section || person.goals.length === 0) return null;
  return (
    <div className="mb-2 last:mb-0" data-focus-from={role.short_id}>
      {labelled && <p className="mb-0.5 text-[11.5px]" style={{ color: DIM }}>kept by {role.name}</p>}
      <div className="-mx-2.5"><PersonGoals person={{ ...person, name }} roleHandle={role.handle} now={now} own={me} /></div>
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
      <Phone className="h-3 w-3" /> {huddle.label}
    </button>
  );
}
