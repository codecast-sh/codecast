"use client";

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
