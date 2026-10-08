"use client";
// A project's expectations as a document (the-line-model.md LM5): plain
// sentences about how the product should behave, grouped by area, each with
// the words it came from. Self-contained: it feeds its own row and paints
// from the store, so the project's Expectations tab and the line map's node
// panel mount the same thing (`variant` decides how much it shows).
//
// - Open proposals first, since they wait on someone: each change with its
//   sources, answered here with Apply or Drop. A proposal's card in the queue
//   is the same decision, so answering here answers it there.
// - Each line: its words, the id a finding cites, its sources as quotes with
//   who and when, and (on the page) how often findings broke it lately, with
//   the findings and the causes they opened.
// - Writes: add a line in your own words (with a source if you have one),
//   change one, settle its open question, retire it. Each is a proposal that
//   applies as you make it when personEditApplies says so (the server
//   applies by the same rule), else it waits for the project's person.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ChevronRight, Plus, Search } from "lucide-react";
import {
  citationFromInput,
  personEditApplies,
  personOp,
  type Expectation,
  type ExpectationCitation,
  type ExpectationOp,
  type PersonEdit,
} from "@codecast/shared/contracts/expectations";
import { EntityIdPill } from "../EntityIdPill";
import { useInboxStore } from "../../store/inboxStore";
import { useProjectExpectations, useSyncProjectExpectations, type ExpectationFinding, type ExpectationProposalView, type ProjectExpectationsRow } from "../../hooks/useSyncProjectExpectations";
import { ageShort } from "../../lib/lineFlow";
import { shortDay } from "../../lib/line/runReport";
import { cn } from "../../lib/utils";
import { byArea, filterCounts, filterLines, LINE_FILTERS, lineHeat, openProposals, sourceSpeaker, usageOf, type LineFilter } from "../../lib/expectations/view";
import { CitationLine } from "./CitationRef";

const SOURCES_SHOWN = 1;

const sameWords = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const inputCls = "rounded-md border border-sol-border/50 bg-sol-bg px-2 py-1 text-[12.5px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-blue/60 focus:outline-none";
const quietBtn = "text-[11.5px] text-sol-text-dim hover:text-sol-text-muted";
const actBtn = (tone: "blue" | "green" | "orange" | "plain") => cn(
  "rounded-md border px-2.5 py-0.5 text-[11.5px] transition-colors disabled:opacity-40 disabled:hover:bg-transparent",
  tone === "blue" && "border-sol-blue/40 text-sol-blue hover:bg-sol-blue/10",
  tone === "green" && "border-sol-green/40 text-sol-green hover:bg-sol-green/10",
  tone === "orange" && "border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10",
  tone === "plain" && "border-sol-border/50 text-sol-text-muted hover:bg-sol-bg-alt",
);

/** Who decides what waits, in a sentence's words. */
const personWord = (row: ProjectExpectationsRow | undefined) => row?.person ? row.person : "the project's person";

/** Lands a link to one line (`#ex-<project>-<n>`, as a finding cites it) once the document has rendered: the row is marked, since CSS :target never matches a row mounted after the hash was set. */
function useLandOnHash(dep: unknown) {
  useEffect(() => {
    const land = () => {
      const id = decodeURIComponent(window.location.hash.slice(1));
      document.querySelectorAll("[data-expectation][data-landed]").forEach((el) => el.removeAttribute("data-landed"));
      const el = id.startsWith("ex-") ? document.getElementById(id) : null;
      if (!el) return;
      el.setAttribute("data-landed", "");
      el.scrollIntoView({ block: "center" });
    };
    land();
    window.addEventListener("hashchange", land);
    return () => window.removeEventListener("hashchange", land);
  }, [dep]);
}

export type DocumentVariant = "page" | "panel";

/**
 * The document. `page` adds the rail (filters, areas, search), each line's
 * usage and findings; `panel` is the compact form a side panel holds.
 * `adding` opens the add form from outside (the page header's button).
 */
export function ExpectationsDocument({ projectId, variant = "page", adding, onAddingChange }: {
  projectId: string;
  variant?: DocumentVariant;
  adding?: boolean;
  onAddingChange?: (open: boolean) => void;
}) {
  const { ready } = useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  const items = row?.doc?.items ?? [];
  const active = useMemo(() => items.filter((e) => e.status === "active"), [items]);
  const retired = useMemo(() => items.filter((e) => e.status === "retired"), [items]);
  const open = useMemo(() => openProposals(row), [row]);
  const [filter, setFilter] = useState<LineFilter>("all");
  const [query, setQuery] = useState("");
  const shown = useMemo(() => (variant === "page" ? filterLines(active, row, filter, query) : active), [active, row, filter, query, variant]);
  const areas = useMemo(() => byArea(shown), [shown]);
  const allAreas = useMemo(() => byArea(active).map(([a]) => a), [active]);
  const counts = useMemo(() => filterCounts(active, row), [active, row]);
  const [localAdding, setLocalAdding] = useState(false);
  const addOpen = adding ?? localAdding;
  const setAddOpen = onAddingChange ?? setLocalAdding;
  useLandOnHash(row?.doc);

  if (!row && !ready) return <p className="text-[12.5px] text-sol-text-dim" data-expectations-loading>Reading the expectations…</p>;
  if (!row) return null;

  const addForm = addOpen && <AddLine projectId={projectId} row={row} areas={allAreas} onClose={() => setAddOpen(false)} />;
  const lines = (
    <div className="space-y-6" data-expectations-lines>
      {areas.map(([area, lines]) => (
        <section key={area} id={`area-${slug(area)}`} className="scroll-mt-4" data-expectations-part={area}>
          <h3 className="mb-1.5 flex items-baseline gap-2 border-b border-sol-border/25 pb-1 text-[12.5px] font-semibold text-sol-text">
            {area}
            <span className="text-[11px] font-normal tabular-nums text-sol-text-dim">{lines.length}</span>
          </h3>
          <ul className="divide-y divide-sol-border/15" data-expectations>
            {lines.map((e) => <Line key={e.id} e={e} projectId={projectId} row={row} areas={allAreas} variant={variant} />)}
          </ul>
        </section>
      ))}
      {active.length > 0 && shown.length === 0 && (
        <p className="text-[12.5px] text-sol-text-dim" data-expectations-none-match>No line matches{query ? ` "${query}"` : ""} under this filter.</p>
      )}
    </div>
  );

  if (variant === "panel") {
    return (
      <div className="space-y-4" data-expectations-document="panel">
        {open.length > 0 && <Proposals projectId={projectId} row={row} proposals={open} />}
        {active.length === 0 && open.length === 0 && (
          <p className="text-[12.5px] text-sol-text-dim" data-expectations-empty>
            No expectations yet. Add the first line below, or let the daily routine propose them from what the team says.
          </p>
        )}
        {lines}
        {addForm || (
          <button type="button" onClick={() => setAddOpen(true)} className="inline-flex items-center gap-1 text-[12px] text-sol-text-dim hover:text-sol-text" data-expectation-add>
            <Plus className="w-3.5 h-3.5" />Add a line
          </button>
        )}
        {retired.length > 0 && <Retired items={retired} row={row} />}
      </div>
    );
  }

  return (
    <div className="space-y-8" data-expectations-document="page">
      {open.length > 0 && <Proposals projectId={projectId} row={row} proposals={open} />}
      {addForm}
      {active.length > 0 && (
        <div className="grid gap-8 lg:grid-cols-[12.5rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-4 lg:self-start space-y-5" data-expectations-rail>
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
              <input value={query} onChange={(ev) => setQuery(ev.target.value)} placeholder="Find a line" className={cn(inputCls, "w-full pl-7")} data-expectations-search />
            </label>
            <nav className="space-y-0.5" aria-label="Filter lines" data-expectations-filters>
              {LINE_FILTERS.map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} aria-pressed={filter === f}
                  className={cn("flex w-full items-baseline justify-between rounded px-2 py-1 text-left text-[12px] transition-colors", filter === f ? "bg-sol-bg-alt text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt/60")}
                  data-expectations-filter={f}>
                  <span>{FILTER_LABEL[f]}</span>
                  <span className="tabular-nums text-[11px] text-sol-text-dim">{counts[f]}</span>
                </button>
              ))}
            </nav>
            {allAreas.length > 1 && (
              <nav aria-label="Areas" className="hidden lg:block" data-expectations-areas>
                <div className="mb-1 px-2 text-[11px] text-sol-text-dim">Areas</div>
                {byArea(active).map(([area, ls]) => (
                  <a key={area} href={`#area-${slug(area)}`} className="flex items-baseline justify-between rounded px-2 py-0.5 text-[12px] text-sol-text-muted hover:bg-sol-bg-alt/60 hover:text-sol-text">
                    <span className="truncate">{area}</span>
                    <span className="ml-2 tabular-nums text-[11px] text-sol-text-dim">{ls.length}</span>
                  </a>
                ))}
              </nav>
            )}
          </aside>
          <div className="min-w-0">{lines}</div>
        </div>
      )}
      {retired.length > 0 && <Retired items={retired} row={row} />}
    </div>
  );
}

const FILTER_LABEL: Record<LineFilter, string> = { all: "Every line", broken: "Broken lately", quiet: "Never cited", questions: "Open questions" };

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The sources behind a line or a change: the first in full, the rest a click away. */
function Sources({ citations, row, hideQuoteOf }: { citations: ExpectationCitation[]; row: ProjectExpectationsRow; hideQuoteOf?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? citations : citations.slice(0, SOURCES_SHOWN);
  const more = citations.length - shown.length;
  if (citations.length === 0) return null;
  return (
    <div className="mt-1 space-y-1 border-l border-sol-border/40 pl-2.5" data-expectation-sources>
      {/* A person's own line cites the very words of the line: the quote would repeat it. */}
      {shown.map((c, i) => {
        const { who, where } = sourceSpeaker(row, c);
        return <CitationLine key={`${c.kind}-${c.ref}-${i}`} c={c} who={who} where={where} quote={!(hideQuoteOf && c.quote && sameWords(c.quote, hideQuoteOf))} />;
      })}
      {more > 0 && (
        <button type="button" onClick={() => setAll(true)} className="text-[11px] text-sol-text-dim hover:text-sol-text-muted" data-expectation-more-sources>
          {more} more {more === 1 ? "source" : "sources"}
        </button>
      )}
    </div>
  );
}

type LineMode = null | "edit" | "retire" | "settle" | "findings";

/** One active line: its words, the id a finding cites, its sources, how often it broke lately, and its edits. */
function Line({ e, projectId, row, areas, variant }: { e: Expectation; projectId: string; row: ProjectExpectationsRow; areas: string[]; variant: DocumentVariant }) {
  const [mode, setMode] = useState<LineMode>(null);
  const editExpectations = useInboxStore((s) => s.editExpectations);
  const youAnswer = !!row.you_answer;
  const usage = usageOf(row, e.id);
  const toggle = (m: LineMode) => setMode((cur) => (cur === m ? null : m));
  const actions = (
    <span className="inline-flex gap-3 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" data-expectation-actions>
      <button type="button" onClick={() => toggle("edit")} className={cn(quietBtn, "hover:text-sol-blue")} data-expectation-edit={e.id}>Edit</button>
      {e.note && <button type="button" onClick={() => toggle("settle")} className={cn(quietBtn, "hover:text-sol-yellow")} data-expectation-settle={e.id}>Settle question</button>}
      <button type="button" onClick={() => toggle("retire")} className={cn(quietBtn, "hover:text-sol-orange")} data-expectation-retire={e.id}>Retire</button>
    </span>
  );
  return (
    <li id={e.id} className="group scroll-mt-16 -mx-2 rounded px-2 py-2.5 transition-colors duration-700 data-[landed]:bg-sol-yellow/15" data-expectation={e.id}>
      <div className={cn("grid gap-x-4", variant === "page" && "sm:grid-cols-[minmax(0,1fr)_8.5rem]")}>
        <div className="min-w-0">
          {mode === "edit" ? (
            <EditLine e={e} areas={areas} youAnswer={youAnswer} person={personWord(row)} onCancel={() => setMode(null)}
              onSubmit={(edit) => { editExpectations(projectId, edit); setMode(null); }} />
          ) : (
            <p className="text-[13px] leading-snug text-sol-text">
              {e.text}
              {/* The handle a finding cites, so a cause's "Expects" row can be matched by eye. */}
              <span className="ml-2 whitespace-nowrap font-mono text-[10.5px] text-sol-text-dim" data-expectation-id>{e.id}</span>
            </p>
          )}
          {e.note && mode !== "edit" && (
            <div className="mt-1 flex items-baseline gap-1.5 text-[12px] text-sol-yellow" data-expectation-note>
              <span className="shrink-0 rounded-sm bg-sol-yellow/15 px-1 text-[10.5px] font-medium">Open question</span>
              <span className="min-w-0">{e.note}</span>
            </div>
          )}
          <Sources citations={e.citations} row={row} hideQuoteOf={e.text} />
          {mode !== "edit" && <div className="mt-1">{actions}</div>}
          {mode === "retire" && (
            <ReasonForm
              placeholder="Why retire it? Say what changed."
              submit={youAnswer ? "Retire" : "Propose retiring"}
              tone="orange"
              hint={youAnswer ? "Findings stop citing it from the next version. It stays in the history." : `It goes to ${personWord(row)}, who applies or drops it.`}
              onCancel={() => setMode(null)}
              onSubmit={(reason) => { editExpectations(projectId, { op: "retire", id: e.id, reason }); setMode(null); }}
            />
          )}
          {mode === "settle" && (
            <SettleForm e={e} youAnswer={youAnswer} person={personWord(row)} onCancel={() => setMode(null)}
              onSubmit={(edit) => { editExpectations(projectId, edit); setMode(null); }} />
          )}
        </div>
        {variant === "page" && <UsageCell usage={usage} open={mode === "findings"} onToggle={() => toggle("findings")} />}
      </div>
      {mode === "findings" && <Findings findings={usage.findings} d30={usage.d30} />}
    </li>
  );
}

/** How often findings broke the line: this week, the last 30 days, or never. */
function UsageCell({ usage, open, onToggle }: { usage: ReturnType<typeof usageOf>; open: boolean; onToggle: () => void }) {
  const heat = lineHeat(usage);
  if (heat === "quiet") {
    return <div className="mt-1 text-[11.5px] text-sol-text-dim sm:mt-0.5 sm:text-right" data-expectation-usage="quiet" title="No finding cited this line in the last 30 days">never cited</div>;
  }
  return (
    <button type="button" onClick={onToggle} aria-expanded={open}
      className="mt-1 inline-flex items-baseline gap-1.5 self-start text-[11.5px] tabular-nums sm:mt-0.5 sm:justify-self-end sm:text-right hover:underline"
      data-expectation-usage={heat} title="Findings that cite this line as the one they break">
      <span className={cn("font-semibold", heat === "week" ? "text-sol-red" : "text-sol-orange")}>{usage.d30}</span>
      <span className="text-sol-text-muted">{usage.d30 === 1 ? "break" : "breaks"} in 30d</span>
      {usage.d7 > 0 && <span className="text-sol-red">({usage.d7} this week)</span>}
      <ChevronRight className={cn("h-3 w-3 self-center text-sol-text-dim transition-transform", open && "rotate-90")} />
    </button>
  );
}

/** The newest findings that cited the line, each with the cause it opened. */
function Findings({ findings, d30 }: { findings: ExpectationFinding[]; d30: number }) {
  return (
    <div className="mt-2 rounded-md border border-sol-border/30 bg-sol-bg-alt/30 px-3 py-2" data-expectation-findings>
      <div className="mb-1 text-[11px] text-sol-text-dim">
        {d30 > findings.length ? `The newest ${findings.length} of ${d30} findings` : `${findings.length === 1 ? "The finding" : `The ${findings.length} findings`}`} that cite this line
      </div>
      <ul className="space-y-1">
        {findings.map((f) => (
          <li key={f.short_id} className="grid grid-cols-[3.25rem_minmax(0,1fr)_auto] items-baseline gap-x-2 text-[12px]" data-expectation-finding={f.short_id}>
            <span className="tabular-nums text-[11px] text-sol-text-dim">{shortDay(f.created_at)}</span>
            <span className="min-w-0 truncate text-sol-text-muted" title={`${f.title} (${f.kind}, from ${f.source})`}>
              {f.evidence_url ? <a href={f.evidence_url} target="_blank" rel="noreferrer" className="hover:text-sol-blue hover:underline">{f.title}</a> : f.title}
              <span className="ml-1.5 text-[11px] text-sol-text-dim">{f.source}</span>
            </span>
            <span className="shrink-0" data-expectation-cause>
              {f.cause?.short_id ? <EntityIdPill shortId={f.cause.short_id} compact /> : <span className="text-[11px] text-sol-text-dim">no cause</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReasonForm({ placeholder, submit, hint, tone, onSubmit, onCancel }: { placeholder: string; submit: string; hint: string; tone: "orange" | "blue"; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const send = (ev: FormEvent) => { ev.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); };
  return (
    <form onSubmit={send} className="mt-2 space-y-1" data-expectation-retire-form>
      <div className="flex items-center gap-2">
        <input ref={input} value={reason} onChange={(ev) => setReason(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") onCancel(); }} placeholder={placeholder} maxLength={400}
          className={cn(inputCls, "min-w-0 flex-1")} data-expectation-reason />
        <button type="submit" disabled={!reason.trim()} className={actBtn(tone)}>{submit}</button>
        <button type="button" onClick={onCancel} className={quietBtn}>Cancel</button>
      </div>
      <div className="text-[11px] text-sol-text-dim">{hint}</div>
    </form>
  );
}

/** Change a line's words, its area or its open question, and say why. */
function EditLine({ e, areas, youAnswer, person, onSubmit, onCancel }: { e: Expectation; areas: string[]; youAnswer: boolean; person: string; onSubmit: (edit: PersonEdit) => void; onCancel: () => void }) {
  const [text, setText] = useState(e.text);
  const [part, setPart] = useState(e.part);
  const [note, setNote] = useState(e.note ?? "");
  const [why, setWhy] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const edit: PersonEdit = { op: "edit", id: e.id };
  if (text.trim() && text.trim() !== e.text) edit.text = text.trim();
  if (part.trim() && part.trim() !== e.part) edit.part = part.trim();
  if (note.trim() !== (e.note ?? "")) edit.note = note.trim();
  if (why.trim()) edit.why = why.trim();
  const changed = edit.text !== undefined || edit.part !== undefined || edit.note !== undefined;
  const send = (ev?: FormEvent) => { ev?.preventDefault(); if (changed) onSubmit(edit); };
  const listId = `expectation-areas-${e.id}`;
  return (
    <form onSubmit={send} className="space-y-1.5" data-expectation-edit-form>
      <textarea ref={area} value={text} onChange={(ev) => setText(ev.target.value)} rows={2} maxLength={400}
        onKeyDown={(ev) => { if (ev.key === "Escape") onCancel(); if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) send(); }}
        className={cn(inputCls, "block w-full resize-none leading-snug")} data-expectation-edit-text />
      <div className="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <input value={part} onChange={(ev) => setPart(ev.target.value)} list={listId} placeholder="Area" maxLength={80} className={inputCls} data-expectation-edit-part />
        <datalist id={listId}>{areas.map((p) => <option key={p} value={p} />)}</datalist>
        <input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Open question about it, if any" maxLength={400} className={inputCls} data-expectation-edit-note />
      </div>
      <input value={why} onChange={(ev) => setWhy(ev.target.value)} placeholder="Why the change? (optional, kept with the line)" maxLength={400} className={cn(inputCls, "w-full")} data-expectation-edit-why />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-sol-text-dim">{youAnswer ? "Applies now as the next version." : `Goes to ${person} to apply.`}</span>
        <button type="button" onClick={onCancel} className={quietBtn}>Cancel</button>
        <button type="submit" disabled={!changed} className={actBtn("blue")} data-expectation-edit-submit>{youAnswer ? "Save" : "Propose"}</button>
      </div>
    </form>
  );
}

/** Settle a contested line's open question: how it was settled, and the line's words if they change. */
function SettleForm({ e, youAnswer, person, onSubmit, onCancel }: { e: Expectation; youAnswer: boolean; person: string; onSubmit: (edit: PersonEdit) => void; onCancel: () => void }) {
  const [why, setWhy] = useState("");
  const [text, setText] = useState(e.text);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const send = (ev: FormEvent) => {
    ev.preventDefault();
    if (!why.trim()) return;
    onSubmit({ op: "edit", id: e.id, note: "", why: why.trim(), ...(text.trim() && text.trim() !== e.text ? { text: text.trim() } : {}) });
  };
  return (
    <form onSubmit={send} className="mt-2 space-y-1.5 rounded-md border border-sol-yellow/30 bg-sol-yellow/5 p-2" data-expectation-settle-form>
      <input ref={input} value={why} onChange={(ev) => setWhy(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") onCancel(); }} placeholder="How was it settled? Who decided, and what." maxLength={400}
        className={cn(inputCls, "w-full")} data-expectation-settle-why />
      <textarea value={text} onChange={(ev) => setText(ev.target.value)} rows={2} maxLength={400} className={cn(inputCls, "block w-full resize-none leading-snug")} data-expectation-settle-text />
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-sol-text-dim">Rewrite the line if the answer changes it. {youAnswer ? "Applies now." : `Goes to ${person} to apply.`}</span>
        <button type="button" onClick={onCancel} className={quietBtn}>Cancel</button>
        <button type="submit" disabled={!why.trim()} className={actBtn("blue")} data-expectation-settle-submit>Settle</button>
      </div>
    </form>
  );
}

const KIND_WORD: Partial<Record<ExpectationCitation["kind"], string>> = { task: "a task", call: "a call", decision: "a decision", chat: "a chat message", session: "a session", commit: "a commit", doc: "a doc", signal: "a finding", other: "a link" };

/** Add a line in your own words, with the source it came from when you have one. Whether it applies now is said before it is sent, by the rule the server applies. */
function AddLine({ projectId, row, areas, onClose }: { projectId: string; row: ProjectExpectationsRow; areas: string[]; onClose: () => void }) {
  const [text, setText] = useState("");
  const [part, setPart] = useState(areas[0] ?? "");
  const [from, setFrom] = useState("");
  const [quote, setQuote] = useState("");
  const [when, setWhen] = useState("");
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ""));
  const editExpectations = useInboxStore((s) => s.editExpectations);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  const where = citationFromInput(from);
  const source: ExpectationCitation | undefined = where ? { ...where, ...(quote.trim() ? { quote: quote.trim() } : {}), ...(when ? { when } : {}) } : undefined;
  const edit: PersonEdit = { op: "add", text: text.trim(), part: part.trim(), ...(source ? { source } : {}) };
  const ready = !!edit.text && !!edit.part;
  const applies = ready && personEditApplies(personOp(edit, me || "me", Date.now()), !!row.you_answer);
  const send = (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!ready) return;
    editExpectations(projectId, edit);
    onClose();
  };
  const listId = `expectation-parts-${projectId}`;
  return (
    <form onSubmit={send} className="space-y-2 rounded-lg border border-sol-blue/30 bg-sol-bg-alt/30 p-3" data-expectation-add-form>
      <div className="text-[12px] font-medium text-sol-text">A new line</div>
      <textarea ref={area} value={text} onChange={(ev) => setText(ev.target.value)} rows={2} maxLength={400}
        onKeyDown={(ev) => { if (ev.key === "Escape") onClose(); if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) send(); }}
        placeholder="How should the product behave? One sentence, in your own words."
        className={cn(inputCls, "block w-full resize-none leading-snug")} data-expectation-text />
      <div className="grid gap-2 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <input value={part} onChange={(ev) => setPart(ev.target.value)} list={listId} placeholder="Area, e.g. Onboarding" maxLength={80} className={inputCls} data-expectation-part />
        <datalist id={listId}>{areas.map((p) => <option key={p} value={p} />)}</datalist>
        <input value={from} onChange={(ev) => setFrom(ev.target.value)} placeholder="Where was it said? A task, call, decision or chat link (optional)" className={inputCls} data-expectation-source />
      </div>
      {where && (
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9.5rem]" data-expectation-source-detail={where.kind}>
          <input value={quote} onChange={(ev) => setQuote(ev.target.value)} placeholder={`Their words in ${KIND_WORD[where.kind] ?? "it"}, quoted (optional)`} maxLength={600} className={inputCls} data-expectation-source-quote />
          <input type="date" value={when} onChange={(ev) => setWhen(ev.target.value)} className={inputCls} aria-label="When it was said" data-expectation-source-when />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-[11px] text-sol-text-dim" data-expectation-add-hint={!ready ? "" : applies ? "applies" : "waits"}>
          {!ready ? "Your words become the line's first source." : applies ? "Applies now, with your words as its source." : `Goes to ${personWord(row)} to apply: a line too far from its own words waits for them.`}
        </span>
        <button type="button" onClick={onClose} className={quietBtn}>Cancel</button>
        <button type="submit" disabled={!ready} className={actBtn("blue")} data-expectation-add-submit>{applies || !ready ? "Add" : "Propose"}</button>
      </div>
    </form>
  );
}

/** The open proposals, newest first: each change with its sources, and Apply or Drop. */
function Proposals({ projectId, row, proposals }: { projectId: string; row: ProjectExpectationsRow; proposals: ExpectationProposalView[] }) {
  const byId = useMemo(() => new Map((row.doc?.items ?? []).map((e) => [e.id, e])), [row.doc?.items]);
  return (
    <section className="space-y-2.5" data-expectation-proposals>
      <h3 className="flex items-baseline gap-2 text-[12.5px] font-semibold text-sol-yellow">
        {proposals.length === 1 ? "A proposed change waits" : `${proposals.length} proposed changes wait`}
        <span className="text-[11.5px] font-normal text-sol-text-dim">{row.you_answer ? "on you" : `on ${personWord(row)}`}</span>
      </h3>
      {proposals.map((p) => <Proposal key={p.short_id || `sending-${p.created_at}`} projectId={projectId} row={row} p={p} byId={byId} />)}
    </section>
  );
}

function Proposal({ projectId, row, p, byId }: { projectId: string; row: ProjectExpectationsRow; p: ExpectationProposalView; byId: Map<string, Expectation> }) {
  const resolve = useInboxStore((s) => s.resolveExpectationProposal);
  const now = useMemo(() => Date.now(), []);
  const sending = !p.short_id;
  return (
    <div className="rounded-lg border border-sol-yellow/30 bg-sol-yellow/[0.04] px-3 py-2.5" data-expectation-proposal={p.short_id || "sending"}>
      <div className="flex items-baseline gap-2 text-[12.5px]">
        <span className="min-w-0 flex-1 text-sol-text line-clamp-2">{p.summary}</span>
        <span className="shrink-0 text-[11px] text-sol-text-dim tabular-nums">
          {sending ? "sending…" : <>{p.proposed_by ? `${p.from_session ? `${p.proposed_by}'s session` : p.proposed_by}, ` : ""}{ageShort(now - p.created_at)} ago</>}
          {!sending && <span className="ml-1.5 font-mono">{p.short_id}</span>}
          {p.card && p.card_status === "pending" && <span className="ml-1.5" title="The same decision waits in the queue; answering here answers it there"><EntityIdPill shortId={p.card} compact /></span>}
        </span>
      </div>
      <ul className="mt-2 space-y-2">
        {(p.ops ?? []).map((op, i) => <Change key={i} op={op} row={row} byId={byId} />)}
        {!p.ops && <li className="text-[11.5px] text-sol-text-dim">{p.changes} {p.changes === 1 ? "change" : "changes"}</li>}
      </ul>
      {p.refused && <div className="mt-2 text-[11.5px] text-sol-orange" data-expectation-refused>It cannot apply as written: {p.refused}</div>}
      {!sending && (
        <div className="mt-2.5 flex items-center gap-2">
          <button type="button" onClick={() => resolve(projectId, p.short_id, "apply")} className={actBtn("green")} data-expectation-apply={p.short_id}>Apply</button>
          <button type="button" onClick={() => resolve(projectId, p.short_id, "drop")} className={actBtn("plain")} data-expectation-drop={p.short_id}>Drop</button>
          <span className="text-[11px] text-sol-text-dim">Applied, it becomes version {p.base_version + 1}.</span>
        </div>
      )}
    </div>
  );
}

const CHANGE_TAG: Record<ExpectationOp["op"], { label: string; cls: string }> = {
  add: { label: "Add", cls: "text-sol-green" },
  edit: { label: "Change", cls: "text-sol-yellow" },
  retire: { label: "Retire", cls: "text-sol-orange" },
};

/** One change of a proposal, against the words it changes. */
function Change({ op, row, byId }: { op: ExpectationOp; row: ProjectExpectationsRow; byId: Map<string, Expectation> }) {
  const tag = CHANGE_TAG[op.op];
  const was = op.op === "add" ? null : byId.get(op.id);
  let body: ReactNode;
  if (op.op === "add") {
    body = <><span className="text-sol-text-dim">{op.part}: </span><span className="text-sol-text">{op.text}</span>{op.note && <div className="text-sol-yellow/90">Open question: {op.note}</div>}{op.status === "retired" && <span className="text-sol-text-dim"> (added as retired: {op.reason})</span>}</>;
  } else if (op.op === "edit") {
    body = (
      <>
        <span className="font-mono text-[10.5px] text-sol-text-dim">{op.id}</span>
        {op.text !== undefined && <><div className="text-sol-text-dim line-through decoration-sol-text-dim/50">{was?.text ?? "(a line this document does not have)"}</div><div className="text-sol-text">{op.text}</div></>}
        {op.text === undefined && was && <div className="text-sol-text-muted">{was.text}</div>}
        {op.part !== undefined && <div className="text-sol-text-muted">Moves to {op.part}</div>}
        {op.note !== undefined && <div className="text-sol-yellow/90">{op.note ? `Open question: ${op.note}` : "Its open question is settled"}</div>}
      </>
    );
  } else {
    body = (
      <>
        <span className="text-sol-text-dim line-through decoration-sol-text-dim/50">{was?.text ?? op.id}</span>
        <span className="ml-1.5 font-mono text-[10.5px] text-sol-text-dim">{op.id}</span>
        <div className="text-sol-text-muted">Because {op.reason}</div>
      </>
    );
  }
  return (
    <li className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-x-2 text-[12.5px] leading-snug" data-expectation-change={op.op}>
      <span className={cn("text-[11px] font-semibold", tag.cls)}>{tag.label}</span>
      <div className="min-w-0">
        {body}
        <Sources citations={op.citations} row={row} hideQuoteOf={op.op === "add" ? op.text : op.op === "retire" ? op.reason : undefined} />
      </div>
    </li>
  );
}

/** Lines the project has moved past, folded under their count: never graded against, kept for the history. */
function Retired({ items, row }: { items: Expectation[]; row: ProjectExpectationsRow }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-expectations-retired={items.length}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[12px] text-sol-text-dim hover:text-sol-text-muted">
        <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
        {items.length} retired {items.length === 1 ? "line" : "lines"}, no longer graded against
      </button>
      {open && (
        <ul className="mt-2 space-y-2.5 opacity-85">
          {items.map((e) => (
            <li key={e.id} id={e.id} className="scroll-mt-16 text-[12.5px] leading-snug" data-expectation={e.id} data-expectation-retired>
              <span className="text-sol-text-muted line-through decoration-sol-text-dim/40">{e.text}</span>
              <span className="ml-1.5 font-mono text-[10.5px] text-sol-text-dim">{e.id}</span>
              <div className="text-[11.5px] text-sol-text-dim">Retired in version {e.changed_in}{e.retired_reason ? `: ${e.retired_reason}` : ""}</div>
              <Sources citations={e.citations.slice(-1)} row={row} hideQuoteOf={e.retired_reason} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
