"use client";

// Settings › Approvals: the commands and edits your agents run without asking
// (permission_rules), kept by "Always allow" on a permission card. Grouped by
// project and workspace, the two things a rule is scoped to; Remove makes the
// next matching call ask again.
import { useMemo } from "react";
import { BadgeCheck, X } from "lucide-react";
import { useInboxStore } from "../../../store/inboxStore";
import { SettingsSection } from "../../../components/settings/ui";
import { usePermissionRules, type PermissionRuleRow } from "../../../hooks/usePermissionRules";
import { formatRelativeTime } from "../../../lib/conversationFormat";

/** `github.com/acme/app` reads as acme/app; a path as its last two parts. */
export function projectLabel(project: string): string {
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

  if (ready && rules.length === 0) {
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
          actions={<span className="rounded px-1.5 text-[11px] bg-sol-bg-alt text-sol-text-muted" data-approval-scope>{scopeLabel(g.scope)}</span>}
        >
          {g.rules.map((r) => <RuleRow key={r._id} rule={r} />)}
        </SettingsSection>
      ))}
    </div>
  );
}

function RuleRow({ rule }: { rule: PermissionRuleRow }) {
  const deny = rule.action === "deny";
  return (
    <div data-approval-rule className="group flex items-center gap-3 px-4 py-2">
      <span className={`shrink-0 rounded px-1.5 text-[11px] font-medium ${deny ? "bg-sol-red/12 text-sol-red" : "bg-sol-green/12 text-sol-green"}`}>
        {deny ? "Never" : "Allow"}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-sol-text" title={rule.label}>{rule.label}</span>
      <span className="shrink-0 text-[11px] text-sol-text-dim">{formatRelativeTime(rule.created_at)}</span>
      <button
        type="button"
        aria-label={`Remove ${rule.label}`}
        data-approval-remove
        onClick={() => useInboxStore.getState().removePermissionRule(rule._id)}
        className="shrink-0 rounded p-1 text-sol-text-dim hover:bg-sol-red/15 hover:text-sol-red transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
