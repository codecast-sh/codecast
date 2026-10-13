import { GraduationCap } from "lucide-react";
import { LEARNING_OPT_IN_LABEL, LEARNING_OPT_IN_SENTENCE } from "@codecast/shared/contracts/orgTemplateLearning";
import { useLearningSwitch } from "../../hooks/useLearningSwitch";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./ui";

/** The team's choice to let Codecast learn from its template roles (org-hire.md H12), where every other team-wide choice lives. */
export function TeamTemplateLearning({ teamId }: { teamId: string }) {
  const { learning, ready, enabled, may, busy, error, flip } = useLearningSwitch(teamId);
  return (
    <SettingsSection title="Role templates" icon={GraduationCap} description={ready && !may ? "Only team admins can change this." : undefined}>
      <SettingsRow
        label={LEARNING_OPT_IN_LABEL}
        description={
          <>
            {LEARNING_OPT_IN_SENTENCE}
            {learning?.changed_by && <span className="block text-sol-text-dim">{enabled ? "On" : "Off"}, set by {learning.changed_by}</span>}
            {error && <span role="alert" className="block text-sol-red">{error}</span>}
          </>
        }
      >
        <Switch checked={enabled} disabled={!ready || !may || busy} onCheckedChange={(v) => void flip(v)} aria-label={LEARNING_OPT_IN_LABEL} data-team-template-learning={ready ? String(enabled) : "loading"} />
      </SettingsRow>
    </SettingsSection>
  );
}
