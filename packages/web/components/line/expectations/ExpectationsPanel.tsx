"use client";
// A project's expectations, read and changed in one place (the-line-model.md
// LM5; line-map.md LX3 Definition, LX5 editing in place). Self-contained: it
// feeds its own row and paints from the store, so the map's node panel and
// the project's Line tab mount the same thing.
//
// - Active lines by part, each with the sources it came from: the words, who
//   or where they were said, and when.
// - Open proposals (xp-N) first, since they wait on someone: each change
//   with its sources, answered here with Apply or Drop. A proposal's card in
//   the queue is the same decision, so answering here answers it there.
// - Add a line in your own words, or retire one with the reason. Either is a
//   proposal; it applies as you make it when personEditApplies says so (the
//   server applies by the same rule), else it waits for the project's person.
// - Retired lines fold away under their count.
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight, Plus } from "lucide-react";
import { personEditApplies, personOp, type Expectation, type ExpectationOp, type PersonEdit } from "@codecast/shared/contracts/expectations";
import { EntityIdPill } from "../../EntityIdPill";
import { useInboxStore } from "../../../store/inboxStore";
import { useProjectExpectations, useSyncProjectExpectations, type ExpectationProposalView } from "../../../hooks/useSyncProjectExpectations";
import { ageShort } from "../../../lib/lineFlow";
import { shortDay } from "../../../lib/line/runReport";
import { cn } from "../../../lib/utils";
import { ReportSection } from "../RunReport";
import { CitationLine } from "./CitationRef";

const SOURCES_SHOWN = 1;

const sameWords = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() === b.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Group lines by the part of the system they concern, in first-seen order. */
function byPart(items: Expectation[]): Array<[string, Expectation[]]> {
  const by = new Map<string, Expectation[]>();
  for (const e of items) by.set(e.part, [...(by.get(e.part) ?? []), e]);
  return [...by.entries()];
}

export function ExpectationsPanel({ projectId, setupHref, scroll = true, className }: {
  projectId: string;
  /** Puts setting up the line in the header, for a project whose expectations lead its tab. */
  setupHref?: string;
  /** Caps the height and scrolls, for a panel beside other sections. */
  scroll?: boolean;
  className?: string;
}) {
  const { ready } = useSyncProjectExpectations(projectId);
  const row = useProjectExpectations(projectId);
  const doc = row?.doc ?? null;
  const items = doc?.items ?? [];
  const active = useMemo(() => items.filter((e) => e.status === "active"), [items]);
  const retired = useMemo(() => items.filter((e) => e.status === "retired"), [items]);
  const parts = useMemo(() => byPart(active), [active]);
  const open = useMemo(() => (row?.proposals ?? []).filter((p) => p.status === "open"), [row?.proposals]);
  const youAnswer = !!row?.you_answer;

  // A link to one line (`#ex-<project>-<n>`, as a finding cites it) lands on
  // it once the document has rendered.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id.startsWith("ex-")) document.getElementById(id)?.scrollIntoView({ block: "center" });
  }, [doc]);

  const aside = (
    <span className="inline-flex items-center gap-3">
      {doc && (
        <span title={doc.applied_by ? `Version ${doc.version}, applied by ${doc.applied_by}${doc.how === "auto" ? " on its own (every line in a person's words)" : ""}` : undefined} data-expectations-version>
          version {doc.version} · {shortDay(doc.applied_at)}{open.length ? <span className="text-sol-yellow"> · {open.length} proposed</span> : null}
        </span>
      )}
      {setupHref && <Link href={setupHref} className="inline-flex items-center gap-1 text-sol-cyan hover:underline" data-line-setup-action>Set up the line<ArrowRight className="w-3 h-3" /></Link>}
    </span>
  );

  return (
    <ReportSection title="Expectations" aside={aside} className={className}>
      <div data-expectations-panel={projectId}>
        <p className="-mt-1 mb-3 text-[12px] text-sol-text-dim" data-expectations-about>
          How the project should behave, each line from where it was said. The judges grade what happened against these lines.
        </p>
        {!row && !ready ? (
          <p className="text-[12.5px] text-sol-text-dim" data-expectations-loading>Reading the expectations…</p>
        ) : (
          <div className={cn("space-y-4", scroll && "max-h-[30rem] overflow-y-auto pr-1 -mr-1")}>
            {open.length > 0 && <Proposals projectId={projectId} proposals={open} items={items} />}
            {active.length === 0 && open.length === 0 && (
              <p className="text-[12.5px] text-sol-text-dim" data-expectations-empty>
                No expectations yet. Add the first line below, or let the daily routine propose them from what the team says.
              </p>
            )}
            {parts.map(([part, lines]) => (
              <div key={part} data-expectations-part={part}>
                <div className="mb-1 text-[11px] font-semibold text-sol-text-dim">{part}</div>
                <ul className="space-y-2" data-expectations>
                  {lines.map((e) => <Line key={e.id} e={e} projectId={projectId} youAnswer={youAnswer} />)}
                </ul>
              </div>
            ))}
            {row && <AddLine projectId={projectId} parts={parts.map(([p]) => p)} youAnswer={youAnswer} />}
            {retired.length > 0 && <Retired items={retired} />}
          </div>
        )}
      </div>
    </ReportSection>
  );
}

/** The sources behind a line or a change: the first in full, the rest a click away. */
function Sources({ e, hideQuoteOf }: { e: { citations: Expectation["citations"] }; hideQuoteOf?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? e.citations : e.citations.slice(0, SOURCES_SHOWN);
  const more = e.citations.length - shown.length;
  if (e.citations.length === 0) return null;
  return (
    <div className="mt-0.5 space-y-0.5 pl-3 border-l border-sol-border/30" data-expectation-sources>
      {/* A person's own line cites the very words of the line: the quote would repeat it. */}
      {shown.map((c, i) => <CitationLine key={`${c.kind}-${c.ref}-${i}`} c={c} quote={!(hideQuoteOf && c.quote && sameWords(c.quote, hideQuoteOf))} />)}
      {more > 0 && (
        <button type="button" onClick={() => setAll(true)} className="text-[11px] text-sol-text-dim hover:text-sol-text-muted" data-expectation-more-sources>
          {more} more {more === 1 ? "source" : "sources"}
        </button>
      )}
    </div>
  );
}

/** One active line: its words, the id a finding cites, its sources, and Retire. */
function Line({ e, projectId, youAnswer }: { e: Expectation; projectId: string; youAnswer: boolean }) {
  const [retiring, setRetiring] = useState(false);
  const editExpectations = useInboxStore((s) => s.editExpectations);
  return (
    <li id={e.id} className="group scroll-mt-16 rounded px-1 -mx-1 target:bg-sol-yellow/15" data-expectation={e.id}>
      <div className="flex items-baseline gap-2 text-[12.5px] leading-snug">
        <span className="min-w-0 flex-1 text-sol-text">
          {e.text}
          {/* The handle a finding cites, so a cause's "Expects" row can be matched by eye. */}
          <span className="ml-1.5 whitespace-nowrap font-mono text-[10.5px] text-sol-text-dim" data-expectation-id>{e.id}</span>
        </span>
        {!retiring && (
          <button type="button" onClick={() => setRetiring(true)} className="shrink-0 text-[11px] text-sol-text-dim transition-opacity sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:text-sol-orange" data-expectation-retire={e.id}>
            Retire
          </button>
        )}
      </div>
      {e.note && <div className="mt-0.5 text-[11.5px] text-sol-yellow/90" data-expectation-note>Open question: {e.note}</div>}
      <Sources e={e} hideQuoteOf={e.text} />
      {retiring && (
        <ReasonForm
          placeholder="Why retire it? Say what changed."
          submit={youAnswer ? "Retire" : "Propose retiring"}
          hint={youAnswer ? "The line stops being graded against from the next version. It stays in the history." : "It goes to the project's person, who applies or drops it."}
          onCancel={() => setRetiring(false)}
          onSubmit={(reason) => { editExpectations(projectId, { op: "retire", id: e.id, reason }); setRetiring(false); }}
        />
      )}
    </li>
  );
}

function ReasonForm({ placeholder, submit, hint, onSubmit, onCancel }: { placeholder: string; submit: string; hint: string; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const send = (ev: FormEvent) => { ev.preventDefault(); if (reason.trim()) onSubmit(reason.trim()); };
  return (
    <form onSubmit={send} className="mt-1.5 ml-3 space-y-1" data-expectation-retire-form>
      <div className="flex items-center gap-2">
        <input ref={input} value={reason} onChange={(ev) => setReason(ev.target.value)} onKeyDown={(ev) => { if (ev.key === "Escape") onCancel(); }} placeholder={placeholder} maxLength={400}
          className="min-w-0 flex-1 rounded-md border border-sol-border/50 bg-sol-bg px-2 py-1 text-[12px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-blue/60 focus:outline-none" data-expectation-reason />
        <button type="submit" disabled={!reason.trim()} className="shrink-0 rounded-md border border-sol-orange/40 px-2 py-0.5 text-[11.5px] text-sol-orange hover:bg-sol-orange/10 disabled:opacity-40 disabled:hover:bg-transparent">{submit}</button>
        <button type="button" onClick={onCancel} className="shrink-0 text-[11.5px] text-sol-text-dim hover:text-sol-text-muted">Cancel</button>
      </div>
      <div className="text-[11px] text-sol-text-dim">{hint}</div>
    </form>
  );
}

/** Add a line in your own words. Whether it applies now is said before it is sent, by the rule the server applies. */
function AddLine({ projectId, parts, youAnswer }: { projectId: string; parts: string[]; youAnswer: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [part, setPart] = useState(parts[0] ?? "");
  const me = useInboxStore((s) => String(s.currentUser?._id ?? ""));
  const editExpectations = useInboxStore((s) => s.editExpectations);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (open) area.current?.focus(); }, [open]);
  useEffect(() => { if (!part && parts[0]) setPart(parts[0]); }, [parts, part]);
  const edit: PersonEdit = { op: "add", text: text.trim(), part: part.trim() };
  const ready = !!edit.text && !!edit.part;
  const applies = ready && personEditApplies(personOp(edit, me || "me", Date.now()), youAnswer);
  const send = (ev?: FormEvent) => {
    ev?.preventDefault();
    if (!ready) return;
    editExpectations(projectId, edit);
    setText("");
    setOpen(false);
  };
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[12px] text-sol-text-dim hover:text-sol-text" data-expectation-add>
        <Plus className="w-3.5 h-3.5" />Add a line
      </button>
    );
  }
  const listId = `expectation-parts-${projectId}`;
  return (
    <form onSubmit={send} className="space-y-1.5 rounded-md border border-sol-border/40 bg-sol-bg-alt/30 p-2" data-expectation-add-form>
      <textarea ref={area} value={text} onChange={(ev) => setText(ev.target.value)} rows={2} maxLength={400}
        onKeyDown={(ev) => { if (ev.key === "Escape") setOpen(false); if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) send(); }}
        placeholder="How should the project behave? One sentence, in your own words."
        className="block w-full resize-none rounded border border-sol-border/40 bg-sol-bg px-2 py-1 text-[12.5px] leading-snug text-sol-text placeholder:text-sol-text-dim focus:border-sol-blue/60 focus:outline-none" data-expectation-text />
      <div className="flex flex-wrap items-center gap-2">
        <input value={part} onChange={(ev) => setPart(ev.target.value)} list={listId} placeholder="Part of the system" maxLength={80}
          className="w-44 rounded border border-sol-border/40 bg-sol-bg px-2 py-0.5 text-[12px] text-sol-text placeholder:text-sol-text-dim focus:border-sol-blue/60 focus:outline-none" data-expectation-part />
        <datalist id={listId}>{parts.map((p) => <option key={p} value={p} />)}</datalist>
        <span className="min-w-0 flex-1 text-[11px] text-sol-text-dim" data-expectation-add-hint={!ready ? "" : applies ? "applies" : "waits"}>
          {!ready ? "Your words become the line's source." : applies ? "Applies now, with your words as its source." : "Goes to the project's person to apply: it is too short to stand on its own words."}
        </span>
        <button type="button" onClick={() => setOpen(false)} className="text-[11.5px] text-sol-text-dim hover:text-sol-text-muted">Cancel</button>
        <button type="submit" disabled={!ready} className="rounded-md border border-sol-blue/40 px-2 py-0.5 text-[11.5px] text-sol-blue hover:bg-sol-blue/10 disabled:opacity-40 disabled:hover:bg-transparent" data-expectation-add-submit>
          {applies || !ready ? "Add" : "Propose"}
        </button>
      </div>
    </form>
  );
}

/** The open proposals, newest first: each change with its sources, and Apply or Drop. */
function Proposals({ projectId, proposals, items }: { projectId: string; proposals: ExpectationProposalView[]; items: Expectation[] }) {
  const byId = useMemo(() => new Map(items.map((e) => [e.id, e])), [items]);
  return (
    <div className="space-y-2" data-expectation-proposals>
      <div className="text-[11px] font-semibold text-sol-yellow">Proposed changes</div>
      {proposals.map((p) => <Proposal key={p.short_id || `sending-${p.created_at}`} projectId={projectId} p={p} byId={byId} />)}
    </div>
  );
}

function Proposal({ projectId, p, byId }: { projectId: string; p: ExpectationProposalView; byId: Map<string, Expectation> }) {
  const resolve = useInboxStore((s) => s.resolveExpectationProposal);
  const now = useMemo(() => Date.now(), []);
  const sending = !p.short_id;
  return (
    <div className="rounded-md border border-sol-yellow/30 bg-sol-yellow/5 px-2.5 py-2" data-expectation-proposal={p.short_id || "sending"}>
      <div className="flex items-baseline gap-2 text-[12px]">
        {!sending && <span className="font-mono text-[11px] text-sol-text-dim">{p.short_id}</span>}
        <span className="min-w-0 flex-1 text-sol-text-muted line-clamp-2">{p.summary}</span>
        <span className="shrink-0 text-[11px] text-sol-text-dim tabular-nums">
          {sending ? "sending…" : `${ageShort(now - p.created_at)} ago`}
          {p.card && p.card_status === "pending" && <span className="ml-1.5" title="The same decision waits in the queue; answering here answers it there"><EntityIdPill shortId={p.card} compact /></span>}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {(p.ops ?? []).map((op, i) => <Change key={i} op={op} byId={byId} />)}
        {!p.ops && <li className="text-[11.5px] text-sol-text-dim">{p.changes} {p.changes === 1 ? "change" : "changes"}</li>}
      </ul>
      {p.refused && <div className="mt-1.5 text-[11.5px] text-sol-orange" data-expectation-refused>It cannot apply as written: {p.refused}</div>}
      {!sending && (
        <div className="mt-2 flex items-center gap-2">
          <button type="button" onClick={() => resolve(projectId, p.short_id, "apply")} className="rounded-md border border-sol-green/40 px-2.5 py-0.5 text-[11.5px] text-sol-green hover:bg-sol-green/10" data-expectation-apply={p.short_id}>Apply</button>
          <button type="button" onClick={() => resolve(projectId, p.short_id, "drop")} className="rounded-md border border-sol-border/50 px-2.5 py-0.5 text-[11.5px] text-sol-text-muted hover:bg-sol-bg-alt" data-expectation-drop={p.short_id}>Drop</button>
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
function Change({ op, byId }: { op: ExpectationOp; byId: Map<string, Expectation> }) {
  const tag = CHANGE_TAG[op.op];
  const was = op.op === "add" ? null : byId.get(op.id);
  let body: ReactNode;
  if (op.op === "add") {
    body = <><span className="text-sol-text-dim">{op.part}: </span><span className="text-sol-text">{op.text}</span>{op.status === "retired" && <span className="text-sol-text-dim"> (added as retired: {op.reason})</span>}</>;
  } else if (op.op === "edit") {
    body = (
      <>
        <span className="font-mono text-[10.5px] text-sol-text-dim">{op.id}</span>
        {op.text !== undefined && <><div className="text-sol-text-dim line-through decoration-sol-text-dim/50">{was?.text ?? "(a line this document does not have)"}</div><div className="text-sol-text">{op.text}</div></>}
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
    <li className="grid grid-cols-[3.25rem_1fr] gap-x-2 text-[12.5px] leading-snug" data-expectation-change={op.op}>
      <span className={cn("text-[11px] font-semibold", tag.cls)}>{tag.label}</span>
      <div className="min-w-0">
        {body}
        <Sources e={op} hideQuoteOf={op.op === "add" ? op.text : op.op === "retire" ? op.reason : undefined} />
      </div>
    </li>
  );
}

/** Lines the project has moved past, folded under their count: never graded against, kept for the history. */
function Retired({ items }: { items: Expectation[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-expectations-retired={items.length}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="inline-flex items-center gap-1 text-[11.5px] text-sol-text-dim hover:text-sol-text-muted">
        <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />
        {items.length} retired {items.length === 1 ? "line" : "lines"}, no longer graded against
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1.5 opacity-80">
          {items.map((e) => (
            <li key={e.id} id={e.id} className="scroll-mt-16 text-[12px] leading-snug" data-expectation={e.id} data-expectation-retired>
              <span className="text-sol-text-muted">{e.text}</span>
              <span className="ml-1.5 font-mono text-[10.5px] text-sol-text-dim">{e.id}</span>
              <div className="text-[11.5px] text-sol-text-dim">Retired in version {e.changed_in}{e.retired_reason ? `: ${e.retired_reason}` : ""}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

