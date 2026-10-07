// The person's own to-dos, notes and routines a search names, above the
// conversations on /search. The matchers are the palette's (lib/universalSearch:
// matchMentionGroups over searchIndexOf, matchRoutines), read from the local
// store, so these answer as the person types and agree with Cmd+K.
import { useMemo } from "react";
import Link from "next/link";
import { CheckSquare, FileText, Repeat } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { triggerSig } from "../../hooks/useSyncTriggers";
import { matchMentionGroups, matchRoutines, searchIndexOf } from "../../lib/universalSearch";
import { isAssistantRoutine, isAssistantTask, withinScope } from "../../lib/assistantScope";
import { isOnHumanBoard } from "@codecast/shared/tasks";
import { useModeWords } from "../../lib/surfaces";

const CAP = 5;

type Row = { key: string; href: string; title: string };

function Group({ heading, icon, rows }: { heading: string; icon: React.ReactNode; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section data-search-object-group={heading}>
      <h2 className="mb-1 text-[12px] text-sol-text-muted">{heading}</h2>
      <ul className="overflow-hidden rounded-xl border border-sol-border bg-sol-bg-alt divide-y divide-sol-border/50">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="flex min-w-0 items-center gap-2.5 px-4 py-2 text-[13.5px] text-sol-text no-underline hover:bg-sol-base02/30">
              <span className="shrink-0 text-sol-text-dim">{icon}</span>
              <span className="truncate">{r.title}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ObjectMatches({ query, scopeOnly }: { query: string; scopeOnly: boolean }) {
  const words = useModeWords();
  const teamId = useInboxStore((s) => s.clientState.ui?.active_team_id ?? undefined);
  const routines = useCollectionRows<any>("agentTasks", { sig: triggerSig });
  // Read at the query's change, not on every entity sync: the store's
  // collections churn and the page need not repaint with them.
  const groups = useMemo(() => {
    if (!query.trim()) return null;
    const st = useInboxStore.getState();
    const index = searchIndexOf(st);
    // The To-dos page's rows: the person's board, and in the Assistant scope
    // only the assistant's (isAssistantTask, by the agent of the conversation
    // that made it).
    const tasksShown = Object.fromEntries(Object.entries(index.tasks).filter(([, t]: [string, any]) =>
      isOnHumanBoard(t) && (!scopeOnly || isAssistantTask({ ...t, source_agent_type: t.created_from_conversation ? st.sessions[t.created_from_conversation]?.agent_type ?? null : null }))));
    const { tasks, docs } = matchMentionGroups({ ...index, tasks: tasksShown }, query, teamId, CAP);
    return {
      tasks: tasks.map((t) => ({ key: t._id, href: `/tasks/${t._id}`, title: t.title || "Untitled" })),
      docs: docs.map((d) => ({ key: d._id, href: `/docs/${d._id}`, title: d.title || "Untitled" })),
      routines: matchRoutines<any>(withinScope<any>(routines, scopeOnly, isAssistantRoutine), query, CAP)
        .map((t) => ({ key: String(t._id), href: `/triggers/${t._id}`, title: t.title || "Routine" })),
    };
  }, [query, teamId, routines, scopeOnly]);
  if (!groups || (!groups.tasks.length && !groups.docs.length && !groups.routines.length)) return null;
  return (
    <div className="space-y-4" data-search-objects>
      <Group heading={words.tasksPage} icon={<CheckSquare className="h-4 w-4" />} rows={groups.tasks} />
      <Group heading={words.docsPage} icon={<FileText className="h-4 w-4" />} rows={groups.docs} />
      <Group heading={words.triggers} icon={<Repeat className="h-4 w-4" />} rows={groups.routines} />
    </div>
  );
}
