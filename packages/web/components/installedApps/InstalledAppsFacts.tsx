// The facts feed for installed apps (docs/architecture/installed-apps.md
// "Facts"): the desktop's main process has no sign-in, so the sync host
// window subscribes to api.artifacts.appInfo for every installed page and
// hands each answer to main with apps.facts. A republish reaches main within
// a second this way, with no polling. Mounted once, in HostFeeders; renders
// nothing, and nothing at all outside the desktop app.
import { memo } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import { useDesktopApps, useInstalledApps } from "../../hooks/useInstalledApps";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { factsArgs, type AppInfo, type DesktopAppsBridge, type GateKeys } from "../../lib/installedApps";

export function InstalledAppsFacts() {
  const apps = useDesktopApps();
  const installed = useInstalledApps();
  if (!apps || !installed) return null;
  return <>{installed.map((a) => <AppFacts key={a.slug} apps={apps} slug={a.slug} gate={a.gate} />)}</>;
}

const AppFacts = memo(function AppFacts({ apps, slug, gate }: { apps: DesktopAppsBridge; slug: string; gate: GateKeys | undefined }) {
  const info = useQueryNoThrow(api.artifacts.appInfo, factsArgs(slug, gate)).data;
  // A refusal (the page was deleted or locked) is not a fact about the app: main keeps the last good answer.
  const facts = info && !("error" in info) ? (info as AppInfo) : null;
  const sig = facts ? `${facts.version}|${facts.relation}|${facts.policy.install}|${facts.policy.fullAccess}|${facts.app.permissions.join(",")}|${facts.app.name}` : null;
  useWatchEffect(() => {
    if (facts) apps.facts(slug, facts);
  }, [sig]);
  return null;
});
