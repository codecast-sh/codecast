"use client";
// A project's Outputs view (ct-94262): everything its work produced, so a
// person sees every pull request and page at once, knows which session and
// task made each, and catches the PRs left hanging. Pull requests come first,
// grouped by what they need (the shepherd's fold), then pages, docs and
// images. Every row opens the thing itself; the session and task ride as live
// references. Painted from the store (projectOutputs), fed here.
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, ChevronRight, FileText, GitPullRequest, GitMerge, Image as ImageIcon, PanelsTopLeft } from "lucide-react";
import { useSyncProjectOutputs, useProjectOutputs, type OutputPr, type OutputSession, type OutputTask, type PrGroup } from "../../hooks/useSyncProjectOutputs";
import { EntityIdPill } from "../EntityIdPill";
import { ImageGalleryProvider, useImageGallery } from "../ImageGallery";
import { accentSoft, accentVar, shepherdStyle } from "../../lib/externalEvents";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { pageShareUrl } from "../../lib/publishedPageUrls";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { cn } from "../../lib/utils";

const PR_GROUPS: Array<{ key: PrGroup; label: string; accent: "red" | "yellow" | "muted" }> = [
  { key: "attention", label: "Needs attention", accent: "red" },
  { key: "review", label: "In review", accent: "yellow" },
  { key: "done", label: "Merged or closed", accent: "muted" },
];

function Refs({ session, task }: { session: OutputSession | null; task: OutputTask | null }) {
  if (!session && !task) return null;
  return (
    <span className="flex items-center gap-1 min-w-0 shrink-0" onClick={(e) => e.stopPropagation()}>
      {session && <EntityIdPill shortId={session.short_id ?? undefined} id={session.short_id ? undefined : session.id} type="session" compact label={session.title} />}
      {task && <EntityIdPill shortId={task.short_id} type="task" compact label={task.title} />}
    </span>
  );
}

function When({ at, now }: { at: number; now: number }) {
  return <span className="w-9 shrink-0 text-right font-mono tabular-nums text-meta text-sol-text-dim" title={new Date(at).toLocaleString()}>{formatTimeAgo(at, now)}</span>;
}

function SectionHead({ icon: Icon, label, count, accent, open, onToggle }: { icon: typeof FileText; label: string; count: number; accent?: string; open?: boolean; onToggle?: () => void }) {
  const inner = (
    <>
      {onToggle && <ChevronRight className={cn("w-3 h-3 transition-transform", open && "rotate-90")} />}
      <Icon className="w-3.5 h-3.5" style={accent ? { color: accent } : undefined} />
      <span>{label}</span>
      <span className="font-mono tabular-nums text-sol-text-dim">{count}</span>
    </>
  );
  const cls = "flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-sol-text-muted mb-1.5";
  return onToggle
    ? <button type="button" onClick={onToggle} className={cn(cls, "hover:text-sol-text")} aria-expanded={open} data-outputs-toggle>{inner}</button>
    : <h3 className={cls}>{inner}</h3>;
}

function PrRow({ pr, now }: { pr: OutputPr; now: number }) {
  const style = shepherdStyle(pr.status);
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest;
  return (
    <li className="group relative flex items-center gap-2 h-9 pl-3 pr-2 rounded-md hover:bg-sol-bg-alt/60 transition-colors" data-output-pr={pr.number} data-output-group={pr.group}>
      <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-full" style={{ background: accentVar(style.accent) }} />
      <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: accentVar(style.accent) }} />
      <Link href={pr.href} className="flex items-center gap-2 min-w-0 flex-1 after:absolute after:inset-0" title={`${pr.repository}#${pr.number}`}>
        <span className="font-mono text-meta text-sol-text-dim shrink-0">#{pr.number}</span>
        <span className="truncate text-sm text-sol-text">{pr.title}</span>
      </Link>
      {pr.draft && <span className="shrink-0 text-meta text-sol-text-dim">draft</span>}
      <span className="shrink-0 rounded px-1.5 py-px text-meta font-medium" style={{ color: accentVar(style.accent), background: accentSoft(style.accent) }}>{style.label}</span>
      <span className="relative z-10 flex items-center gap-2">
        <Refs session={pr.session} task={pr.task} />
        <a href={pr.github_url} target="_blank" rel="noopener noreferrer" className="text-sol-text-dim hover:text-sol-blue" title="Open on GitHub" aria-label="Open on GitHub" onClick={(e) => e.stopPropagation()}>
          <ArrowUpRight className="w-3.5 h-3.5" />
        </a>
      </span>
      <When at={pr.updated_at} now={now} />
    </li>
  );
}

function PullRequests({ prs, now }: { prs: OutputPr[]; now: number }) {
  const [doneOpen, setDoneOpen] = useState(false);
  const byGroup = useMemo(() => {
    const out: Record<PrGroup, OutputPr[]> = { attention: [], review: [], done: [] };
    for (const pr of prs) out[pr.group].push(pr);
    return out;
  }, [prs]);
  return (
    <div className="space-y-4">
      {PR_GROUPS.map(({ key, label, accent }) => {
        const rows = byGroup[key];
        if (!rows.length) return null;
        const collapsible = key === "done";
        const open = !collapsible || doneOpen;
        return (
          <section key={key} data-outputs-group={key}>
            <SectionHead icon={GitPullRequest} label={label} count={rows.length} accent={accentVar(accent)} open={open} onToggle={collapsible ? () => setDoneOpen((v) => !v) : undefined} />
            {open && <ul className="-mx-3">{rows.map((pr) => <PrRow key={pr.id} pr={pr} now={now} />)}</ul>}
          </section>
        );
      })}
    </div>
  );
}

function PlainRow({ href, external, icon: Icon, title, meta, session, task, at, now, data }: { href: string; external?: boolean; icon: typeof FileText; title: string; meta?: string; session: OutputSession | null; task: OutputTask | null; at: number; now: number; data: Record<string, string> }) {
  const link = external
    ? <a href={href} target="_blank" rel="noopener noreferrer" className="truncate min-w-0 flex-1 after:absolute after:inset-0">{title}</a>
    : <Link href={href} className="truncate min-w-0 flex-1 after:absolute after:inset-0">{title}</Link>;
  return (
    <li className="relative flex items-center gap-2 h-9 px-3 rounded-md hover:bg-sol-bg-alt/60 transition-colors text-sm text-sol-text" {...data}>
      <Icon className="w-3.5 h-3.5 shrink-0 text-sol-text-dim" />
      {link}
      {meta && <span className="shrink-0 font-mono text-meta text-sol-text-dim">{meta}</span>}
      <span className="relative z-10"><Refs session={session} task={task} /></span>
      <When at={at} now={now} />
    </li>
  );
}

function Images({ images, now }: { images: NonNullable<ReturnType<typeof useProjectOutputs>>["images"]; now: number }) {
  const gallery = useImageGallery();
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2">
      {images.map((img, index) => (
        <figure key={img.id} className="group rounded-md border border-sol-border/40 bg-sol-card/40 overflow-hidden" data-output-image>
          <button
            type="button"
            className="block w-full aspect-[4/3] bg-sol-bg-highlight/60"
            onClick={() => gallery?.openList(images.map((i) => ({ src: i.url, href: i.href })), index)}
            aria-label={`Open image ${index + 1} of ${images.length}`}
          >
            <img src={img.url} alt="" loading="lazy" className="w-full h-full object-cover object-top" />
          </button>
          <figcaption className="flex items-center gap-1 px-1.5 py-1 min-w-0">
            <Refs session={img.session} task={img.task} />
            <span className="ml-auto font-mono tabular-nums text-meta text-sol-text-dim">{formatTimeAgo(img.updated_at, now)}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function ProjectOutputs({ projectId }: { projectId: string }) {
  return (
    <ImageGalleryProvider key={projectId}>
      <ProjectOutputsContent projectId={projectId} />
    </ImageGalleryProvider>
  );
}

function ProjectOutputsContent({ projectId }: { projectId: string }) {
  const { ready, refused, error, retry } = useSyncProjectOutputs(projectId);
  const row = useProjectOutputs(projectId);
  const now = useCoarseNow(60_000);

  if (!row) {
    const state = error ? "error" : refused ? "refused" : ready ? "empty" : "loading";
    return (
      <div className="max-w-[60rem] mx-auto px-4 sm:px-6 py-6 space-y-2" data-project-outputs={state}>
        {state === "error" ? (
          <div className="flex items-center gap-3 text-sm text-sol-text-dim">
            <span>Outputs did not load.</span>
            <button type="button" onClick={retry} className="h-6 px-2 rounded-md border border-sol-border/60 text-meta text-sol-text hover:bg-sol-bg-alt/60" data-outputs-retry>Retry</button>
          </div>
        ) : state === "refused" ? (
          <p className="text-sm text-sol-text-dim">No access to this project's outputs.</p>
        ) : state === "empty" ? (
          <p className="text-sm text-sol-text-dim">Nothing produced yet.</p>
        ) : [0, 1, 2, 3].map((i) => <div key={i} className="h-9 rounded-md bg-sol-bg-alt/50 animate-pulse" />)}
      </div>
    );
  }
  const { prs, pages, docs, images } = row;
  const empty = !prs.length && !pages.length && !docs.length && !images.length;
  return (
    <div className="max-w-[60rem] mx-auto px-4 sm:px-6 py-5 space-y-6" data-project-outputs={empty ? "empty" : "filled"}>
      {empty && <p className="text-sm text-sol-text-dim">Nothing produced yet.</p>}
      {prs.length > 0 && <PullRequests prs={prs} now={now} />}
      {pages.length > 0 && (
        <section data-outputs-section="pages">
          <SectionHead icon={PanelsTopLeft} label="Pages" count={pages.length} />
          <ul className="-mx-3">
            {pages.map((p) => <PlainRow key={p.id} href={pageShareUrl(p.slug)} external icon={PanelsTopLeft} title={p.title} meta={`v${p.version}`} session={p.session} task={p.task} at={p.updated_at} now={now} data={{ "data-output-page": p.slug }} />)}
          </ul>
        </section>
      )}
      {docs.length > 0 && (
        <section data-outputs-section="docs">
          <SectionHead icon={FileText} label="Docs" count={docs.length} />
          <ul className="-mx-3">
            {docs.map((d) => <PlainRow key={d.id} href={d.href} icon={FileText} title={d.title} meta={d.doc_type} session={d.session} task={d.task} at={d.updated_at} now={now} data={{ "data-output-doc": d.id }} />)}
          </ul>
        </section>
      )}
      {images.length > 0 && (
        <section data-outputs-section="images">
          <SectionHead icon={ImageIcon} label="Images" count={images.length} />
          <Images images={images} now={now} />
        </section>
      )}
      {row.truncated && <p className="text-meta text-sol-text-dim">Older outputs exist past these.</p>}
    </div>
  );
}
