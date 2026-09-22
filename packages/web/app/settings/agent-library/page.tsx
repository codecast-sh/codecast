// Settings > Agent library: the named agent definitions and chains a
// workspace runs with. A definition binds a client, a model, an effort, a
// tool policy and a system prompt under one name that every launch surface
// accepts (`cast exec --as reviewer`, a workflow node's `definition=`, the
// compose "as" chooser). A chain runs definitions in order, each step's
// output feeding the next.
//
// Rows render from the store (useAgentDefinitions / useAgentChains) and every
// edit is an optimistic store action; the markdown form (pi and Claude Code's
// agents/*.md shape) is the import and export door.

import { useMemo, useState } from "react";
import { Bot, Copy, Download, GitBranch, Plus, Trash2, Upload, ArrowUp, ArrowDown } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "../../../lib/copyText";
import {
  AGENT_LAUNCH_OPTIONS,
  AGENT_MODEL_CONFIG,
  modelAgentKey,
  validateAgentChain,
  validateAgentDefinition,
  type AgentChainSpec,
  type AgentClientId,
  type AgentDefinitionSpec,
} from "@codecast/shared/contracts";
import {
  isAgentChainFile,
  parseAgentChainFile,
  parseAgentDefinitionFile,
  serializeAgentChainFile,
  serializeAgentDefinitionFile,
} from "@codecast/shared/agents";
import { useInboxStore } from "../../../store/inboxStore";
import { useAgentChains, useAgentDefinitions, type AgentChainRow, type AgentDefinitionRow } from "../../../hooks/useSyncAgentDefinitions";
import { useDynamicModels } from "../../../hooks/useDynamicModels";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Textarea } from "../../../components/ui/textarea";
import { Switch } from "../../../components/ui/switch";
import { SelectBox } from "../../../components/ui/select-box";
import { SettingsCallout, SettingsField, SettingsOptionGroup, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { AgentTypeIcon } from "../../../components/AgentTypeIcon";

type DefinitionDraft = AgentDefinitionSpec & { _id?: string; toolsText: string; disallowedText: string };
type ChainDraft = AgentChainSpec & { _id?: string };

const EMPTY_DEFINITION: DefinitionDraft = {
  name: "",
  description: "",
  system_prompt: "",
  prompt_mode: "append",
  mode: "apply",
  toolsText: "",
  disallowedText: "",
};

const splitList = (s: string) => s.split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

function toDraft(row: AgentDefinitionRow): DefinitionDraft {
  return {
    _id: row._id,
    name: row.name,
    description: row.description,
    agent: row.agent,
    model: row.model,
    effort: row.effort,
    system_prompt: row.system_prompt ?? "",
    prompt_mode: row.prompt_mode ?? "append",
    mode: row.mode ?? "apply",
    isolated: row.isolated ?? false,
    toolsText: (row.tools ?? []).join(", "),
    disallowedText: (row.disallowed_tools ?? []).join(", "),
  };
}

function toSpec(d: DefinitionDraft): AgentDefinitionSpec & { _id?: string } {
  const spec: AgentDefinitionSpec & { _id?: string } = {
    _id: d._id,
    name: d.name.trim(),
    description: d.description.trim(),
    agent: d.agent,
    model: d.model && d.model !== "default" ? d.model : undefined,
    effort: d.effort || undefined,
    tools: splitList(d.toolsText),
    disallowed_tools: splitList(d.disallowedText),
    system_prompt: d.system_prompt?.trim() || undefined,
    prompt_mode: d.prompt_mode === "replace" ? "replace" : "append",
    mode: d.mode === "propose" ? "propose" : "apply",
    isolated: d.isolated === true,
  };
  return spec;
}


// ─── Definition editor ───────────────────────────────────────────────────────

function DefinitionEditor({
  initial,
  onSaved,
  onCancel,
  onDelete,
}: {
  initial: DefinitionDraft;
  onSaved: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const upsert = useInboxStore((s) => s.upsertAgentDefinition);
  const [d, setD] = useState<DefinitionDraft>(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<DefinitionDraft>) => setD((cur) => ({ ...cur, ...patch }));

  const agentKey = modelAgentKey(d.agent);
  const cfg = d.agent ? AGENT_MODEL_CONFIG[agentKey] : undefined;
  const { featured } = useDynamicModels(d.agent);
  const modelOptions = useMemo(() => {
    const opts = (cfg?.models ?? []).filter((m) => m.key !== "default");
    const seen = new Set(opts.map((m) => m.key));
    for (const m of featured) if (!seen.has(m.key)) opts.push(m);
    return opts;
  }, [cfg, featured]);
  const efforts = (cfg?.efforts ?? []) as readonly string[];

  const problems = validateAgentDefinition(toSpec(d));
  const save = async () => {
    if (problems.length) {
      toast.error(problems[0]);
      return;
    }
    setSaving(true);
    try {
      await upsert(toSpec(d));
      toast.success(`Saved ${d.name}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="divide-y divide-sol-border/40">
      <div className="grid gap-0 sm:grid-cols-2">
        <SettingsField label="Name" hint="Lowercase, digits and hyphens. This is the --as value.">
          <Input value={d.name} onChange={(e) => set({ name: e.target.value.toLowerCase() })} placeholder="reviewer" className="font-mono" />
        </SettingsField>
        <SettingsField label="Description" hint="One line a picker can show.">
          <Input value={d.description} onChange={(e) => set({ description: e.target.value })} placeholder="Reviews a diff for correctness" />
        </SettingsField>
      </div>
      <SettingsField label="Agent" hint="Leave unset to run on whatever client the caller uses.">
        <SettingsOptionGroup
          label="Agent client"
          variant="pill"
          value={d.agent ?? ""}
          onChange={(v) => set({ agent: (v || undefined) as AgentClientId | undefined, model: undefined, effort: undefined })}
          options={[{ value: "", label: "Caller's" }, ...AGENT_LAUNCH_OPTIONS.map((a) => ({ value: a.id, label: a.label }))]}
        />
      </SettingsField>
      {d.agent && (
        <div className="grid gap-0 sm:grid-cols-2">
          <SettingsField label="Model">
            <SelectBox value={d.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })}>
              <option value="">Client default</option>
              {modelOptions.map((m) => (
                <option key={m.key} value={m.key}>{m.label}{m.hint ? ` · ${m.hint}` : ""}</option>
              ))}
            </SelectBox>
            {cfg?.dynamic && (
              <Input className="mt-2 font-mono" value={d.model ?? ""} onChange={(e) => set({ model: e.target.value || undefined })} placeholder="provider/model" />
            )}
          </SettingsField>
          <SettingsField label="Effort" hint={efforts.length === 0 ? `${d.agent} has no effort flag.` : undefined}>
            {efforts.length > 0 ? (
              <SettingsOptionGroup
                label="Effort"
                variant="pill"
                value={d.effort ?? ""}
                onChange={(v) => set({ effort: v || undefined })}
                options={[{ value: "", label: "Default" }, ...efforts.map((e) => ({ value: e, label: e }))]}
              />
            ) : (
              <div className="text-xs text-sol-text-dim">Not available</div>
            )}
          </SettingsField>
        </div>
      )}
      <div className="grid gap-0 sm:grid-cols-2">
        <SettingsField label="Tools" hint="Allowlist by native tool name, comma separated (claude --allowedTools, pi --tools). Empty means every tool.">
          <Input value={d.toolsText} onChange={(e) => set({ toolsText: e.target.value })} placeholder="Read, Grep, Bash" className="font-mono" />
        </SettingsField>
        <SettingsField label="Disallowed tools" hint="Denylist (claude --disallowedTools). A read only definition adds the safe mode rules too.">
          <Input value={d.disallowedText} onChange={(e) => set({ disallowedText: e.target.value })} placeholder="Write, Edit" className="font-mono" />
        </SettingsField>
      </div>
      <div className="grid gap-0 sm:grid-cols-3">
        <SettingsField label="Mode">
          <SettingsOptionGroup
            label="Mode"
            variant="pill"
            value={d.mode ?? "apply"}
            onChange={(v) => set({ mode: v as "apply" | "propose" })}
            options={[
              { value: "apply", label: "Can act" },
              { value: "propose", label: "Read only" },
            ]}
          />
        </SettingsField>
        <SettingsField label="Prompt">
          <SettingsOptionGroup
            label="Prompt mode"
            variant="pill"
            value={d.prompt_mode ?? "append"}
            onChange={(v) => set({ prompt_mode: v as "append" | "replace" })}
            options={[
              { value: "append", label: "Append" },
              { value: "replace", label: "Replace" },
            ]}
          />
        </SettingsField>
        <SettingsField label="Own worktree" hint="Start the session in an isolated git worktree.">
          <Switch checked={d.isolated === true} onCheckedChange={(v) => set({ isolated: v })} aria-label="Own worktree" />
        </SettingsField>
      </div>
      <SettingsField label="System prompt" hint="The role's instructions. Appended to the client's own system prompt unless Prompt is set to Replace.">
        <Textarea
          value={d.system_prompt ?? ""}
          onChange={(e) => set({ system_prompt: e.target.value })}
          rows={10}
          placeholder="You are a senior reviewer. Read the diff, check each acceptance criterion, and end with a verdict."
          className="font-mono text-xs"
        />
      </SettingsField>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          {onDelete && (
            <Button variant="ghost" size="sm" onClick={onDelete} className="text-sol-red">
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => copyText(serializeAgentDefinitionFile(toSpec(d)), "Definition markdown copied")}>
            <Download className="mr-1 h-3.5 w-3.5" /> Export
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {problems.length > 0 && <span className="text-xs text-sol-text-dim">{problems[0]}</span>}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="sm" variant="cyan" onClick={save} disabled={saving || problems.length > 0}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Chain editor ────────────────────────────────────────────────────────────

function ChainEditor({
  initial,
  definitions,
  onSaved,
  onCancel,
  onDelete,
}: {
  initial: ChainDraft;
  definitions: AgentDefinitionRow[];
  onSaved: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const upsert = useInboxStore((s) => s.upsertAgentChain);
  const [c, setC] = useState<ChainDraft>(initial);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<ChainDraft>) => setC((cur) => ({ ...cur, ...patch }));
  const setStep = (i: number, patch: Partial<AgentChainSpec["steps"][number]>) =>
    set({ steps: c.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= c.steps.length) return;
    const steps = [...c.steps];
    [steps[i], steps[j]] = [steps[j], steps[i]];
    set({ steps });
  };
  const known = useMemo(() => new Set(definitions.map((d) => d.name)), [definitions]);
  const problems = validateAgentChain({ name: c.name.trim(), description: c.description.trim(), steps: c.steps }, known);

  const save = async () => {
    if (problems.length) {
      toast.error(problems[0]);
      return;
    }
    setSaving(true);
    try {
      await upsert({ _id: c._id, name: c.name.trim(), description: c.description.trim(), steps: c.steps.map((s) => ({ agent: s.agent, prompt: s.prompt.trim() })) });
      toast.success(`Saved ${c.name}`);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="divide-y divide-sol-border/40">
      <div className="grid gap-0 sm:grid-cols-2">
        <SettingsField label="Name" hint={'Lowercase, digits and hyphens. cast agent run <name> "task".'}>
          <Input value={c.name} onChange={(e) => set({ name: e.target.value.toLowerCase() })} placeholder="implement" className="font-mono" />
        </SettingsField>
        <SettingsField label="Description">
          <Input value={c.description} onChange={(e) => set({ description: e.target.value })} placeholder="scout, plan, then build" />
        </SettingsField>
      </div>
      <div className="px-4 py-3 sm:px-5">
        <div className="mb-2 text-xs font-medium text-sol-text-muted">Steps</div>
        <SettingsCallout className="mb-3">
          Each step's prompt is a template. <code className="font-mono">{"{task}"}</code> is the chain's input and{" "}
          <code className="font-mono">{"{previous}"}</code> is the prior step's output. A prompt with neither gets the previous output appended.
        </SettingsCallout>
        <div className="space-y-3">
          {c.steps.map((step, i) => (
            <div key={i} className="rounded-lg border border-sol-border/50 bg-sol-bg p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="w-5 text-xs text-sol-text-dim">{i + 1}.</span>
                <SelectBox value={step.agent} onChange={(e) => setStep(i, { agent: e.target.value })} wrapperClassName="flex-1">
                  <option value="">Pick a definition…</option>
                  {definitions.map((d) => (
                    <option key={d._id} value={d.name}>{d.name} · {d.description}</option>
                  ))}
                  {step.agent && !known.has(step.agent) && <option value={step.agent}>{step.agent} (missing)</option>}
                </SelectBox>
                <Button variant="ghost" size="icon" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" onClick={() => move(i, 1)} disabled={i === c.steps.length - 1} aria-label="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
                <Button variant="ghost" size="icon" onClick={() => set({ steps: c.steps.filter((_, j) => j !== i) })} aria-label="Remove step" className="text-sol-red"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
              <Textarea
                value={step.prompt}
                onChange={(e) => setStep(i, { prompt: e.target.value })}
                rows={4}
                placeholder={i === 0 ? "Find the code relevant to: {task}" : "Using these findings:\n{previous}\n\nDo the next part of: {task}"}
                className="font-mono text-xs"
              />
            </div>
          ))}
        </div>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => set({ steps: [...c.steps, { agent: definitions[0]?.name ?? "", prompt: c.steps.length === 0 ? "{task}" : "{previous}" }] })}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add step
        </Button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2">
          {onDelete && (
            <Button variant="ghost" size="sm" onClick={onDelete} className="text-sol-red">
              <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => copyText(serializeAgentChainFile({ name: c.name, description: c.description, steps: c.steps }), "Chain markdown copied")}>
            <Download className="mr-1 h-3.5 w-3.5" /> Export
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {problems.length > 0 && <span className="text-xs text-sol-text-dim">{problems[0]}</span>}
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button size="sm" variant="cyan" onClick={save} disabled={saving || problems.length > 0}>{saving ? "Saving…" : "Save"}</Button>
        </div>
      </div>
    </div>
  );
}

// ─── Import ──────────────────────────────────────────────────────────────────

function ImportBox({ onClose }: { onClose: () => void }) {
  const upsertDef = useInboxStore((s) => s.upsertAgentDefinition);
  const upsertChain = useInboxStore((s) => s.upsertAgentChain);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      if (isAgentChainFile(text)) {
        const chain = parseAgentChainFile(text);
        const problems = validateAgentChain(chain);
        if (problems.length) throw new Error(problems[0]);
        await upsertChain(chain);
        toast.success(`Imported chain ${chain.name}`);
      } else {
        const def = parseAgentDefinitionFile(text);
        const problems = validateAgentDefinition(def);
        if (problems.length) throw new Error(problems[0]);
        await upsertDef(def);
        toast.success(`Imported ${def.name}`);
      }
      onClose();
    } catch (e: any) {
      toast.error(e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="mb-2 text-xs text-sol-text-muted">
        Paste a definition file (frontmatter with name, description, model, tools; the body is the system prompt) or a chain file (frontmatter plus one <code className="font-mono">## step</code> section per step). Claude Code's <code className="font-mono">~/.claude/agents/*.md</code> and pi's agent files both work as is.
      </div>
      <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="font-mono text-xs" placeholder={"---\nname: scout\ndescription: Fast codebase recon\nmodel: haiku\ntools: Read, Grep, Glob\n---\nYou are a scout. ..."} />
      <div className="mt-2 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="cyan" onClick={run} disabled={busy || !text.trim()}>{busy ? "Importing…" : "Import"}</Button>
      </div>
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function AgentLibraryPage() {
  const definitions = useAgentDefinitions();
  const chains = useAgentChains();
  const removeDef = useInboxStore((s) => s.removeAgentDefinition);
  const removeChain = useInboxStore((s) => s.removeAgentChain);
  const [openDef, setOpenDef] = useState<string | "new" | null>(null);
  const [openChain, setOpenChain] = useState<string | "new" | null>(null);
  const [importing, setImporting] = useState(false);

  const defRow = openDef && openDef !== "new" ? definitions.find((d) => d._id === openDef) : undefined;
  const chainRow = openChain && openChain !== "new" ? chains.find((c) => c._id === openChain) : undefined;

  return (
    <SettingsPanel>
      <SettingsSection
        title="Agent definitions"
        icon={Bot}
        description="Named roles: a client, a model, an effort, a tool policy and a system prompt under one name. Use one with cast exec --as <name>, cast spawn --as <name>, a workflow node's definition attribute, or the compose bar."
        actions={
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => { setImporting((v) => !v); setOpenDef(null); }}>
              <Upload className="mr-1 h-3.5 w-3.5" /> Import
            </Button>
            <Button size="sm" variant="cyan" onClick={() => { setOpenDef("new"); setImporting(false); }}>
              <Plus className="mr-1 h-3.5 w-3.5" /> New
            </Button>
          </div>
        }
      >
        {importing && <ImportBox onClose={() => setImporting(false)} />}
        {openDef === "new" && (
          <DefinitionEditor initial={EMPTY_DEFINITION} onSaved={() => setOpenDef(null)} onCancel={() => setOpenDef(null)} />
        )}
        {definitions.length === 0 && openDef !== "new" && !importing && (
          <div className="px-4 py-6 text-center text-xs text-sol-text-dim sm:px-5">
            No definitions in this workspace yet. Create one, or run <code className="font-mono">cast agent import ~/.claude/agents/*.md</code> to bring in the ones you already have. Personal definitions show in the personal workspace; every one you hold still resolves at launch.
          </div>
        )}
        {definitions.map((d) =>
          openDef === d._id && defRow ? (
            <DefinitionEditor
              key={d._id}
              initial={toDraft(defRow)}
              onSaved={() => setOpenDef(null)}
              onCancel={() => setOpenDef(null)}
              onDelete={() => { removeDef(d._id); setOpenDef(null); toast.success(`Deleted ${d.name}`); }}
            />
          ) : (
            <button
              key={d._id}
              type="button"
              onClick={() => { setOpenDef(d._id); setImporting(false); }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sol-bg-highlight/40 sm:px-5"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sol-bg-alt">
                {d.agent ? <AgentTypeIcon agentType={AGENT_LAUNCH_OPTIONS.find((a) => a.id === d.agent)?.convexType ?? d.agent} className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5 text-sol-text-dim" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-sm text-sol-text">{d.name}</span>
                  {d.mode === "propose" && <span className="rounded bg-sol-yellow/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sol-yellow">read only</span>}
                  {d.isolated && <span className="rounded bg-sol-bg-alt px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-sol-text-dim">worktree</span>}
                </span>
                <span className="block truncate text-xs text-sol-text-muted">{d.description}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-sol-text-dim">
                {[d.agent ?? "caller", d.model, d.effort].filter(Boolean).join(" · ")}
              </span>
              <Copy
                className="h-3.5 w-3.5 shrink-0 text-sol-text-dim hover:text-sol-text"
                onClick={(e) => { e.stopPropagation(); copyText(`cast exec --as ${d.name} "…"`, "Command copied"); }}
              />
            </button>
          ),
        )}
      </SettingsSection>

      <SettingsSection
        title="Chains"
        icon={GitBranch}
        description={'Definitions run in order. Each step\'s final output feeds the next step\'s prompt. Run one with cast agent run <chain> "task".'}
        actions={
          <Button size="sm" variant="cyan" onClick={() => setOpenChain("new")} disabled={definitions.length === 0}>
            <Plus className="mr-1 h-3.5 w-3.5" /> New
          </Button>
        }
      >
        {openChain === "new" && (
          <ChainEditor initial={{ name: "", description: "", steps: [] }} definitions={definitions} onSaved={() => setOpenChain(null)} onCancel={() => setOpenChain(null)} />
        )}
        {chains.length === 0 && openChain !== "new" && (
          <div className="px-4 py-6 text-center text-xs text-sol-text-dim sm:px-5">
            {definitions.length === 0 ? "Create a definition first." : "No chains yet."}
          </div>
        )}
        {chains.map((c) =>
          openChain === c._id && chainRow ? (
            <ChainEditor
              key={c._id}
              initial={{ _id: chainRow._id, name: chainRow.name, description: chainRow.description, steps: chainRow.steps }}
              definitions={definitions}
              onSaved={() => setOpenChain(null)}
              onCancel={() => setOpenChain(null)}
              onDelete={() => { removeChain(c._id); setOpenChain(null); toast.success(`Deleted ${c.name}`); }}
            />
          ) : (
            <button
              key={c._id}
              type="button"
              onClick={() => setOpenChain(c._id)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sol-bg-highlight/40 sm:px-5"
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-sol-bg-alt"><GitBranch className="h-3.5 w-3.5 text-sol-text-dim" /></span>
              <span className="min-w-0 flex-1">
                <span className="font-mono text-sm text-sol-text">{c.name}</span>
                <span className="block truncate text-xs text-sol-text-muted">{c.description}</span>
              </span>
              <span className="shrink-0 font-mono text-[11px] text-sol-text-dim">{c.steps.map((s) => s.agent).join(" → ")}</span>
            </button>
          ),
        )}
      </SettingsSection>
    </SettingsPanel>
  );
}
