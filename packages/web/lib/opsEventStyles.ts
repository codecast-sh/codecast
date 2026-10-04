import { Activity, AlertOctagon, Bug, CircleCheck, Flame, Gauge, HeartPulse, RotateCcw, ShieldAlert, Workflow } from "lucide-react";
import { registerExternalEventStyles, type ExternalEventStyle } from "./externalEvents";

// Feed styles for a product's transitions (docs/architecture/external-data.md
// X3, X10). The kinds are the trigger names a transition fires
// (contracts/ingest transitionTriggerEvent), or the bare transition when it
// fires none. Red is reserved for what needs a person; a recovery is green.
// `deploy` keeps the git table's style, so a product's deploy and `cast ship
// mark` read as the same moment. Imported once from App.tsx.
export const OPS_EVENT_STYLES: Record<string, ExternalEventStyle> = {
  error_new: { icon: Bug, accent: "red", verb: "new error" },
  error_regressed: { icon: RotateCcw, accent: "red", verb: "regressed" },
  error_spike: { icon: Flame, accent: "orange", verb: "spiked" },
  job_failed: { icon: Workflow, accent: "red", verb: "job failed" },
  check_failed: { icon: ShieldAlert, accent: "red", verb: "check failed" },
  check_recovered: { icon: HeartPulse, accent: "green", verb: "check recovered" },
  metric_alert: { icon: Gauge, accent: "orange", verb: "crossed its line" },
  metric_recovered: { icon: Gauge, accent: "green", verb: "back inside its line" },
  resolved: { icon: CircleCheck, accent: "violet", verb: "resolved" },
  new: { icon: AlertOctagon, accent: "yellow", verb: "new" },
  regressed: { icon: RotateCcw, accent: "yellow", verb: "regressed" },
  spike: { icon: Activity, accent: "orange", verb: "spiked" },
};

registerExternalEventStyles(OPS_EVENT_STYLES);
