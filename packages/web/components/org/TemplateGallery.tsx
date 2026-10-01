// The gallery a person hires from (docs/architecture/org-hire.md H3): every
// template this workspace may hire, one card each, read from the catalog the
// server already keeps. A card says what the role does, what it will ask for
// and what it runs, and offers the hire only when this workspace can take it:
// a project to lead, and a release that can be installed from the record.
// An empty catalog says so in plain words; nothing here invents a template.
import { useState } from "react";
import { ArrowRight, Lock, Search } from "lucide-react";
import { RoleAvatar } from "./avatars";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import type { TemplateRoutine } from "@codecast/shared/contracts/orgTemplateManifest";
import { humanSetupCount, isDefaultLeadTemplate, secretInputs } from "./orgTemplateSpec";
import { cadenceWords, cannotHireReason, displayTitle, type CatalogTemplate } from "./templateCatalog";

function askWords(t: CatalogTemplate): string[] {
  const m = t.manifest;
  const answers = t.asks.inputs - t.asks.secrets;
  const out: string[] = [];
  if (answers) out.push(`${answers} answer${answers === 1 ? "" : "s"}`);
  if (t.asks.secrets) out.push(`${t.asks.secrets} secret${t.asks.secrets === 1 ? "" : "s"} kept on your machine`);
  if (t.asks.authority) out.push(`${t.asks.authority} permission${t.asks.authority === 1 ? "" : "s"} outside codecast`);
  const yours = humanSetupCount(m);
  if (yours) out.push(`${yours} setup step${yours === 1 ? "" : "s"} only you can do`);
  return out;
}

export function TemplateGallery({ templates, ready, projectCount, onPick, error }: {
  templates: CatalogTemplate[];
  ready: boolean;
  /** Projects this workspace can lead a role on; zero means no card can hire. */
  projectCount: number;
  onPick: (templateId: string) => void;
  error?: unknown;
}) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  // The project's default lead leads the gallery too; the rest keep the catalog's order.
  const ordered = [...templates].sort((a, b) => Number(isDefaultLeadTemplate(b.template_id)) - Number(isDefaultLeadTemplate(a.template_id)));
  const shown = q ? ordered.filter((t) => `${t.name} ${t.description} ${t.template_id} ${t.manifest.routines.map((r) => r.title).join(" ")}`.toLowerCase().includes(q)) : ordered;
  if (!ready && templates.length === 0) {
    return (
      <div className="grid gap-3 sm:grid-cols-2" aria-busy="true" data-template-gallery="loading">
        {[0, 1].map((i) => <div key={i} className="h-[196px] rounded-xl border border-sol-border/40 bg-sol-bg-alt/60 animate-pulse" />)}
      </div>
    );
  }
  if (templates.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-sol-border/60 px-5 py-8 text-center" data-template-gallery="empty">
        <p className="text-[14px] font-semibold text-sol-text" style={{ fontFamily: "var(--font-serif)" }}>Nothing to hire yet</p>
        <p className="mx-auto mt-1.5 max-w-[380px] text-[12.5px] leading-relaxed text-sol-text-muted">{error ? "The catalog could not be read right now. Try again in a moment." : "No template has been published for this workspace, and Codecast has not published a shared one to it. A template is a release folder a publisher puts on the record:"}</p>
        {!error && <pre className="mx-auto mt-3 inline-block rounded-lg border border-sol-border/50 bg-sol-bg-alt px-3 py-2 text-left text-[11px] leading-relaxed text-sol-text" style={{ fontFamily: "var(--font-mono)" }}>cast org template publish &lt;folder&gt; --team &lt;team&gt;</pre>}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3" data-template-gallery={shown.length}>
      {templates.length > 3 && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sol-text-dim" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a role" className="h-9 w-full rounded-lg border border-sol-border/50 bg-sol-bg-alt pl-8 pr-2.5 text-[13px] text-sol-text outline-none focus:border-sol-cyan" />
        </label>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {shown.map((t) => <TemplateCard key={`${t.workspace}:${t.template_id}`} template={t} reason={cannotHireReason(t, projectCount)} onPick={() => onPick(t.template_id)} />)}
      </div>
      {shown.length === 0 && <p className="text-[12px] text-sol-text-dim">No template matches that.</p>}
    </div>
  );
}

function TemplateCard({ template: t, reason, onPick }: { template: CatalogTemplate; reason: string | null; onPick: () => void }) {
  const routines: TemplateRoutine[] = t.manifest.routines;
  const acts = routines.filter((r) => r.mode === "apply").length;
  const byCodecast = t.workspace === "codecast";
  const status = t.latest_status ?? null;
  const leads = isDefaultLeadTemplate(t.template_id);
  return (
    <article
      className={`group relative flex flex-col gap-3 rounded-xl border p-4 transition-[transform,box-shadow,border-color] duration-200 ${reason ? "border-sol-border/40" : "border-sol-border/50 hover:-translate-y-0.5 hover:border-sol-violet/60 hover:shadow-[0_10px_30px_-18px_color-mix(in_srgb,var(--sol-violet)_60%,transparent)]"}`}
      style={{ background: "linear-gradient(160deg, color-mix(in srgb, var(--sol-violet) 7%, var(--sol-card)) 0%, var(--sol-card) 42%)" }}
      data-template-card={t.template_id}
      data-hireable={reason ? "false" : "true"}
    >
      <header className="flex items-start gap-3">
        <RoleAvatar avatar={avatarOf({ avatar: t.avatar, handle: t.template_id })} size={44} className="shrink-0 rounded-full ring-2 ring-sol-bg" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-[15px] font-semibold text-sol-text" style={{ fontFamily: "var(--font-serif)" }}>{t.name}</h3>
            <span className="shrink-0 text-[10.5px] text-sol-text-dim" style={{ fontFamily: "var(--font-mono)" }}>{t.latest.version}</span>
          </div>
          <p className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-sol-text-muted">{t.description}</p>
        </div>
      </header>
      <ul className="flex flex-wrap gap-1.5" aria-label="What it asks for">
        {leads && <li className="rounded-md px-1.5 py-0.5 text-[10.5px] font-semibold leading-tight text-sol-violet" style={{ background: "color-mix(in srgb, var(--sol-violet) 14%, transparent)" }} data-template-card-leads>Leads the project</li>}
        {askWords(t).map((w) => <li key={w} className="rounded-md px-1.5 py-0.5 text-[10.5px] leading-tight text-sol-text-muted" style={{ background: "color-mix(in srgb, var(--sol-border) 22%, transparent)" }}>{w}</li>)}
        {askWords(t).length === 0 && <li className="text-[10.5px] text-sol-text-dim">Asks nothing at hire</li>}
      </ul>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-sol-text-dim">Runs {routines.length} routine{routines.length === 1 ? "" : "s"}{acts ? ` · ${acts} act${acts === 1 ? "s" : ""} once you allow it` : ""}</p>
        <ul className="mt-1 space-y-0.5">
          {routines.slice(0, 4).map((r) => (
            <li key={r.id} className="flex items-baseline justify-between gap-2 text-[11.5px]">
              <span className="truncate text-sol-text">{displayTitle(t.manifest, r.title)}</span>
              <span className="shrink-0 text-sol-text-dim">{cadenceWords(r.every)}</span>
            </li>
          ))}
          {routines.length > 4 && <li className="text-[11px] text-sol-text-dim">and {routines.length - 4} more</li>}
        </ul>
      </div>
      {reason && <p className="mt-auto rounded-md px-2 py-1.5 text-[11px] leading-snug text-sol-text-muted" style={{ background: "color-mix(in srgb, var(--sol-yellow) 10%, transparent)" }} data-template-card-reason>{reason}</p>}
      <footer className={`flex items-center justify-between gap-2 pt-1 ${reason ? "" : "mt-auto"}`}>
        <span className="flex items-center gap-1.5 text-[10.5px] text-sol-text-dim">
          <span>{byCodecast ? "by Codecast" : "this workspace"}</span>
          {!leads && <span title="Once a project has a lead, this role reports to it">· under the lead</span>}
          {status && status !== "stable" && <span className="rounded px-1 py-px text-[9.5px] uppercase tracking-wide text-sol-yellow" style={{ background: "color-mix(in srgb, var(--sol-yellow) 14%, transparent)" }}>{status}</span>}
          {secretInputs(t.manifest).length > 0 && <Lock className="h-3 w-3" aria-label="binds secrets on your machine" />}
        </span>
        {!reason && (
          <button type="button" onClick={onPick} className="inline-flex h-8 items-center gap-1 rounded-lg bg-sol-violet px-3 text-[12px] font-semibold text-sol-bg transition-[filter] hover:brightness-110" data-template-card-hire>
            Hire <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </button>
        )}
      </footer>
    </article>
  );
}
