"use client";

// Which of a team's Slack workspaces a Slack surface is reading. A team with
// one workspace sees its name; a team with several picks one.

type Installation = { workspace_id: string; workspace_name: string | null };

export function SlackWorkspacePicker({
  installations,
  current,
  onPick,
  disabled,
  fallback,
}: {
  installations: Installation[];
  current: string | null;
  onPick: (workspaceId: string) => void;
  disabled?: boolean;
  fallback: string;
}) {
  if (installations.length < 2) return <>{fallback}</>;
  return (
    <span className="ch-slack-seg" role="radiogroup" aria-label="Slack workspace">
      {installations.map((i) => (
        <button
          key={i.workspace_id}
          type="button"
          role="radio"
          aria-checked={current === i.workspace_id}
          className={`ch-slack-seg-item ${current === i.workspace_id ? "ch-slack-seg-on" : ""}`}
          onClick={() => onPick(i.workspace_id)}
          disabled={disabled}
        >
          {i.workspace_name ?? i.workspace_id}
        </button>
      ))}
    </span>
  );
}
