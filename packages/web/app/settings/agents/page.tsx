import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import { Card } from "../../../components/ui/card";
import { toast } from "sonner";

type ClaudeMode = "default" | "bypass";
type CodexMode = "default" | "full_auto" | "bypass";
type GeminiMode = "default" | "bypass";

const claudeOptions: { value: ClaudeMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Prompts for dangerous operations", flag: "(no extra flags)" },
  { value: "bypass", label: "No Restrictions", description: "Skip all permission prompts", flag: "--permission-mode bypassPermissions" },
];

const codexOptions: { value: CodexMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Prompts for every command", flag: "(no extra flags)" },
  { value: "full_auto", label: "Full Auto", description: "Sandboxed, model decides when to escalate", flag: "--full-auto" },
  { value: "bypass", label: "No Restrictions", description: "No approval prompts, no sandbox", flag: "-a never -s danger-full-access" },
];

const geminiOptions: { value: GeminiMode; label: string; description: string; flag: string }[] = [
  { value: "default", label: "Default", description: "Standard permission model", flag: "(no extra flags)" },
  { value: "bypass", label: "No Restrictions", description: "Skip all permission prompts", flag: "(bypass flags)" },
];

export default function AgentsPage() {
  const modes = useQuery(api.users.getAgentPermissionModes);
  const updateModes = useMutation(api.users.updateAgentPermissionModes);
  const defaultParams = useQuery(api.users.getAgentDefaultParams);
  const updateDefaultParamsMutation = useMutation(api.users.updateAgentDefaultParams);

  const claude = modes?.claude ?? "default";
  const codex = modes?.codex ?? "default";
  const gemini = modes?.gemini ?? "default";

  const handleUpdate = async (updates: {
    claude?: ClaudeMode;
    codex?: CodexMode;
    gemini?: GeminiMode;
  }) => {
    try {
      await updateModes({
        claude: updates.claude ?? claude,
        codex: updates.codex ?? codex,
        gemini: updates.gemini ?? gemini,
      });
      toast.success("Permission mode updated");
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const updateDefaultParams = async (args: { agent: string; params: Record<string, string> }) => {
    try {
      await updateDefaultParamsMutation({
        agent: args.agent as "claude" | "codex" | "gemini" | "cursor",
        params: args.params,
      });
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="space-y-6">
      <Card className="p-6 bg-sol-bg border-sol-border">
        <h2 className="text-lg font-semibold text-sol-text mb-1">Agent Permissions</h2>
        <p className="text-sm text-sol-base1 mb-6">
          Control how much autonomy each agent has when running commands. Sessions managed by codecast run in tmux without a terminal attached, so restrictive modes will cause sessions to block on approval prompts.
        </p>

        <div className="space-y-6">
          <AgentSection
            name="Claude Code"
            current={claude}
            options={claudeOptions}
            onChange={(v) => handleUpdate({ claude: v as ClaudeMode })}
          />

          <AgentSection
            name="Codex"
            current={codex}
            options={codexOptions}
            onChange={(v) => handleUpdate({ codex: v as CodexMode })}
          />

          <AgentSection
            name="Gemini"
            current={gemini}
            options={geminiOptions}
            onChange={(v) => handleUpdate({ gemini: v as GeminiMode })}
          />
        </div>

        <div className="mt-8 pt-6 border-t border-sol-border">
          <h2 className="text-lg font-semibold text-sol-text mb-1">Default Parameters</h2>
          <p className="text-sm text-sol-base1 mb-6">
            Set default CLI flags for each agent. These are passed as --flag value when sessions start.
          </p>

          <div className="space-y-6">
            <AgentParams
              name="Claude Code"
              agent="claude"
              params={defaultParams?.claude}
              onUpdate={updateDefaultParams}
            />
            <AgentParams
              name="Codex"
              agent="codex"
              params={defaultParams?.codex}
              onUpdate={updateDefaultParams}
            />
            <AgentParams
              name="Gemini"
              agent="gemini"
              params={defaultParams?.gemini}
              onUpdate={updateDefaultParams}
            />
            <AgentParams
              name="Cursor"
              agent="cursor"
              params={defaultParams?.cursor}
              onUpdate={updateDefaultParams}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}

function AgentSection({
  name,
  current,
  options,
  onChange,
}: {
  name: string;
  current: string;
  options: { value: string; label: string; description: string; flag: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-sol-text mb-2">{name}</h3>
      <div className="flex gap-2">
        {options.map((opt) => {
          const isActive = current === opt.value;
          return (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={`flex-1 rounded-lg border px-3 py-2.5 text-left transition-colors ${
                isActive
                  ? "border-sol-cyan bg-sol-cyan/10 text-sol-text"
                  : "border-sol-border bg-sol-bg-alt text-sol-base1 hover:border-sol-base1"
              }`}
            >
              <div className="text-sm font-medium">{opt.label}</div>
              <div className="text-xs mt-0.5 opacity-70">{opt.description}</div>
              <div className="text-[10px] font-mono mt-1 opacity-50">{opt.flag}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function AgentParams({
  name,
  agent,
  params,
  onUpdate,
}: {
  name: string;
  agent: "claude" | "codex" | "gemini" | "cursor";
  params?: Record<string, string>;
  onUpdate: (args: { agent: string; params: Record<string, string> }) => Promise<void>;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");

  const entries = Object.entries(params ?? {});

  const handleAdd = async () => {
    if (!newKey.trim() || !newValue.trim()) return;
    const key = newKey.replace(/^--/, "").trim();
    const updated = { ...(params ?? {}), [key]: newValue.trim() };
    await onUpdate({ agent, params: updated });
    setNewKey("");
    setNewValue("");
    toast.success(`Added --${key} ${newValue.trim()}`);
  };

  const handleDelete = async (key: string) => {
    const updated = { ...(params ?? {}) };
    delete updated[key];
    await onUpdate({ agent, params: updated });
    toast.success(`Removed --${key}`);
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-sol-text mb-2">{name}</h3>
      {entries.length > 0 ? (
        <div className="space-y-1 mb-2">
          {entries.map(([k, v]) => (
            <div key={k} className="flex items-center gap-2 text-sm font-mono">
              <span className="text-sol-base1">--{k}</span>
              <span className="text-sol-text">{v}</span>
              <button
                onClick={() => handleDelete(k)}
                className="text-sol-red hover:text-sol-red/80 text-xs ml-auto"
              >
                remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-sol-base1 mb-2">No default params</p>
      )}
      <div className="flex gap-2 items-center">
        <input
          type="text"
          placeholder="--flag"
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="bg-sol-bg-alt border border-sol-border rounded px-2 py-1 text-sm font-mono text-sol-text w-32"
        />
        <input
          type="text"
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="bg-sol-bg-alt border border-sol-border rounded px-2 py-1 text-sm font-mono text-sol-text w-40"
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          className="text-sm text-sol-cyan hover:text-sol-cyan/80"
        >
          add
        </button>
      </div>
    </div>
  );
}
