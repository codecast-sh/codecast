// The Resume press on a stopped run (lib/ship/resumeAt.ts), on the web and the phone alike: it asks the server to
// resume the run at its station (convex failedRunResume.resume, the run's owner only). It reads pending until the run
// moves on, which takes the stop and this press with it, and says the server's refusal in its own words.
import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@codecast/convex/convex/_generated/api";
import type { Id } from "@codecast/convex/convex/_generated/dataModel";
import { resumeRefusal } from "../lib/ship/resumeAt";

export type ResumeState = { kind: "idle" } | { kind: "pending" } | { kind: "refused"; why: string };

export function useResumeAt(runId: string | null | undefined, at: string | null | undefined): { state: ResumeState; press: () => Promise<void> } {
  const resume = useMutation(api.failedRunResume.resume);
  const [state, setState] = useState<ResumeState>({ kind: "idle" });
  const press = async () => {
    if (!runId || !at || state.kind === "pending") return;
    setState({ kind: "pending" });
    try {
      await resume({ run_id: runId as Id<"workflow_runs">, at });
    } catch (e) {
      setState({ kind: "refused", why: resumeRefusal(e) });
    }
  };
  return { state, press };
}
