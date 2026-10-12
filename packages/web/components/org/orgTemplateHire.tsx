import { lazy, Suspense, useMemo, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { captureException } from "@sentry/react";
import { ArrowLeft, Copy } from "lucide-react";
import { TemplateGallery } from "./TemplateGallery";
import { builtinHires, cannotHireReason, EXECUTIVE_ASSISTANT_HIRE, HEAD_OF_PEOPLE_HIRE, type BuiltinHire, type CatalogTemplate } from "./templateCatalog";
// The seat cards live with the conversation surface; loaded on pick, as the
// header panel loads them, so the hire dialog's graph never reaches the chat.
const HireHeadOfPeopleCard = lazy(() => import("../anchor/AnchorConversation").then((m) => ({ default: m.HireHeadOfPeopleCard })));
const HireAssistantCard = lazy(() => import("../anchor/AnchorConversation").then((m) => ({ default: m.HireAssistantCard })));
import { useAnchors } from "../../hooks/useSyncAnchors";
import { globalAssistantOf } from "../../lib/headerPins";
import { copyToClipboard } from "../../lib/utils";
import { inWorkspace } from "../../lib/workspaceScope";
import { SelectBox } from "../ui/select-box";
import type { OrgRole, OrgTree } from "./orgTypes";
import { buildOrgTemplateCommand, type TemplateDraft, type TemplateProject } from "./orgTemplateCommand";
import { DEFAULT_LEAD_TEMPLATE_ID, askedInputs, buildHireSpec, grantsToAsk, hireErrors, humanSetupCount, isDefaultLeadTemplate, resolvedConfig, secretInputs, slugOf, type HireDraft } from "./orgTemplateSpec";
import { useTemplateActions, useTemplateCatalog } from "../../hooks/useTemplateHire";
import { LearningSwitch } from "./TemplateSections";
import { RoleAvatar } from "./avatars";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";
import { Button } from "../ui/button";

// Hiring from a template (docs/architecture/org-hire.md H3): the catalog this
// workspace may hire from, the template's inputs as a form, the lead rule, a
// preview of the one proposal a person will decide, and the post. Secrets are
// never typed here; they bind on the host after approval. The folder path for
// template authors stays behind a fold: it copies a command and runs nothing.

export function OrgTemplateHire({ projects, workspace, roles = [], initialProjectId = "", projectPath = "", onClose, onStage }: {
  projects: TemplateProject[];
  workspace: OrgTree["workspace"];
  roles?: OrgRole[];
  initialProjectId?: string;
  projectPath?: string;
  onClose: () => void;
  /** The gallery, or the answers form for one template: the dialog sizes itself by it. */
  onStage?: (stage: "gallery" | "form") => void;
}) {
  const teamId = workspace.kind === "team" ? workspace.id : undefined;
  const { templates, ready, error: catalogError } = useTemplateCatalog(teamId) as { templates: CatalogTemplate[]; ready: boolean; error?: unknown };
  const { propose } = useTemplateActions();
  const available = projects.filter((p) => p.workspace && inWorkspace(p, `${workspace.kind}:${workspace.id}`));
  const [templateId, setTemplateId] = useState("");
  // The roles codecast itself offers (org-staffing.md S6, S30), each hidden
  // once one stands: the Head of People is a role of this workspace; the
  // Executive Assistant is the person's, read from the seats they can see.
  const anchors = useAnchors();
  const builtins = useMemo(() => builtinHires(roles, { assistant: !!globalAssistantOf(anchors) }), [roles, anchors]);
  const [builtin, setBuiltin] = useState<BuiltinHire["id"] | "">("");
  const [projectId, setProjectId] = useState(initialProjectId);
  const [instance, setInstance] = useState("");
  const [instanceTouched, setInstanceTouched] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  // With a lead in place the hire reports to it (the lead rule, H3); "lead"
  // names the lead as the seat instead. "new" only stands while no lead exists.
  const [seat, setSeat] = useState<"under" | "lead">("under");
  const [policy, setPolicy] = useState<HireDraft["updatePolicy"]>("stable");
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<{ short_id: string; link?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((t) => t.template_id === templateId) ?? null;
  useWatchEffect(() => { onStage?.(template || posted || builtin ? "form" : "gallery"); }, [template, posted, builtin, onStage]);
  const project = available.find((p) => p._id === projectId) ?? null;
  // The project's lead (R4, W9 I2): a live role whose scope names the project.
  const lead = useMemo(() => project ? roles.find((r) => r.status !== "retired" && ((r.scope as any)?.project_ids ?? []).some((id: string) => id === project._id)) ?? null : null, [roles, project]);
  const effInstance = instanceTouched ? instance : project && template ? `${slugOf(project.title)}-${template.template_id}` : "";
  const draft: HireDraft = { template, project, instance: effInstance, config, reportsTo: lead && seat === "under" ? `@${lead.handle}` : "me", seatHandle: lead && seat === "lead" ? lead.handle : null, updatePolicy: policy };
  const engLead = templates.find((t) => t.template_id === DEFAULT_LEAD_TEMPLATE_ID) ?? null;
  const errors = hireErrors(draft);
  const spec = errors.length ? null : buildHireSpec(draft);
  const manifest = template?.manifest;

  const submit = async () => {
    if (!spec || posting) return;
    setPosting(true); setError(null);
    try {
      const result = await propose({ team_id: teamId, ...spec });
      setPosted({ short_id: result.short_id, link: result.link });
    } catch (e) {
      captureException(e);
      setError(e instanceof Error ? e.message : String(e));
    } finally { setPosting(false); }
  };

  if (posted) {
    return (
      <div className="flex flex-col gap-3" data-template-posted={posted.short_id}>
        <div className="rounded-lg border border-sol-border/50 bg-sol-bg-alt px-3 py-2.5 text-[12.5px] leading-relaxed">
          <p className="font-semibold text-sol-text">Proposed. Nothing has changed yet.</p>
          <p className="mt-1 text-sol-text-muted">Decide it on the org page: the role, what it may do and the hire are one proposal. After you accept, the role&apos;s page has one button left, <span className="text-sol-text">Set up</span>: it installs the template on the machine that runs the role and creates its triggers, paused.</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-highlight">Close</button>
          <Button asChild variant="violet" size="sm" className="rounded-lg"><a href={`/org?proposal=${posted.short_id}`}>Open the proposal</a></Button>
        </div>
      </div>
    );
  }

  // A built-in hire (S6, S30): the existing card for that seat, through its
  // own path (the staff mutation, hireExecutiveAssistant), inside the dialog.
  if (builtin) {
    const hire = builtin === "head-of-people" ? HEAD_OF_PEOPLE_HIRE : EXECUTIVE_ASSISTANT_HIRE;
    return (
      <div className="flex flex-col gap-3" data-builtin-hire-stage={builtin}>
        <div className="flex items-center gap-3 rounded-lg border border-sol-border/50 px-3 py-2.5" style={{ background: "linear-gradient(160deg, color-mix(in srgb, var(--sol-cyan) 8%, var(--sol-card)) 0%, var(--sol-card) 60%)" }}>
          <RoleAvatar avatar={avatarOf({ handle: hire.handle })} size={36} className="shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold text-sol-text" style={{ fontFamily: "var(--font-serif)" }}>{hire.name} <span className="text-[10.5px] font-normal text-sol-text-dim" style={{ fontFamily: "var(--font-mono)" }}>@{hire.handle}</span></p>
            <p className="truncate text-[11.5px] text-sol-text-muted">{hire.description}</p>
          </div>
          <button type="button" onClick={() => setBuiltin("")} className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-sol-text-muted underline-offset-2 hover:underline" data-template-back><ArrowLeft className="h-3 w-3" /> All templates</button>
        </div>
        <Suspense fallback={<div className="h-[260px] rounded-xl border border-sol-border/40 bg-sol-bg-alt/60 animate-pulse" aria-busy="true" />}>
          {builtin === "head-of-people" ? <HireHeadOfPeopleCard compact onHired={onClose} /> : <HireAssistantCard compact onHired={onClose} />}
        </Suspense>
      </div>
    );
  }

  // The gallery (H3): every template this workspace may hire, one card each;
  // a card offers the hire only when the workspace can take it.
  if (!template) {
    return (
      <div className="flex flex-col gap-3" data-template-gallery-stage>
        <TemplateGallery templates={templates} ready={ready} projectCount={available.length} error={catalogError} builtins={builtins} onPickBuiltin={setBuiltin} onPick={(id) => { const t = templates.find((x) => x.template_id === id); if (t && !cannotHireReason(t, available.length)) { setTemplateId(id); setConfig({}); } }} />
        <FolderPath projects={available} workspace={workspace} initialProjectId={projectId} projectPath={projectPath} />
      </div>
    );
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-template-form>
      <div className="flex items-center gap-3 rounded-lg border border-sol-border/50 px-3 py-2.5" style={{ background: "linear-gradient(160deg, color-mix(in srgb, var(--sol-violet) 7%, var(--sol-card)) 0%, var(--sol-card) 60%)" }} data-template-chosen={template.template_id}>
        <RoleAvatar avatar={avatarOf({ avatar: template.avatar, handle: template.template_id })} size={36} className="shrink-0 rounded-full" />
        <div className="min-w-0 flex-1">
          <p className="text-[13.5px] font-semibold text-sol-text" style={{ fontFamily: "var(--font-serif)" }}>{template.name} <span className="text-[10.5px] font-normal text-sol-text-dim" style={{ fontFamily: "var(--font-mono)" }}>{template.latest.version}</span></p>
          <p className="truncate text-[11.5px] text-sol-text-muted">{template.description}</p>
        </div>
        <button type="button" onClick={() => { setTemplateId(""); setConfig({}); }} className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-sol-text-muted underline-offset-2 hover:underline" data-template-back><ArrowLeft className="h-3 w-3" /> All templates</button>
      </div>
      <label className={LABEL}>
        <span className={CAPTION}>Project</span>
        <SelectBox value={projectId} onChange={(e) => setProjectId(e.target.value)} className="text-[13px]">
          <option value="">Choose a project</option>
          {available.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
        </SelectBox>
        <span className="text-[11px] text-sol-text-dim">{available.length ? "One project. The role leads it." : "Create a project in this workspace before hiring from a template."}</span>
      </label>
      {lead && (
        <div className="rounded-lg border border-sol-border/50 bg-sol-bg-alt px-3 py-2.5 text-[12px] leading-relaxed" role="group" aria-label="Project lead" data-template-lead={lead.handle}>
          <p className="text-sol-text"><span className="font-semibold">@{lead.handle}</span> leads {project?.title}. This role is hired under it and reports to it.</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {([["under", `Hire under @${lead.handle}: a new role that reports to it; it stays the lead`], ["lead", `Give it to @${lead.handle} instead: no new role; it takes on the template's triggers and record`]] as const).map(([value, label]) => (
              <label key={value} className="flex items-start gap-2 text-sol-text-muted"><input type="radio" name="template-seat" checked={seat === value} onChange={() => setSeat(value)} className="mt-0.5" />{label}</label>
            ))}
          </div>
        </div>
      )}
      {project && !lead && !isDefaultLeadTemplate(template.template_id) && (
        <div className="rounded-lg border border-sol-border/50 px-3 py-2.5 text-[12px] leading-relaxed" style={{ background: "color-mix(in srgb, var(--sol-yellow) 8%, transparent)" }} role="note" data-template-no-lead>
          <p className="text-sol-text">{project.title} has no lead yet, so this role would lead it. Projects usually start with an Engineering Lead and hire the rest under it.</p>
          {engLead && <button type="button" onClick={() => { setTemplateId(engLead.template_id); setConfig({}); }} className="mt-1 text-[12px] font-semibold text-sol-violet underline-offset-2 hover:underline" data-template-hire-lead-first>Hire the {engLead.name} first</button>}
        </div>
      )}
      {manifest && askedInputs(manifest).length > 0 && (
        <fieldset className="flex flex-col gap-2.5 rounded-lg border border-sol-border/50 p-3" data-template-inputs>
          <legend className={CAPTION}>Answers</legend>
          {askedInputs(manifest).map((input) => (
            <label key={input.key} className={LABEL}>
              <span className="text-[12px] text-sol-text">{input.label}{input.required && input.default === undefined ? <span className="text-sol-red"> *</span> : null}</span>
              {input.kind === "choice" ? (
                <SelectBox value={config[input.key] ?? String(input.default ?? "")} onChange={(e) => setConfig({ ...config, [input.key]: e.target.value })} className="text-[13px]">
                  {(input.choices ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
                </SelectBox>
              ) : input.kind === "boolean" ? (
                <input type="checkbox" checked={(config[input.key] ?? String(input.default ?? "false")) === "true"} onChange={(e) => setConfig({ ...config, [input.key]: e.target.checked ? "true" : "false" })} />
              ) : (
                <input name={`input:${input.key}`} value={config[input.key] ?? ""} onChange={(e) => setConfig({ ...config, [input.key]: e.target.value })} placeholder={input.default !== undefined ? String(input.default) : input.kind === "money" ? "USD" : ""} inputMode={input.kind === "number" || input.kind === "money" ? "decimal" : undefined} className={INPUT} spellCheck={false} />
              )}
              {input.help && <span className="text-[11px] text-sol-text-dim">{input.help}</span>}
            </label>
          ))}
        </fieldset>
      )}
      {manifest && secretInputs(manifest).length > 0 && (
        <div className="rounded-lg border border-sol-border/50 bg-sol-bg-alt px-3 py-2.5 text-[12px] leading-relaxed" data-template-secrets>
          <p className="font-semibold text-sol-text">Secrets come last, and stay on its machine</p>
          <p className="text-sol-text-muted">After you accept, the role page asks for each one once and seals it to the machine that runs the role; nothing here stores it.</p>
          <ul className="mt-1 list-disc pl-4 text-sol-text-muted">{secretInputs(manifest).map((s) => <li key={s.key}>{s.label}{s.help ? <span className="text-sol-text-dim">: {s.help}</span> : null}</li>)}</ul>
        </div>
      )}
      {manifest && (
        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            <span className={CAPTION}>Instance name</span>
            <input name="template-instance" value={effInstance} onChange={(e) => { setInstanceTouched(true); setInstance(slugOf(e.target.value)); }} className={INPUT} spellCheck={false} autoCapitalize="none" maxLength={48} />
          </label>
          <label className={LABEL}>
            <span className={CAPTION}>Updates</span>
            <SelectBox value={policy} onChange={(e) => setPolicy(e.target.value as HireDraft["updatePolicy"])} className="text-[13px]">
              <option value="stable">Offer stable releases</option>
              <option value="canary">Canary: the publisher updates it</option>
              <option value="manual">Manual only</option>
            </SelectBox>
          </label>
        </div>
      )}
      {manifest && <LearningSwitch teamId={teamId} canEdit compact />}
      {spec && manifest && (
        <div className="rounded-lg border border-sol-border/50 px-3 py-2.5 text-[12px] leading-relaxed" data-template-preview>
          <p className="font-semibold text-sol-text">What you will decide</p>
          <ul className="mt-1 list-disc pl-4 text-sol-text-muted">
            {spec.changes.map((c, i) => <li key={i}>{c.kind === "role" ? `A new role ${c.name} @${c.handle}, reporting to ${c.reports_to}${!lead ? `, leading ${project?.title}` : ""}, that starts work on its own` : c.kind === "authority" ? `Authority outside codecast: ${c.authority.map((g) => `${g.kind} (${g.label})`).join("; ")}` : c.kind === "hire" ? `The hire: ${c.template} ${c.version} as ${c.instance} on ${project?.title}` : ""}</li>)}
            <li>{manifest.routines.length} routine{manifest.routines.length === 1 ? "" : "s"}, created paused; you activate each from the role page once it is ready.</li>
            {humanSetupCount(manifest) > 0 && <li>{humanSetupCount(manifest)} setup step{humanSetupCount(manifest) === 1 ? "" : "s"} only you can do; the role puts one in front of you at a time.</li>}
          </ul>
          {grantsToAsk(manifest, resolvedConfig(manifest, config)).length === 0 && (manifest.authority ?? []).length > 0 && <p className="mt-1 text-sol-text-dim">Authority is not asked for yet: its inputs are unanswered.</p>}
        </div>
      )}
      {!spec && template && project && errors.length > 0 && <p role="status" className="text-[11.5px] text-sol-text-muted">{errors[0]}</p>}
      {error && <p role="alert" className="text-[11.5px] text-sol-red">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-highlight">Close</button>
        <Button type="submit" variant="violet" size="sm" disabled={!spec || posting} className="shrink-0 rounded-lg">{posting ? "Proposing…" : "Propose the hire"}</Button>
      </div>
    </form>
  );
}

/** Template authors: a release folder on this machine, installed by a command this copies and never runs. */
function FolderPath({ projects, workspace, initialProjectId, projectPath }: { projects: TemplateProject[]; workspace: OrgTree["workspace"]; initialProjectId: string; projectPath: string }) {
  const [draft, setDraft] = useState<TemplateDraft>({ projectId: initialProjectId, projectPath, folder: "", instance: "" });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const result = buildOrgTemplateCommand({ ...draft, projectId: draft.projectId || initialProjectId }, projects, workspace);
  const update = (patch: Partial<TemplateDraft>) => { setDraft({ ...draft, ...patch }); setCopied(false); setCopyError(false); };
  const copy = async () => {
    if (!result.command) return;
    try { await copyToClipboard(result.command); setCopied(true); setCopyError(false); }
    catch (error) { captureException(error); setCopyError(true); }
  };
  return (
    <details className="rounded-lg border border-sol-border/50 px-3 py-2 text-[12px]">
      <summary className="cursor-pointer text-sol-text-muted">From a folder on this machine (template authors)</summary>
      <div className="mt-2 flex flex-col gap-3">
        <label className={LABEL}>
          <span className={CAPTION}>Project checkout on host</span>
          <input value={draft.projectPath} onChange={(e) => update({ projectPath: e.target.value })} placeholder="/path/to/project" className={INPUT} spellCheck={false} autoCapitalize="none" />
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Template folder on host</span>
          <input value={draft.folder} onChange={(e) => update({ folder: e.target.value })} placeholder="/path/to/templates/growth" className={INPUT} spellCheck={false} autoCapitalize="none" />
          <span className="text-[11px] text-sol-text-dim">Contains org-template.json. Both paths must exist on the machine where you run the command.</span>
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Instance name</span>
          <input name="folder-instance" value={draft.instance} onChange={(e) => update({ instance: e.target.value })} placeholder="acme-growth" className={INPUT} spellCheck={false} autoCapitalize="none" maxLength={48} />
        </label>
        <p className="text-sol-text-muted">Approval comes before setup. After you approve, reconcile creates the role with its routines paused. Spending and publishing need separate authorization.</p>
        {result.command ? (
          <pre aria-label="Template install command" className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-sol-border/50 bg-sol-bg-alt p-3 text-[11px] leading-relaxed text-sol-text" style={{ fontFamily: "var(--font-mono)" }}>{result.command}</pre>
        ) : <p role="status" className="text-[11.5px] text-sol-text-muted">{result.error}</p>}
        <div className="flex items-center justify-end gap-2">
          <span role="status" className="mr-auto text-[11px] text-sol-text-muted">{copyError ? "Copy failed. Select the command and copy it manually." : copied ? "Command copied. Nothing has run yet." : ""}</span>
          <button type="button" disabled={!result.command} onClick={() => void copy()} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-sol-border/50 px-3 text-[12.5px] text-sol-text disabled:opacity-50"><Copy className="h-3.5 w-3.5" />Copy command</button>
        </div>
      </div>
    </details>
  );
}

const LABEL = "flex flex-col gap-1";
const CAPTION = "text-[11px] font-semibold uppercase tracking-[0.08em] text-sol-text-dim";
const INPUT = "h-9 w-full rounded-lg border border-sol-border/50 bg-sol-bg-alt px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-cyan";
