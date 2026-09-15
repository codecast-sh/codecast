import { useState } from "react";
import { captureException } from "@sentry/react";
import { Copy } from "lucide-react";
import { copyToClipboard } from "../../lib/utils";
import { inWorkspace } from "../../lib/workspaceScope";
import { SelectBox } from "../ui/select-box";
import type { OrgTree } from "./orgTypes";
import { buildOrgTemplateCommand, type TemplateDraft, type TemplateProject } from "./orgTemplateCommand";

export function OrgTemplateHire({ projects, workspace, initialProjectId = "", projectPath = "", onClose }: {
  projects: TemplateProject[];
  workspace: OrgTree["workspace"];
  initialProjectId?: string;
  projectPath?: string;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TemplateDraft>({ projectId: initialProjectId, projectPath, folder: "", instance: "" });
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const available = projects.filter((p) => p.workspace && inWorkspace(p, `${workspace.kind}:${workspace.id}`));
  const result = buildOrgTemplateCommand(draft, available, workspace);
  const update = (patch: Partial<TemplateDraft>) => { setDraft({ ...draft, ...patch }); setCopied(false); setCopyError(false); };
  const copy = async () => {
    if (!result.command) return;
    try {
      await copyToClipboard(result.command);
      setCopied(true);
      setCopyError(false);
    } catch (error) {
      captureException(error);
      setCopyError(true);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[12px] leading-relaxed text-sol-text-muted">Use a folder with a charter, skills and recurring routines, such as a CMO growth template. The CLI inspects and pins the complete folder before proposing a role.</p>
      <label className={LABEL}>
        <span className={CAPTION}>Project</span>
        <SelectBox value={draft.projectId} onChange={(e) => update({ projectId: e.target.value, projectPath: "" })} className="text-[13px]">
          <option value="">Choose a project</option>
          {available.map((p) => <option key={p._id} value={p._id}>{p.title}</option>)}
        </SelectBox>
        <span className="text-[11px] text-sol-text-dim">{available.length ? `One project in ${workspace.name}. Required for a template.` : "Create a project in this workspace before using a template."}</span>
      </label>
      <label className={LABEL}>
        <span className={CAPTION}>Project checkout on host</span>
        <input value={draft.projectPath} onChange={(e) => update({ projectPath: e.target.value })} placeholder="/path/to/project" className={INPUT} spellCheck={false} autoCapitalize="none" />
        <span className="text-[11px] text-sol-text-dim">This directory must exist on the selected host and be confirmed during adoption. The template won't relocate or rewrite the project's shared path.</span>
      </label>
      <label className={LABEL}>
        <span className={CAPTION}>Template folder on host</span>
        <input value={draft.folder} onChange={(e) => update({ folder: e.target.value })} placeholder="/path/to/templates/growth" className={INPUT} spellCheck={false} autoCapitalize="none" />
        <span className="text-[11px] text-sol-text-dim">Contains org-template.json. Both paths must exist on the machine where you run the command.</span>
      </label>
      <label className={LABEL}>
        <span className={CAPTION}>Instance name</span>
        <input name="template-instance" value={draft.instance} onChange={(e) => update({ instance: e.target.value })} placeholder="acme-growth" className={INPUT} spellCheck={false} autoCapitalize="none" maxLength={48} />
        <span className="text-[11px] text-sol-text-dim">Include the project name; templates may use this in a role handle that must be unique in the workspace. Reuse it to continue setup.</span>
      </label>
      <div className="rounded-lg border border-sol-border/50 bg-sol-bg-alt px-3 py-2.5 text-[12px] leading-relaxed">
        <p className="font-semibold text-sol-text">Approval comes before setup</p>
        <p className="mt-1 text-sol-text-muted">Review the proposed charter, project scope and daily caps. After you approve, run reconcile to create the role at Understand trust with routines paused. Spending and publishing need separate authorization.</p>
      </div>
      {result.command ? (
        <div className="flex flex-col gap-1.5">
          <span className={CAPTION}>Run in a Cast session on the host</span>
          <pre aria-label="Template install command" className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-sol-border/50 bg-sol-bg-alt p-3 text-[11px] leading-relaxed text-sol-text" style={{ fontFamily: "var(--font-mono)" }}>{result.command}</pre>
          <p className="text-[11px] text-sol-text-dim">Copying does not run anything. Run from a Cast session so the proposal is linked to it. Install opens a proposal; follow the CLI's approval and reconcile instructions to set up the role.</p>
        </div>
      ) : <p role="status" className="text-[11.5px] text-sol-text-muted">{result.error}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <span role="status" className="mr-auto text-[11px] text-sol-text-muted">{copyError ? "Copy failed. Select the command and copy it manually." : copied ? "Command copied. Nothing has run yet." : ""}</span>
        <button type="button" onClick={onClose} className="h-8 shrink-0 rounded-lg px-3 text-[12.5px] text-sol-text-muted hover:bg-sol-bg-highlight">Close</button>
        <button type="button" disabled={!result.command} onClick={() => void copy()} className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-sol-violet px-3.5 text-[12.5px] font-semibold text-sol-bg disabled:opacity-50"><Copy className="h-3.5 w-3.5" />Copy command</button>
      </div>
    </div>
  );
}

const LABEL = "flex flex-col gap-1";
const CAPTION = "text-[11px] font-semibold uppercase tracking-[0.08em] text-sol-text-dim";
const INPUT = "h-9 w-full rounded-lg border border-sol-border/50 bg-sol-bg-alt px-2.5 text-[13px] text-sol-text outline-none focus:border-sol-cyan";
