"use client";
// One frame for an object's own page (essence spec §5): the bar with the
// crumb (the list the object belongs to, then where it sits in the company,
// each step opening that object), then the head: the name, the menu; the
// facts line (owner · state · measure · date); what it serves. The kind's own
// sections follow as children, built from SheetSection and SheetFolds.
import { Fragment, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Ellipsis } from "lucide-react";
import { objectHref, type OrgObjectKind } from "@codecast/shared/entities";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { copyText } from "../../../lib/copyText";
import { cn } from "../../../lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../ui/dropdown-menu";
import { SectionHead } from "../../initiatives/InitiativeRecord";
import { ORG_BAND, ORG_RULE } from "../orgFrame";
import { FactsLine } from "../lines/FactsLine";
import { hasFacts } from "../lines/lineFacts";

export type Named = { kind: OrgObjectKind; ref: string; title: string };
export type SheetFacts = { owner?: ReactNode; state?: ReactNode; measure?: ReactNode; date?: ReactNode };
export type SheetMenuItem = { label: string; onSelect: () => void; danger?: boolean };

const RULE = "var(--cc-panel-rule, color-mix(in srgb, var(--sol-border) 45%, transparent))";
const DIM = "var(--sol-text-dim)";
/** The one side gutter of a sheet, bar and body alike: the crumb, the glyph
 *  and the facts share one left edge, the menu the right edge. */
const SHEET_GUTTER = "px-[22px]";

/** The list page an object belongs to, where its trail starts on its own page. */
const LIST_OF: Record<OrgObjectKind, { href: string; label: string }> = {
  initiative: { href: "/goals", label: "Goals" },
  project: { href: "/projects", label: "Projects" },
  role: { href: "/org", label: "Org" },
  person: { href: "/org", label: "Org" },
};

/** A name in the frame, linking to its object's page. */
export function ObjectLink({ n, className, children }: { n: Named; className?: string; children?: ReactNode }) {
  return (
    <Link
      href={objectHref(n.kind, n.ref)}
      className={cn("min-w-0 truncate no-underline hover:underline underline-offset-[3px]", className)}
      data-sheet-link={n.ref}
    >
      {children ?? n.title}
    </Link>
  );
}

export function SheetFrame({ kind, idRef, idLabel, sub, onRenameSub, linkRef, glyph, title, onRename, crumbs, facts, serves, actions, menu = [], children, loading }: {
  kind: OrgObjectKind;
  /** The object's own short ref, shown beside its name. */
  idRef?: string | null;
  /** What the head shows beside the name when it says more than the id (a role's "@handle · or-7"). Defaults to idRef. */
  idLabel?: string | null;
  /** What the object is, beside its name, in place of the id (a role's title beside its name). */
  sub?: string | null;
  /** The sub is editable where the object's owner may rename it (a role's title). */
  onRenameSub?: (sub: string) => void;
  /** The ref its address takes, for Copy link, when it is not shown (a person's handle). Defaults to idRef. */
  linkRef?: string | null;
  glyph: ReactNode;
  title: string;
  /** The name is editable where the object's owner may rename it. */
  onRename?: (title: string) => void;
  /** Where it sits: the workspace, then each object above it. The workspace crumb is the list the object belongs to. */
  crumbs: Named[];
  facts?: SheetFacts;
  serves?: Named[];
  /** The kind's own buttons in the head, before the menu. */
  actions?: ReactNode;
  menu?: SheetMenuItem[];
  children?: ReactNode;
  /** The object has not arrived in the store yet. */
  loading?: boolean;
}) {
  const addressRef = linkRef ?? idRef;
  const link = addressRef ? objectHref(kind, addressRef) : null;

  return (
    <div className="flex h-full min-h-0 flex-col" data-sheet={kind} data-sheet-ref={idRef ?? ""}>
      <div className={cn("flex shrink-0 items-center gap-2 border-b text-[12px]", ORG_BAND, SHEET_GUTTER)} style={{ borderColor: ORG_RULE, color: "var(--sol-text-muted)" }} data-sheet-bar>
        <nav className="flex min-w-0 items-center gap-[5px] overflow-hidden whitespace-nowrap" aria-label="Where it sits" data-sheet-crumb>
          {crumbs.map((c, i) => (
            <Fragment key={`${c.kind}:${c.ref}:${i}`}>
              {i > 0 && <span aria-hidden style={{ color: DIM }}>›</span>}
              {/* The trail starts at the list the object belongs to. */}
              {i === 0 && !c.ref
                ? <Link href={LIST_OF[kind].href} className="shrink-0 no-underline hover:text-[var(--sol-text)]" data-sheet-crumb-workspace>{LIST_OF[kind].label}</Link>
                : <ObjectLink n={c} className="hover:!text-[var(--sol-text)]" />}
            </Fragment>
          ))}
        </nav>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto pb-8 pt-[18px] [container-type:inline-size]", SHEET_GUTTER)} data-sheet-body>
        {/* The row wraps when the title would get under 14rem: what follows it
            drops to its own line, starting on the title's left edge, because the
            row's 30px left padding holds the glyph (pulled back into it) and
            every wrapped line starts after it. */}
        <div className="flex flex-wrap items-start gap-x-2.5 gap-y-2 pl-[30px]" data-sheet-head>
          {/* Centred on the title's first line box (22px at 1.2 leading), so a diamond, a face and an avatar all sit on its optical middle. */}
          <span className="-ml-[30px] inline-flex h-[26px] w-5 shrink-0 items-center justify-center" aria-hidden>{glyph}</span>
          <div className="min-w-0 grow basis-56">
            <SheetTitle title={title} onRename={onRename} />
          </div>
          {sub ? <SheetSub sub={sub} onRename={onRenameSub} /> : (idLabel ?? idRef) && <span className="org-sheet-id mt-[6px] shrink-0 whitespace-nowrap font-mono text-[11px]" style={{ color: DIM }} data-sheet-id>{idLabel ?? idRef}</span>}
          <span className="flex shrink-0 items-center gap-1.5" data-sheet-actions>
            {actions}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md hover:bg-sol-bg-highlight/60" style={{ color: "var(--sol-text-muted)" }} aria-label="More" data-sheet-menu>
                  <Ellipsis className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[190px]">
                {menu.filter((m) => !m.danger).map((m) => <DropdownMenuItem key={m.label} onSelect={m.onSelect}>{m.label}</DropdownMenuItem>)}
                {link && <DropdownMenuItem onSelect={() => void copyText(`${window.location.origin}${link}`, "Link copied")} data-sheet-copy-link>Copy link</DropdownMenuItem>}
                {menu.some((m) => m.danger) && <DropdownMenuSeparator />}
                {menu.filter((m) => m.danger).map((m) => <DropdownMenuItem key={m.label} onSelect={m.onSelect} className="text-[var(--sol-red)] focus:text-[var(--sol-red)]">{m.label}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>

        {hasFacts(facts) && <FactsLine facts={facts!} className="mt-[9px] text-[12px]" data-sheet-facts="" />}
        {serves && serves.length > 0 && (
          <div className="mt-2.5 flex min-w-0 items-baseline gap-2 text-[12px]" data-sheet-serves>
            <span className="shrink-0" style={{ color: DIM }}>Serves</span>
            <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1" style={{ color: "var(--sol-text-secondary)" }}>
              {serves.map((n) => <ObjectLink key={`${n.kind}:${n.ref}`} n={n} />)}
            </span>
          </div>
        )}
        {loading ? <p className="mt-6 text-[12.5px]" style={{ color: DIM }}>Loading…</p> : children}
      </div>
    </div>
  );
}

/** The object's name: the serif heading, an input in place while renaming. */
function SheetTitle({ title, onRename }: { title: string; onRename?: (title: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useWatchEffect(() => {
    const el = input.current;
    if (!editing || !el) return;
    el.focus();
    el.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== title) onRename?.(next);
  };
  // The name shrinks with a narrow sheet and wraps between words; a word
  // breaks only when it is wider than the sheet on its own.
  const heading = "text-[clamp(18px,5cqi,22px)] leading-[1.2] tracking-[-0.01em] [overflow-wrap:break-word] [word-break:normal]";
  if (editing) {
    return (
      <input
        ref={input}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(title); setEditing(false); }
        }}
        aria-label="Name"
        className={cn(heading, "w-full rounded-md bg-transparent px-1 -mx-1 outline-none ring-1 ring-[color-mix(in_srgb,var(--sol-cyan)_55%,transparent)]")}
        style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)" }}
        data-sheet-title-input
      />
    );
  }
  return (
    <h1
      className={cn(heading, onRename && "cursor-text rounded-md -mx-1 px-1 hover:bg-sol-bg-highlight/40")}
      style={{ fontFamily: "var(--font-serif)", color: "var(--sol-text)", fontWeight: 500 }}
      onClick={onRename ? () => { setDraft(title); setEditing(true); } : undefined}
      title={onRename ? "Rename" : undefined}
      data-sheet-title
    >
      {title}
    </h1>
  );
}

/** What the object is, beside its name: quiet words, renamed in place by
 *  whoever may rename it. */
function SheetSub({ sub, onRename }: { sub: string; onRename?: (sub: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const cls = "mt-[5px] max-w-[45%] shrink-0 truncate text-[12.5px]";
  if (draft !== null) {
    const commit = () => { const next = draft.trim(); setDraft(null); if (next && next !== sub) onRename?.(next); };
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDraft(null); }
        }}
        aria-label="Title"
        size={Math.max(8, draft.length + 1)}
        className={cn(cls, "rounded-md bg-transparent px-1 -mx-1 outline-none ring-1 ring-[color-mix(in_srgb,var(--sol-cyan)_55%,transparent)]")}
        style={{ color: "var(--sol-text-secondary)" }}
        data-sheet-sub-input
      />
    );
  }
  return (
    <span
      className={cn(cls, "whitespace-nowrap", onRename && "cursor-text rounded-md -mx-1 px-1 hover:bg-sol-bg-highlight/40")}
      style={{ color: "var(--sol-text-muted)" }}
      onClick={onRename ? () => setDraft(sub) : undefined}
      title={onRename ? `${sub} · rename` : sub}
      data-sheet-sub
    >
      {sub}
    </span>
  );
}

/** One of a sheet's sections: the small heading, an optional action at its
 *  right, then the body. Its heading is SectionHead, the one the goal
 *  sheet's sections (RecordSection) draw too, so a heading sits at the same
 *  height and rhythm on every kind. */
export function SheetSection({ title, action, children, data }: { title: string; action?: ReactNode; children: ReactNode; data?: string }) {
  return (
    <section className="mt-5" data-sheet-section={data ?? title}>
      <SectionHead label={title} action={action} />
      {children}
    </section>
  );
}

/** The record and the activity, folded at the foot of a sheet. */
export function SheetFolds({ children }: { children: ReactNode }) {
  return <div className="mt-5 border-b" style={{ borderColor: RULE }} data-sheet-folds>{children}</div>;
}

export function SheetFold({ title, hint, children, defaultOpen = false }: { title: string; hint?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t" style={{ borderColor: RULE }} data-sheet-fold={title} data-open={open ? "" : undefined}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-1 py-2.5 text-left text-[12.5px] hover:text-[var(--sol-text)]" style={{ color: "var(--sol-text-muted)" }}>
        <span aria-hidden className={cn("inline-block w-3 text-[10px] transition-transform", open && "rotate-90")}>▸</span>
        <span className="shrink-0 whitespace-nowrap">{title}</span>
        {hint && <span className="ml-auto min-w-0 truncate text-[11.5px]" style={{ color: DIM }}>{hint}</span>}
      </button>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}
