// Settings > Installed apps: every published page installed as an app on this
// computer (docs/architecture/installed-apps.md). One row per app: its icon,
// name and version, where it stands (up to date, a new version to review, not
// running), a switch per permission, Open and Uninstall. The list is the
// desktop's own registry; the page facts that decide whether full access can
// be had come from api.artifacts.appInfo.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { AppWindow, Copy, ExternalLink, MoreHorizontal } from "lucide-react";
import type { AppPermission } from "@codecast/shared/contracts/pageApp";
import { pageShareUrl } from "@codecast/shared/entities";
import { api } from "@codecast/convex/convex/_generated/api";
import { SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { Button } from "../../../components/ui/button";
import { ConfirmButton } from "../../../components/integrations/parts";
import { SwitchReview } from "../../../components/consequential/ConsequentialSwitch";
import { AppIcon } from "../../../components/installedApps/AppIcon";
import { PermissionToggles } from "../../../components/installedApps/PermissionToggles";
import { ConsentSheet } from "../../../components/installedApps/ConsentSheet";
import { DESKTOP_DOWNLOADS } from "../../../lib/nativeApps";
import { useDesktopApps, useInstalledApps } from "../../../hooks/useInstalledApps";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { useInboxStore } from "../../../store/inboxStore";
import {
  INSTALLED_APP_STATE_LABEL,
  INSTALL_AS_APP,
  factsArgs,
  flipGrant,
  fullAccessLedger,
  grantRows,
  heldGrants,
  installedAppState,
  pageAddress,
  reviewRequest,
  type AppInfo,
  type DesktopAppsBridge,
  type InstalledApp,
  type InstalledAppState,
} from "../../../lib/installedApps";

const STATE_TONE: Record<InstalledAppState, string> = {
  review: "bg-sol-orange/15 text-sol-orange",
  stopped: "bg-sol-bg-alt text-sol-text-dim",
  current: "bg-sol-green/12 text-sol-green",
};

export default function InstalledAppsPage() {
  const apps = useDesktopApps();
  const installed = useInstalledApps();
  if (!apps) return <SettingsPanel><BrowserSection /></SettingsPanel>;
  const count = installed?.length ?? 0;
  const reviews = installed?.filter((a) => a.needsReview).length ?? 0;
  return (
    <SettingsPanel>
      <SettingsSection
        title="Installed apps"
        icon={AppWindow}
        actions={installed && count > 0 ? (
          <span className="text-xs tabular-nums text-sol-text-muted" data-installed-count>
            {count} app{count === 1 ? "" : "s"}{reviews > 0 && <span className="text-sol-orange"> · {reviews} to review</span>}
          </span>
        ) : undefined}
      >
        {installed === null ? null : count === 0 ? <EmptyState /> : (
          <ul className="divide-y divide-sol-border/60" data-installed-apps>
            {installed.map((a) => <AppRow key={a.slug} app={a} bridge={apps} />)}
          </ul>
        )}
      </SettingsSection>
    </SettingsPanel>
  );
}

function AppRow({ app: a, bridge }: { app: InstalledApp; bridge: DesktopAppsBridge }) {
  const q = useQueryNoThrow(api.artifacts.appInfo, factsArgs(a.slug, a.gate));
  const res = q.data;
  const info = res && !("error" in res) ? (res as AppInfo) : null;
  // The page refused (deleted, locked) or the query failed: the facts will not come.
  const unavailable = !!q.error || (!!res && "error" in res);
  const state = installedAppState(a);
  const [askFull, setAskFull] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (grants: AppPermission[]) => void bridge.setGrants(a.slug, grants);
  // Any write approves the current version, so it starts from what the row holds, never from an earlier version's full access.
  const held = heldGrants(a);
  const flip = (perm: AppPermission, on: boolean) => {
    if (perm === "full-access" && on) return setAskFull(true);
    set(flipGrant(held, perm, on));
  };
  // Without the page's facts there is nothing new to show, so approving keeps only what the row holds.
  const approve = () => (info ? setReviewing(true) : set(held));
  const address = pageAddress(pageShareUrl(a.slug));
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 sm:px-5" data-installed-app={a.slug} data-installed-state={state}>
      <div className="flex items-center gap-3">
        <AppIcon src={a.iconUrl} name={a.name} size={40} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-sol-text">{a.name}</span>
          <span className="flex min-w-0 items-center gap-2 text-meta">
            <span className="tabular-nums text-sol-text-dim">v{a.version}</span>
            <span className={`rounded-sm px-1.5 py-px font-medium ${STATE_TONE[state]}`} data-installed-state-label>{INSTALLED_APP_STATE_LABEL[state]}</span>
            {state === "review" && <span className="tabular-nums text-sol-text-dim">granted for v{a.grantedVersion}</span>}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {state === "review" ? (
            <Button size="sm" variant="orange" onClick={approve} data-installed-approve>Approve v{a.version}</Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void bridge.open(a.slug)} data-installed-open>Open</Button>
        </div>
      </div>
      <div className="pl-[52px]">
        {(a.requested.length > 0 || a.grants.length > 0) ? (
          <PermissionToggles rows={grantRows(a, unavailable ? "unavailable" : info)} platform={a.platform} onFlip={flip} dense idPrefix={`installed-${a.slug}`} />
        ) : (
          <span className="block py-1 text-meta text-sol-text-dim">No permissions</span>
        )}
        <div className="mt-1.5 flex items-center justify-between gap-3">
          <span className="truncate text-meta text-sol-text-dim" title={address}>{address}</span>
          <ConfirmButton
            label="Uninstall"
            confirmLabel="Uninstall"
            question={`Remove ${a.name} and its data?`}
            busy={busy}
            busyLabel="Removing"
            onConfirm={() => { setBusy(true); void bridge.uninstall(a.slug).finally(() => setBusy(false)); }}
          />
        </div>
      </div>
      {askFull && (
        <SwitchReview
          ledger={fullAccessLedger(a.name, address)}
          onClose={() => setAskFull(false)}
          onConfirm={() => { setAskFull(false); set(flipGrant(held, "full-access", true)); }}
        />
      )}
      {reviewing && info && (
        <ConsentSheet
          req={reviewRequest(a, info)}
          fill={false}
          onAnswer={(ok, grants) => { setReviewing(false); if (ok) set(grants); }}
        />
      )}
    </li>
  );
}

/** No apps yet: where installing starts, drawn as the menu entry itself, and the way to the pages. */
function EmptyState() {
  const router = useRouter();
  const goPages = () => {
    useInboxStore.getState().closeSettingsModal();
    router.push("/pages");
  };
  return (
    <div className="flex flex-col items-center gap-4 px-5 py-8" data-installed-empty>
      <div aria-hidden className="w-52 rounded-lg border border-sol-border bg-sol-bg p-1 text-[12.5px] shadow-sm">
        <div className="flex items-center justify-between px-2 pb-1 pt-0.5 text-meta text-sol-text-dim">
          <span>Page</span><MoreHorizontal className="h-3.5 w-3.5" />
        </div>
        <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sol-text-muted"><ExternalLink className="h-3.5 w-3.5" />Open</div>
        <div className="flex items-center gap-2 rounded px-2 py-1.5 text-sol-text-muted"><Copy className="h-3.5 w-3.5" />Copy link</div>
        <div className="flex items-center gap-2 rounded bg-sol-blue/15 px-2 py-1.5 font-medium text-sol-text ring-1 ring-inset ring-sol-blue/40"><AppWindow className="h-3.5 w-3.5 text-sol-blue" />{INSTALL_AS_APP}</div>
      </div>
      <div className="flex flex-col items-center gap-1">
        <span className="text-sm font-medium text-sol-text">No apps installed</span>
        <span className="text-meta text-sol-text-muted">Any page, from its menu</span>
      </div>
      <Button size="sm" variant="outline" onClick={goPages} data-installed-go-pages>Go to Pages</Button>
    </div>
  );
}

/** In a browser: installed apps live in the desktop app. */
function BrowserSection() {
  return (
    <SettingsSection title="Installed apps" icon={AppWindow}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5" data-installed-browser>
        <div className="flex flex-col gap-0.5">
          <span className="text-sm text-sol-text">Pages as apps on your computer</span>
          <span className="text-meta text-sol-text-muted">In Codecast for desktop</span>
        </div>
        <div className="flex items-center gap-2">
          {DESKTOP_DOWNLOADS.map((d) => (
            <Button key={d.os} size="sm" variant="outline" asChild>
              <a href={d.href} data-download={d.os}>{d.label}</a>
            </Button>
          ))}
        </div>
      </div>
    </SettingsSection>
  );
}
