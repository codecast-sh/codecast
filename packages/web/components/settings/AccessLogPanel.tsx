/**
 * Settings > Access log: every open, export, download and staff read of a
 * regulated team's data (convex accessLog.ts), newest first. Team admins of
 * a team with regulated mode on only. A per-view paged query read straight
 * here: the log is never synced into the store, and nothing else reads it.
 */
import { usePaginatedQuery } from "convex/react";
import { ScrollText } from "lucide-react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { parseTeamPolicy } from "@codecast/shared/contracts";
import { useInboxStore } from "../../store/inboxStore";
import { EntityIdPill } from "../EntityIdPill";
import { PublishedPagePill } from "../PublishedPageEmbed";
import { Button } from "../ui/button";
import { SettingsLinkRow, SettingsPanel, SettingsSection } from "./ui";

const PAGE = 50;

const ACTION_TONE: Record<string, string> = {
  open: "text-sol-text-muted",
  export: "text-sol-yellow",
  download: "text-sol-yellow",
  staff_read: "text-sol-magenta",
  delete: "text-sol-red",
};

const ACTION_LABEL: Record<string, string> = {
  open: "open",
  export: "export",
  download: "download",
  staff_read: "staff read",
  delete: "delete",
};

type Row = {
  _id: string;
  at: number;
  actor: string;
  actor_email: string | null;
  action: string;
  object_table: string;
  object_id: string;
  object_short_id: string | null;
  client: string;
  detail: string | null;
};

const when = (at: number) =>
  new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });

/** The object as a live reference: the pill opens it and shows its current title. */
function ObjectRef({ row }: { row: Row }) {
  if (row.object_table === "artifacts" && row.object_short_id) {
    return <PublishedPagePill slug={row.object_short_id} href={`/a/${row.object_short_id}`} />;
  }
  if (row.object_table === "conversations") return <EntityIdPill type="session" id={row.object_short_id ?? row.object_id} compact />;
  if (row.object_table === "transcripts") return <EntityIdPill type="call" id={row.object_short_id ?? row.object_id} compact />;
  if (row.object_table === "tasks" || row.object_table === "plans" || row.object_table === "docs") {
    return <EntityIdPill id={row.object_short_id ?? row.object_id} compact />;
  }
  return <span className="font-mono text-xs text-sol-text-dim">{row.object_short_id ?? row.object_id}</span>;
}

export function AccessLogPanel({ teamId }: { teamId: Id<"teams"> }) {
  const { results, status, loadMore } = usePaginatedQuery(api.accessLog.listForTeam, { team_id: teamId }, { initialNumItems: PAGE });
  const rows = results as Row[];
  return (
    <SettingsPanel>
      <SettingsSection title="Access log" icon={ScrollText} actions={<span className="tabular-nums text-xs text-sol-text-dim">{rows.length}{status === "CanLoadMore" ? "+" : ""}</span>}>
        <table className="w-full text-xs" data-access-log>
          <thead>
            <tr className="border-b border-sol-border/40 text-left text-[11px] uppercase tracking-wide text-sol-text-dim">
              <th className="py-1.5 pr-3 font-medium">When</th>
              <th className="py-1.5 pr-3 font-medium">Who</th>
              <th className="py-1.5 pr-3 font-medium">What</th>
              <th className="py-1.5 pr-3 font-medium">Action</th>
              <th className="py-1.5 font-medium">Client</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r._id} className="border-b border-sol-border/20 align-middle">
                <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-sol-text-muted">{when(r.at)}</td>
                <td className="max-w-[12rem] truncate py-1.5 pr-3 text-sol-text" title={r.actor_email ?? r.actor}>{r.actor}</td>
                <td className="max-w-[16rem] py-1.5 pr-3" title={r.detail ?? undefined}>
                  <ObjectRef row={r} />
                </td>
                <td className={`whitespace-nowrap py-1.5 pr-3 ${ACTION_TONE[r.action] ?? "text-sol-text-muted"}`}>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td className="whitespace-nowrap py-1.5 text-sol-text-muted">{r.client}</td>
              </tr>
            ))}
            {status === "LoadingFirstPage" &&
              Array.from({ length: 4 }, (_, i) => (
                <tr key={`s${i}`} className="border-b border-sol-border/20">
                  <td colSpan={5} className="py-2"><div className="h-3 w-full animate-pulse rounded bg-sol-bg-alt" /></td>
                </tr>
              ))}
            {status === "Exhausted" && rows.length === 0 && (
              <tr><td colSpan={5} className="py-3 text-sol-text-dim">No access yet</td></tr>
            )}
          </tbody>
        </table>
        {status === "CanLoadMore" || status === "LoadingMore" ? (
          <div className="flex justify-center pt-2">
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={status === "LoadingMore"} onClick={() => loadMore(PAGE)}>
              Older
            </Button>
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPanel>
  );
}

/** Team settings' way in, beside Managed devices: shown only for a regulated team. */
export function AccessLogLink({ teamId }: { teamId: string }) {
  const regulated = useInboxStore((s) => parseTeamPolicy((s.teams || []).find((t: any) => String(t._id) === teamId)?.policy).regulated_data === true);
  if (!regulated) return null;
  return (
    <SettingsSection>
      <SettingsLinkRow icon={ScrollText} label="Access log" onClick={() => useInboxStore.getState().openSettingsModal("access-log")} />
    </SettingsSection>
  );
}
