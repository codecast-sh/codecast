// The person's own to-dos, notes and routines a search names, above the
// conversations on /search. The matchers are the palette's (lib/universalSearch:
// matchMentionGroups, matchRoutines), read from the local store, so these
// answer as the person types and agree with Cmd+K. In the Assistant scope the
// to-dos and notes are the ones the To-dos and Notes pages list
// (assistantSearchIndex). Each hit is a compact row like the palette's: the
// glyph its page draws, the title with the words found marked, and when.
import { useMemo } from "react";
import Link from "next/link";
import { Circle, Repeat } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { triggerSig } from "../../hooks/useSyncTriggers";
import { assistantSearchIndex, humanSearchIndex, matchMentionGroups, matchRoutines, openTasksFirst } from "../../lib/universalSearch";
import { isAssistantRoutine, withinScope } from "../../lib/assistantScope";
import { useModeWords } from "../../lib/surfaces";
import { highlightMatch } from "../../lib/searchHighlight";
import { hostedRowTime } from "../../lib/sameNameSuffix";
import { NavIcon } from "../PaletteRows";
import { StampTime } from "../StampTime";

const CAP = 5;

type Row = { key: string; href: string; title: string; at?: number; done?: boolean };

function Group({ heading, glyph, rows, query }: { heading: string; glyph: (row: Row) => React.ReactNode; rows: Row[]; query: string }) {
  if (rows.length === 0) return null;
  return (
    <section data-search-object-group={heading}>
      <h2 className="mb-1 px-1 text-[12px] text-sol-text-muted">{heading} <span className="ml-0.5 tabular-nums text-sol-text-dim">{rows.length}</span></h2>
      <ul className="flex flex-col">
        {rows.map((r) => (
          <li key={r.key}>
            <Link href={r.href} className="flex min-w-0 items-center gap-2.5 rounded-md px-1 py-1.5 text-[13.5px] text-sol-text no-underline hover:bg-sol-bg-highlight/60">
              <span className="flex w-4 shrink-0 justify-center text-sol-text-dim">{glyph(r)}</span>
              <span className={`min-w-0 flex-1 truncate ${r.done ? "text-sol-text-muted" : ""}`}>{highlightMatch(r.title, query)}</span>
              {r.at ? <span className="shrink-0 text-[12px] tabular-nums text-sol-text-dim"><StampTime ts={r.at} format={hostedRowTime} /></span> : null}
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
    const index = scopeOnly ? assistantSearchIndex(st) : humanSearchIndex(st);
    const { tasks, docs } = matchMentionGroups(index, query, teamId, CAP);
    return {
      tasks: openTasksFirst(tasks).map((t) => ({ key: t._id, href: `/tasks/${t._id}`, title: t.title || "Untitled", at: t.updated_at, done: t.status === "done" })),
      docs: docs.map((d) => ({ key: d._id, href: `/docs/${d._id}`, title: d.title || "Untitled", at: d.updated_at })),
      routines: matchRoutines<any>(withinScope<any>(routines, scopeOnly, isAssistantRoutine), query, CAP)
        .map((t) => ({ key: String(t._id), href: `/triggers/${t._id}`, title: t.title || "Routine" })),
    };
  }, [query, teamId, routines, scopeOnly]);
  if (!groups || (!groups.tasks.length && !groups.docs.length && !groups.routines.length)) return null;
  return (
    <div className="space-y-4" data-search-objects>
      {/* The To-dos page's glyphs: an open circle, a check once done. */}
      <Group heading={words.tasksPage} query={query} glyph={(r) => (r.done ? <NavIcon type="check" /> : <Circle className="h-4 w-4" strokeWidth={1.5} />)} rows={groups.tasks} />
      <Group heading={words.docsPage} query={query} glyph={() => <NavIcon type="file" />} rows={groups.docs} />
      <Group heading={words.triggers} query={query} glyph={() => <Repeat className="h-4 w-4" />} rows={groups.routines} />
    </div>
  );
}
