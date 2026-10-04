// A trigger's prompt and schedule can change only while it waits to run: the
// server's applyTaskUpdate refuses a running or finished one.
export function isTriggerEditable(status: string | undefined): boolean {
  return status === "scheduled" || status === "paused";
}
