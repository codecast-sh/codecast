import { useState } from "react";
import { captureException } from "@sentry/react";
import { useTemplateActions, useTemplateLearning } from "./useTemplateHire";

/** The learning opt-in as one switch, shared by team settings, the hire gallery and the role page: its state, who may flip it, and the flip. */
export function useLearningSwitch(teamId: string | undefined, canEdit = true) {
  const { learning, ready } = useTemplateLearning(teamId);
  const { setLearning } = useTemplateActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const enabled = !!learning?.enabled;
  const may = canEdit && !!learning?.can_change;
  const flip = async (next = !enabled) => {
    if (!may || busy || next === enabled) return;
    setBusy(true); setError(null);
    try { await setLearning(teamId, next); } catch (e) { captureException(e); setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return { learning, ready, enabled, may, busy, error, flip };
}
