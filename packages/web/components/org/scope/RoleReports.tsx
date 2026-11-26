"use client";
// Who reports to a role, on its Overview: each role under it with what it is
// doing now, and each person under it. The rows read the org tree the page
// already holds, so they move with the chart; a row opens that report's page.
import { useMemo } from "react";
import { roleManagers } from "@codecast/shared/contracts/orgLead";
import { OrgObjectLink } from "../company/OrgObjectLink";
import { roleNow } from "../company/sheets/sheetModel";
import { RoleFace } from "../RoleFace";
import { ORG_STATE_META, stateWords } from "../orgMeta";
import { roleWords } from "../orgStaffingTypes";
import type { OrgPerson, OrgRole, OrgTree, StateCounts } from "../orgTypes";
import { rolePeopleOnTree } from "../../../store/orgSlice";
import { compactAge } from "../../../lib/threadState";
import { stateLineBesideName } from "../../../lib/scopePage";

export type RoleReportsList = { roles: OrgRole[]; people: OrgPerson[] };

/** The roles and people that report to `roleId`, along any of their equal
 *  lines (org-people.md P3). Retired roles are gone from the chart and here. */
function roleReportsOf(tree: Pick<OrgTree, "roles" | "people">, roleId: string): RoleReportsList {
  const roles = tree.roles
    .filter((r) => r._id !== roleId && r.status !== "retired" && roleManagers(r).some((m) => m.kind === "role" && m.role_id === roleId))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { roles, people: rolePeopleOnTree(tree, roleId) };
}

/** The reports' sessions added up, for the section's heading. */
function sumCounts(roles: OrgRole[]): Partial<StateCounts> {
  const out: Partial<StateCounts> = {};
  for (const r of roles) for (const [k, n] of Object.entries(r.counts ?? {})) out[k as keyof StateCounts] = (out[k as keyof StateCounts] ?? 0) + (n as number);
  return out;
}

export function RoleReports({ tree, role, now, label }: { tree: OrgTree; role: OrgRole; now: number; label: string }) {
  const reports = useMemo(() => roleReportsOf(tree, role._id), [tree, role._id]);
  const total = reports.roles.length + reports.people.length;
  if (total === 0) return null;
  const rollup = stateWords(sumCounts(reports.roles), 3);
  return (
    <section data-scope-section="reports">
      <h3 className={`${label} flex items-baseline gap-2`} style={{ color: "var(--sol-text-dim)" }}>
        <span>Reports · {total}</span>
        {rollup.length > 0 && <span className="font-normal normal-case tracking-normal text-meta" style={{ color: "var(--sol-text-muted)" }} data-reports-rollup>{rollup.join(" · ")}</span>}
      </h3>
      <ul className="space-y-0.5">
        {reports.roles.map((r) => <ReportRoleRow key={r._id} role={r} now={now} />)}
        {reports.people.map((p) => (
          <li key={p.user_id}>
            <OrgObjectLink kind="person" objRef={p.user_id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-xl hover:bg-sol-bg-highlight/70 no-underline" data-report-person={p.user_id}>
              {p.image ? <img src={p.image} alt="" className="w-6 h-6 rounded-full shrink-0" /> : <span className="w-6 h-6 rounded-full shrink-0 inline-flex items-center justify-center text-mark font-semibold" style={{ background: "var(--sol-bg-alt)", color: "var(--sol-text-muted)" }}>{p.name.slice(0, 1).toUpperCase()}</span>}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{p.name}</span>
                {(p.title || p.focus) && <span className="block truncate text-meta" style={{ color: "var(--sol-text-muted)" }}>{p.title || p.focus}</span>}
              </span>
              <CountsText counts={p.counts} />
            </OrgObjectLink>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One role under this one: its face and name, its sessions by state, and
 *  the line it is on now (its pinned line or its live sessions). */
function ReportRoleRow({ role, now }: { role: OrgRole; now: number }) {
  const doing = roleNow(role);
  const state = role.standing?.state;
  const paused = role.status === "paused";
  return (
    <li>
      <OrgObjectLink kind="role" objRef={role.short_id} className="flex items-start gap-2.5 px-2.5 py-2 rounded-xl hover:bg-sol-bg-highlight/70 no-underline" data-report-role={role.short_id}>
        <span className="relative shrink-0 mt-[1px]">
          <RoleFace role={role} size={24} />
          {state && <span aria-hidden className="absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full ring-2 ring-[var(--sol-card)]" style={{ background: ORG_STATE_META[state].color }} />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2 min-w-0">
            <span className="truncate text-[12.5px] font-medium" style={{ color: "var(--sol-text)" }}>{roleWords(role).title}</span>
            {paused && <span className="shrink-0 text-meta" style={{ color: "var(--sol-yellow)" }}>paused</span>}
          </span>
          <span className="block truncate text-meta" style={{ color: doing ? "var(--sol-text-muted)" : "var(--sol-text-dim)" }} title={doing?.words} data-report-now>
            {doing ? stateLineBesideName(doing.words, role.name) : role.standing ? "Nothing pinned yet" : "Not started"}
            {doing?.at ? <span style={{ color: "var(--sol-text-dim)" }}> · {compactAge(now - doing.at)}</span> : null}
          </span>
        </span>
        <CountsText counts={role.counts} />
      </OrgObjectLink>
    </li>
  );
}

function CountsText({ counts }: { counts: Partial<StateCounts> | undefined }) {
  const words = stateWords(counts ?? {}, 2);
  if (words.length === 0) return null;
  return <span className="shrink-0 text-meta tabular-nums mt-[1px]" style={{ color: (counts?.needs_input ?? 0) > 0 ? "var(--sol-yellow)" : "var(--sol-text-dim)" }}>{words.join(" · ")}</span>;
}
