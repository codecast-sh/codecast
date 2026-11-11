"use client";

// Settings › Approvals: the commands and edits your agents run without asking
// (permission_rules), kept by "Always allow" on a permission card. Grouped by
// project and workspace, the two things a rule is scoped to; Remove makes the
// next matching call ask again.
import { useMemo, useState } from "react";
import { permissionRuleLabel } from "@codecast/shared/contracts/permissionRules";
import { BadgeCheck, X } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { SettingsBadge, SettingsSection } from "../../../components/settings/ui";
import { usePermissionRules, type PermissionRuleRow } from "../../../hooks/usePermissionRules";
import { formatRelativeTime } from "../../../lib/conversationFormat";
import { modernButton, modernPill } from "../../../components/ui/modernLook";

/** `github.com/acme/app` reads as acme/app; a path as its last two parts. */
function projectLabel(project: string): string {
  if (!project) return "No project";
  const parts = project.split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

function useScopeLabel(): (scope: string) => string {
  const teams = useInboxStore((s) => s.teams) as Array<{ _id: string; name?: string }> | undefined;
  return useMemo(() => {
    const names = new Map((teams ?? []).map((t) => [`team:${t._id}`, t.name ?? "Team"]));
    return (scope: string) => (scope.startsWith("user:") ? "Personal" : names.get(scope) ?? "Team");
  }, [teams]);
}

export default function ApprovalsPage() {
  const { rules, ready } = usePermissionRules();
  const scopeLabel = useScopeLabel();
  const groups = useMemo(() => {
    const byKey = new Map<string, { project: string; scope: string; rules: PermissionRuleRow[] }>();
    for (const r of rules) {
      const key = `${r.project}\u0000${r.scope}`;
      const g = byKey.get(key) ?? { project: r.project, scope: r.scope, rules: [] };
      g.rules.push(r);
      byKey.set(key, g);
    }
    return [...byKey.values()].sort((a, b) => projectLabel(a.project).localeCompare(projectLabel(b.project)));
  }, [rules]);

  if (!ready && rules.length === 0) {
    return (
      <SettingsSection title="Approvals" icon={BadgeCheck}>
        {[0, 1, 2].map((i) => <div key={i} className="mx-4 my-3 h-4 animate-pulse rounded bg-sol-bg-alt" />)}
      </SettingsSection>
    );
  }
  if (rules.length === 0) {
    return (
      <SettingsSection title="Approvals" icon={BadgeCheck} padded>
        <p data-approvals-empty className="text-sm text-sol-text-muted">None saved. <span className="text-sol-green">Always allow</span> on a permission card keeps one here.</p>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6" data-approvals>
      {groups.map((g) => (
        <SettingsSection
          key={`${g.project}|${g.scope}`}
          title={projectLabel(g.project)}
          icon={BadgeCheck}
          actions={<span className="rounded px-1.5 text-meta bg-sol-bg-alt text-sol-text-muted" data-approval-scope>{scopeLabel(g.scope)}</span>}
        >
          {g.rules.map((r) => <RuleRow key={r._id} rule={r} />)}
          <NeverRow project={g.project} scope={g.scope} />
        </SettingsSection>
      ))}
    </div>
  );
}

function RuleRow({ rule }: { rule: PermissionRuleRow }) {
  const deny = rule.action === "deny";
  return (
    <div data-approval-rule className="group flex items-center gap-3 px-4 py-2">
      <SettingsBadge tone={deny ? "red" : "green"} className="py-0 text-meta font-medium">
        {deny ? "Never" : "Allow"}
      </SettingsBadge>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-sol-text" title={rule.label}>{rule.label}</span>
      <span className="shrink-0 text-meta text-sol-text-dim">{formatRelativeTime(rule.created_at)}</span>
      <button
        type="button"
        aria-label={`Remove ${rule.label}`}
        data-approval-remove
        onClick={() => useInboxStore.getState().removePermissionRule(rule._id, rule)}
        className="shrink-0 rounded p-1 text-sol-text-dim hover:bg-sol-red/15 hover:text-sol-red transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/** A command this project's sessions may never run: a deny wins over every allow. */
function NeverRow({ project, scope }: { project: string; scope: string }) {
  const [pattern, setPattern] = useState("");
  const add = () => {
    const p = pattern.trim();
    if (!p) return;
    useInboxStore.getState().addPermissionRule({ project, scope, permission: "bash", pattern: p, action: "deny", label: permissionRuleLabel({ permission: "bash", pattern: p }) });
    setPattern("");
  };
  return (
    <form data-approval-never className="flex items-center gap-3 px-4 py-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <span className={`shrink-0 rounded px-1.5 text-meta font-medium bg-sol-red/12 text-sol-red ${modernPill({ tone: "red" })}`}>Never</span>
      <input
        value={pattern}
        onChange={(e) => setPattern(e.target.value)}
        placeholder="git push *"
        aria-label="Command this project's agents may never run"
        className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-sol-text placeholder:text-sol-text-dim/60 outline-none modern:text-ui"
      />
      <button type="submit" disabled={!pattern.trim()} className={`shrink-0 rounded border border-sol-border px-2 py-0.5 text-meta text-sol-text-muted hover:text-sol-text disabled:opacity-40 ${modernButton({ variant: "outline", size: "xs" })}`}>Add</button>
    </form>
  );
}
