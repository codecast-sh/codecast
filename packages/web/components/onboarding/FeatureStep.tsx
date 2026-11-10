"use client";
// The setup flow's Features step: every major feature as a card that says
// what it gives the team, with its switch, and a count of how many are on.
// The step's footer (SetupFlow, the team setup page) carries the press that
// turns them all on. Tasks have no switch because they are always on; their
// card connects the issue tracker the team already uses, so Linear or GitHub
// issues arrive as tasks. Flipping a switch is the same store action the team
// settings use.
import { Check, CheckSquare, MessageSquare, Network, Phone, Rocket, Waypoints, type LucideIcon } from "lucide-react";
import { APP_DESCRIPTORS, teamFeatureEnabled, type AppConnectionsResult, type TeamFeatureKey } from "@codecast/shared/contracts";
import type { CSSProperties, ReactNode } from "react";
import { Switch } from "../ui/switch";
import { useInboxStore } from "../../store/inboxStore";
import { useSettingsData } from "../../hooks/useSyncSettings";
import { SETUP_FEATURES, useSetupFeatures } from "../../hooks/useSetupFeatures";
import { useAppConnection } from "../../lib/integrations";
import { cn } from "../../lib/utils";

type CardLook = { icon: LucideIcon; color: string; pitch: string };

const LOOK: Partial<Record<TeamFeatureKey | "tasks", CardLook>> = {
  chat: { icon: MessageSquare, color: "blue", pitch: "Channels and DMs for people and agents. Agents post updates and answer when mentioned." },
  tasks: { icon: CheckSquare, color: "yellow", pitch: "One board for people and agents. Agents claim tasks and report progress as they go." },
  calls: { icon: Phone, color: "green", pitch: "Huddle from any channel or session. Every call is transcribed and summarized with its action items." },
  org: { icon: Network, color: "violet", pitch: "Agent roles that each own an area of your work and bring you only the decisions that need you." },
  line: { icon: Waypoints, color: "cyan", pitch: "Every change runs check, review, decide and ship where the team sees it. You approve on one card." },
  ship: { icon: Rocket, color: "magenta", pitch: "One press commits, opens the pull request and watches it through review to merge." },
};

export function FeatureStep({ teamId }: { teamId: string | null }) {
  const { team, onCount, total, allOn, turnAllOn } = useSetupFeatures(teamId);
  const [first, ...rest] = SETUP_FEATURES;
  const editable = !!teamId;
  const card = (f: (typeof SETUP_FEATURES)[number]) => (
    <FeatureCard key={f.key} feature={f.key} name={f.name} on={teamFeatureEnabled(team, f.key)} teamId={editable ? teamId : null} />
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="ob-meter flex-1" aria-hidden>
          <span style={{ width: `${(onCount / total) * 100}%` }} />
        </div>
        <span className="text-sm tabular-nums text-sol-text" data-features-on={onCount}>
          {onCount} of {total} on
        </span>
        {!allOn && editable && (
          <button type="button" onClick={turnAllOn} className="ob-all-on h-7 rounded-md px-2.5 text-xs font-medium">
            Turn all on
          </button>
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2" aria-label="Team features">
        {first && card(first)}
        <TasksCard teamReady={!!teamId} />
        {rest.map(card)}
      </ul>
    </div>
  );
}

function CardShell({ look, name, on, onToggle, control, children }: {
  look: CardLook;
  name: string;
  on: boolean;
  onToggle?: () => void;
  control: ReactNode;
  children?: ReactNode;
}) {
  const Icon = look.icon;
  return (
    <li
      data-on={on || undefined}
      data-feature-card={name}
      style={{ "--ob-f": `var(--sol-${look.color})` } as CSSProperties}
      onClick={(e) => {
        // The card is one big target; its own buttons and switch handle themselves.
        if (onToggle && !(e.target as HTMLElement).closest("button, a, input, label")) onToggle();
      }}
      className={cn("ob-card flex flex-col rounded-xl border p-4", onToggle && "cursor-pointer")}
    >
      <div className="flex items-center gap-3">
        <span className="ob-card-icon flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold text-sol-text">{name}</span>
        {control}
      </div>
      <p className="mt-2.5 text-[13px] leading-relaxed text-sol-text-muted">{look.pitch}</p>
      {children}
    </li>
  );
}

function FeatureCard({ feature, name, on, teamId }: { feature: TeamFeatureKey; name: string; on: boolean; teamId: string | null }) {
  const look = LOOK[feature] ?? { icon: Check, color: "cyan", pitch: "" };
  const set = (v: boolean) => teamId && useInboxStore.getState().setTeamFeature(teamId, feature, v);
  return (
    <CardShell
      look={look}
      name={name}
      on={on}
      onToggle={teamId ? () => set(!on) : undefined}
      control={<Switch checked={on} disabled={!teamId} onCheckedChange={set} aria-label={name} className="ob-card-switch" />}
    />
  );
}

/** Tasks are always on. The card's job is bringing the team's issues in. */
function TasksCard({ teamReady }: { teamReady: boolean }) {
  const connections = useSettingsData("connections").data as AppConnectionsResult | undefined;
  const status = (id: "linear" | "github") => connections?.apps.find((a) => a.id === id && a.status !== "coming_soon" && a.scope === "team");
  return (
    <CardShell
      look={LOOK.tasks!}
      name="Tasks"
      on
      control={<span className="ob-card-always text-[11px] font-medium">Always on</span>}
    >
      <div className="mt-3 flex items-center gap-1.5">
        <span className="mr-0.5 text-xs text-sol-text-dim">Import from</span>
        <ConnectChip app="linear" connection={status("linear")} disabled={!teamReady} />
        <ConnectChip app="github" connection={status("github")} disabled={!teamReady} />
      </div>
    </CardShell>
  );
}

function ConnectChip({ app, connection, disabled }: { app: "linear" | "github"; connection: AppConnectionsResult["apps"][number] | undefined; disabled: boolean }) {
  const descriptor = APP_DESCRIPTORS[app];
  const { connect, busy, error } = useAppConnection(descriptor, connection, "team");
  if (connection?.status === "connected") {
    return (
      <span className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-sol-green" data-connected={app}>
        <Check className="h-3.5 w-3.5" />
        {descriptor.name}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={connect}
      disabled={disabled || busy}
      title={error ?? `Import ${descriptor.name} issues as tasks`}
      className={cn(
        "tf-ghost inline-flex h-7 items-center whitespace-nowrap rounded-md border px-2 text-xs transition-colors disabled:opacity-50",
        error ? "border-sol-red/50 text-sol-red" : "border-sol-border text-sol-text-muted hover:border-sol-text-muted hover:text-sol-text",
      )}
    >
      {busy ? "Opening…" : descriptor.name}
    </button>
  );
}
