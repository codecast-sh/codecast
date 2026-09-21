import { useMemo, useState } from "react";
import { captureException } from "@sentry/react";
import { Copy } from "lucide-react";
import { copyToClipboard } from "../../lib/utils";
import { inWorkspace } from "../../lib/workspaceScope";
import { SelectBox } from "../ui/select-box";
import type { OrgRole, OrgTree } from "./orgTypes";
import { buildOrgTemplateCommand, type TemplateDraft, type TemplateProject } from "./orgTemplateCommand";
import { askedInputs, buildHireSpec, grantsToAsk, hireErrors, resolvedConfig, secretInputs, slugOf, type HireDraft } from "./orgTemplateSpec";
import { useTemplateActions, useTemplateCatalog } from "../../hooks/useTemplateHire";
import { RoleAvatar } from "./avatars";
import { avatarOf } from "@codecast/shared/contracts/orgAvatars";

// Hiring from a template (docs/architecture/org-hire.md H3): the catalog this
// workspace may hire from, the template's inputs as a form, the lead rule, a
// preview of the one proposal a person will decide, and the post. Secrets are
// never typed here; they bind on the host after approval. The folder path for
// template authors stays behind a fold: it copies a command and runs nothing.

export function OrgTemplateHire({ projects, workspace, roles = [], initialProjectId = "", projectPath = "", onClose }: {
  projects: TemplateProject[];
  workspace: OrgTree["workspace"];
  roles?: OrgRole[];
  initialProjectId?: string;
  projectPath?: string;
  onClose: () => void;
}) {
  const teamId = workspace.kind === "team" ? workspace.id : undefined;
  const { templates, ready } = useTemplateCatalog(teamId);
  const { propose } = useTemplateActions();
  const available = projects.filter((p) => p.workspace && inWorkspace(p, `${workspace.kind}:${workspace.id}`));
  const [templateId, setTemplateId] = useState("");
  const [projectId, setProjectId] = useState(initialProjectId);
  const [instance, setInstance] = useState("");
  const [instanceTouched, setInstanceTouched] = useState(false);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [seat, setSeat] = useState<"new" | "under" | "lead">("new");
  const [policy, setPolicy] = useState<HireDraft["updatePolicy"]>("stable");
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState<{ short_id: string; link?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const template = templates.find((t) => t.template_id === templateId) ?? null;
  const project = available.find((p) => p._id === projectId) ?? null;
  // The project's lead (R4, W9 I2): a live role whose scope names the project.
  const lead = useMemo(() => project ? roles.find((r) => r.status !== "retired" && ((r.scope as any)?.project_ids ?? []).some((id: string) => id === project._id)) ?? null : null, [roles, project]);
  const effInstance = instanceTouched ? instance : project && template ? `${slugOf(project.title)}-${template.template_id}` : "";
  const draft: HireDraft = { template, project, instance: effInstance, config, reportsTo: lead && seat === "under" ? `@${lead.handle}` : "me", seatHandle: lead && seat === "lead" ? lead.handle : null, updatePolicy: policy };
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
          <p className="mt-1 text-sol-text-muted">Decide it on the org page: accept the role, its authority and the hire in one ask. After you accept, run <code style={{ fontFamily: "var(--font-mono)" }}>cast org template bind {effInstance}</code> in the project&apos;s checkout to pin the release and create the routines, paused.</p>
        </div>
        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-lg px-3 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-highlight">Close</button>
          <a href={`/org?proposal=${posted.short_id}`} className="inline-flex h-8 items-center rounded-lg bg-sol-violet px-3.5 text-[12.5px] font-semibold text-sol-bg">Open {posted.short_id}</a>
        </div>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void submit(); }} data-template-form>
      <label className={LABEL}>
        <span className={CAPTION}>Template</span>
        <SelectBox value={templateId} onChange={(e) => { setTemplateId(e.target.value); setConfig({}); }} className="text-[13px]">
          <option value="">{ready ? (templates.length ? "Choose a template" : "No templates yet") : "Loading…"}</option>
          {templates.map((t) => <option key={`${t.workspace}:${t.template_id}`} value={t.template_id}>{t.name} · {t.template_id} {t.latest.version}{t.workspace === "codecast" ? " · by Codecast" : ""}</option>)}
        </SelectBox>
        {template && (
          <div className="flex items-start gap-2 pt-1 text-[12px] leading-relaxed text-sol-text-muted">
            <RoleAvatar avatar={avatarOf({ avatar: template.avatar, handle: template.template_id })} size={28} />
            <p>{template.description} <span className="text-sol-text-dim">Asks {template.asks.inputs - template.asks.secrets} answer{template.asks.inputs - template.asks.secrets === 1 ? "" : "s"}, {template.asks.secrets} secret{template.asks.secrets === 1 ? "" : "s"} bound on the host, {template.asks.authority} grant{template.asks.authority === 1 ? "" : "s"} of authority, {template.asks.setup} setup step{template.asks.setup === 1 ? "" : "s"}; runs {template.asks.routines} routine{template.asks.routines === 1 ? "" : "s"}.</span></p>
          </div>
        )}
      </label>
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
          <p className="text-sol-text"><span className="font-semibold">@{lead.handle}</span> already leads {project?.title}. A second role beside a lead is refused, so choose:</p>
          <div className="mt-1.5 flex flex-col gap-1">
            {([["under", `Hire under @${lead.handle}: the new role reports to it and it stays the lead`], ["lead", `Name @${lead.handle} as the seat: no new role; it takes the template's routines and record`]] as const).map(([value, label]) => (
              <label key={value} className="flex items-start gap-2 text-sol-text-muted"><input type="radio" name="template-seat" checked={seat === value} onChange={() => setSeat(value)} className="mt-0.5" />{label}</label>
            ))}
          </div>
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
          <p className="font-semibold text-sol-text">Bound on the host, never typed here</p>
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
      {spec && manifest && (
        <div className="rounded-lg border border-sol-border/50 px-3 py-2.5 text-[12px] leading-relaxed" data-template-preview>
          <p className="font-semibold text-sol-text">What you will decide</p>
          <ul className="mt-1 list-disc pl-4 text-sol-text-muted">
            {spec.changes.map((c, i) => <li key={i}>{c.kind === "role" ? `A new role ${c.name} @${c.handle} at understand trust, reporting to ${c.reports_to}` : c.kind === "authority" ? `Authority outside codecast: ${c.authority.map((g) => `${g.kind} (${g.label})`).join("; ")}` : c.kind === "hire" ? `The hire: ${c.template} ${c.version} as ${c.instance} on ${project?.title}` : ""}</li>)}
            <li>{manifest.routines.length} routine{manifest.routines.length === 1 ? "" : "s"}, created paused; you activate each from the role page once it is ready.</li>
            {(manifest.setup ?? []).some((s) => s.who === "human") && <li>{(manifest.setup ?? []).filter((s) => s.who === "human").length} setup steps only you can do; the role puts one in front of you at a time.</li>}
          </ul>
          {grantsToAsk(manifest, resolvedConfig(manifest, config)).length === 0 && (manifest.authority ?? []).length > 0 && <p className="mt-1 text-sol-text-dim">Authority is not asked for yet: its inputs are unanswered.</p>}
        </div>
      )}
      {!spec && template && project && errors.length > 0 && <p role="status" className="text-[11.5px] text-sol-text-muted">{errors[0]}</p>}
      {error && <p role="alert" className="text-[11.5px] text-sol-red">{error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button type="button" onClick={onClose} className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-highlight">Close</button>
        <button type="submit" disabled={!spec || posting} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-sol-violet px-3.5 text-[12.5px] font-semibold text-sol-bg disabled:opacity-50">{posting ? "Proposing…" : "Propose the hire"}</button>
      </div>
      <FolderPath projects={available} workspace={workspace} initialProjectId={projectId} projectPath={projectPath} />
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
        <p className="text-sol-text-muted">Approval comes before setup. After you approve, reconcile creates the role at Understand trust with routines paused. Spending and publishing need separate authorization.</p>
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
