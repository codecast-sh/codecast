"use client";
// The Line app's old Deploys address (`view=deploys`): deploys have one home,
// the Deploys page, which opens at the named deploy on its own team. The
// address is replaced, so Back skips this hop.
import { useRouter } from "next/navigation";
import { useWatchEffect } from "../../../../../hooks/useWatchEffect";
import { entityRoute } from "@codecast/shared/entities";
import type { LineViewProps } from "../types";

export function DeploysMoved({ selection }: LineViewProps) {
  const router = useRouter();
  const to = (selection.deploy ? entityRoute("deploy", selection.deploy) : null) ?? "/deploys";
  useWatchEffect(() => { router.replace(to); }, [to]);
  return null;
}
