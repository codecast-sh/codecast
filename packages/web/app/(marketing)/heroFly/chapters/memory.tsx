"use client";

/**
 * Chapter 12, Memory: three weeks later Sarah searches the palette, and the
 * sessions behind the work come back with the task; then session blame ties
 * line 42 of src/billing/retry.ts to the lead session that applied the
 * decision, under the comment that says why. The
 * palette is the real cmdk rows; the query types itself from the film, and a
 * visitor can type over it (the field listens only while it has focus).
 */

import { useMemo, useState } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { CommandPaletteList } from "@/components/CommandPaletteList";
import { KeyCap } from "@/components/KeyboardShortcutsHelp";
import { PaletteSearchBar, PaletteSearchResultRow, PaletteSessionRow, PaletteTaskRow } from "@/components/PaletteRows";
import { groupClass, paletteClass, paletteInputClass } from "@/components/paletteStyles";
import { STATUS_OPTIONS } from "@/components/menus/entityOptions";
import { BlobView } from "@/components/repo/BlobView";
import { SessionBlameStrip } from "@/components/repo/SessionBlame";
import { Breadcrumb } from "@/components/repo/TreeContent";
import { sessionMatchesQuery } from "@/lib/instantSessionSearch";
import { paletteItemScore } from "@/lib/paletteActions";
import { sessionBlameColors, summarizeSessionBlame } from "@/lib/repoView";
import "@/components/CommandPalette.css";
import "@/components/repo/repo.css";
import type { PartProps } from "./contract";
import { fly, useFilmTime } from "../filmClock";
import { typed } from "../timeline";
import { FILE, MEMORY, RECENT, RESULTS, SEARCH_MIN, TASK, VIEWER, blameRanges } from "../fixtures/memory";
import { PEOPLE, SESSIONS } from "../fixtures/story";

const noop = () => {};
const DONE = STATUS_OPTIONS.find((o) => o.key === TASK.status);
const TASK_STATUS = DONE ? { label: DONE.label, color: DONE.color ?? "" } : undefined;
const AUTHOR = PEOPLE.me.name;

/** Every word of the query somewhere in the text: how the fixtures stand in for the server's content search. */
const wordsIn = (q: string, text: string) => q.split(/\s+/).filter(Boolean).every((w) => text.toLowerCase().includes(w));

export function PaletteSearch({ now }: PartProps) {
  const filmQuery = useFilmTime((t) => typed(MEMORY.query, t, MEMORY.typeAt, MEMORY.typeRate));
  const [typedByVisitor, setTypedByVisitor] = useState<string | null>(null);
  // cmdk scrolls its selected row into view, through every scrolling
  // ancestor, the stage's clip included. A row is selected only while the
  // palette is face-on, where that scroll has nothing to move.
  const [picked, setPicked] = useState("");
  const onScreen = useFilmTime((t) => t >= MEMORY.selectFrom && t < MEMORY.selectTo);
  const query = typedByVisitor ?? filmQuery;
  const q = query.trim().toLowerCase();
  const recent = RECENT.filter((r) => sessionMatchesQuery({ ...r, authorName: VIEWER.name }, q)).slice(0, 4);
  const searching = q.length >= SEARCH_MIN;
  const results = searching ? RESULTS.filter((r) => wordsIn(q, `${r.session.title} ${r.match}`)) : [];
  const tasks = searching && wordsIn(q, `${TASK.title} ${TASK.short_id} webhook retry`) ? [TASK] : [];
  return (
    <div className="flex h-full items-start justify-center pt-5" {...fly("palette/memory.palette")}>
      <CommandPrimitive
        className={paletteClass}
        filter={paletteItemScore}
        loop
        label="Command menu"
        value={onScreen || typedByVisitor !== null ? picked : ""}
        onValueChange={setPicked}
      >
        <PaletteSearchBar trailing={<KeyCap>Esc</KeyCap>}>
          <CommandPrimitive.Input
            data-hero-live=""
            value={query}
            onValueChange={setTypedByVisitor}
            placeholder="Jump to..."
            className={paletteInputClass}
          />
        </PaletteSearchBar>
        <CommandPaletteList>
          {recent.length > 0 && (
            <CommandPrimitive.Group heading="Recent Sessions" className={groupClass}>
              {recent.map((r) => (
                <PaletteSessionRow key={r._id} conv={{ ...r, updated_at: now - r.ago, isOwn: true }} bucket={null} onSelect={noop} />
              ))}
            </CommandPrimitive.Group>
          )}
          {searching && (
            <CommandPrimitive.Group heading={`Search Results (${results.length})`} className={groupClass}>
              {results.map((r) => (
                <PaletteSearchResultRow
                  key={r.session.id}
                  result={{
                    conversationId: r.session.id,
                    title: r.session.title,
                    updatedAt: now - r.ago,
                    isOwn: false,
                    authorName: AUTHOR,
                    matches: Array.from({ length: r.matches }, (_, i) => ({ content: i === 0 ? r.match : undefined })),
                  }}
                  onSelect={noop}
                />
              ))}
            </CommandPrimitive.Group>
          )}
          {tasks.length > 0 && (
            <CommandPrimitive.Group heading="Tasks" className={groupClass}>
              {tasks.map((t) => (
                <PaletteTaskRow key={t._id} task={{ ...t, updated_at: now - t.ago }} status={TASK_STATUS} onSelect={noop} />
              ))}
            </CommandPrimitive.Group>
          )}
        </CommandPaletteList>
      </CommandPrimitive>
    </div>
  );
}

const SELECTION = { start: FILE.line, end: FILE.line };
/** BlobView's line height and the padding above its first line (px, measured). */
const LINE_H = 20;
const LINES_TOP = 3;

export function Blame({ now }: PartProps) {
  const ranges = useMemo(() => blameRanges(now), [now]);
  const summary = useMemo(() => summarizeSessionBlame(ranges), [ranges]);
  const colors = useMemo(() => sessionBlameColors(summary), [summary]);
  const filmFocus = useFilmTime((t) => (t >= MEMORY.focus ? SESSIONS.lead.id : null));
  const [hovered, setHovered] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const focus = hovered ?? pinned ?? filmFocus;
  return (
    <div className="flex h-full flex-col bg-sol-bg pt-3" {...fly("blame/memory.file")}>
      <Breadcrumb repository={FILE.repository} refName="main" path={FILE.path} />
      <div data-hero-live="">
        <SessionBlameStrip
          summary={summary}
          colors={colors}
          focus={focus}
          pinned={pinned}
          onFocus={setHovered}
          onPick={(id) => setPinned((p) => (p === id ? null : id))}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The file scrolled to the lines around 42, the way a #L42 link opens it. */}
        <div style={{ marginTop: -(FILE.top - 1) * LINE_H }}>
          <BlobView
            repository={FILE.repository}
            path={FILE.path}
            content={FILE.content}
            selection={SELECTION}
            onSelectLine={noop}
            blameMode="session"
            sessionRanges={ranges}
            sessionColors={colors}
            focusSession={focus}
          />
        </div>
        {/* The line the decision wrote, lit as its session takes the blame's focus. */}
        <div
          aria-hidden
          {...fly("blame/memory.line", {
            position: "absolute",
            left: 0,
            right: 0,
            top: (FILE.line - FILE.top) * LINE_H + LINES_TOP,
            height: LINE_H,
            transformOrigin: "left",
            pointerEvents: "none",
            mixBlendMode: "multiply",
            background: "color-mix(in srgb, var(--sol-yellow) 22%, transparent)",
          })}
        />
      </div>
    </div>
  );
}
