import { useState } from "react";
import { Chrome, ExternalLink, Monitor, Smartphone } from "lucide-react";
import { useMountEffect } from "../../../hooks/useMountEffect";
import { isDesktop, getAppVersion, checkDesktopUpdate } from "../../../lib/desktop";
import {
  NATIVE_APP_COPY,
  NATIVE_APP_LINKS,
  nativeAppOffer,
  trackNativeAppClick,
  type NativeApp,
} from "../../../lib/nativeApps";
import { useInboxStore } from "../../../store/inboxStore";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { SettingsLinkRow, SettingsPanel, SettingsRow, SettingsSection } from "../../../components/settings/ui";

/**
 * Settings > Apps: every way to run codecast beyond this browser tab. The app
 * that fits the device you are on comes first (lib/nativeApps), and inside the
 * desktop app the Mac card turns into a version readout.
 */
export default function AppsPage() {
  const fits = nativeAppOffer() ?? (isDesktop() ? "mac" : null);
  const order: NativeApp[] = fits === "ios" ? ["ios", "mac"] : ["mac", "ios"];
  return (
    <SettingsPanel>
      {order.map((app) => (app === "mac" ? <MacSection key={app} /> : <IosSection key={app} />))}
      <ChromeSection />
    </SettingsPanel>
  );
}

function GetAppButton({ app }: { app: NativeApp }) {
  return (
    <Button variant="cyan" size="sm" asChild>
      <a
        href={NATIVE_APP_LINKS[app]}
        target={app === "ios" ? "_blank" : undefined}
        rel={app === "ios" ? "noopener noreferrer" : undefined}
        onClick={() => trackNativeAppClick(app, "settings_apps")}
      >
        {NATIVE_APP_COPY[app].cta}
        {app === "ios" && <ExternalLink className="ml-1.5 h-3 w-3" />}
      </a>
    </Button>
  );
}

/** The Mac card: a download outside the app, a version readout inside it, and
 *  the link-handoff opt-in for anyone who has run the desktop app. The "Update
 *  now" action lives in the global banner (DesktopProvider); this is passive. */
function MacSection() {
  const [current, setCurrent] = useState<string | null>(null);
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null);
  const hasUsedDesktop = useInboxStore((s) => s.clientState?.dismissed?.has_used_desktop === true);
  const preferBrowser = useInboxStore((s) => s.clientState?.dismissed?.prefer_browser_links === true);
  const updateDismissed = useInboxStore((s) => s.updateClientDismissed);
  const openSettingsModal = useInboxStore((s) => s.openSettingsModal);

  useMountEffect(() => {
    if (!isDesktop()) return;
    getAppVersion().then(setCurrent);
    checkDesktopUpdate().then(setUpdate);
  });

  const inDesktop = isDesktop();
  const copy = NATIVE_APP_COPY.mac;

  return (
    <SettingsSection title="Desktop app" icon={Monitor} description={copy.pitch}>
      {inDesktop ? (
        <SettingsRow
          label="You're on the desktop app"
          description={
            !current ? "Reading the version"
              : update ? `Version ${current}, v${update.latest} available`
              : `Version ${current}, up to date`
          }
        >
          {update && (
            <span className="rounded-md bg-sol-cyan/15 px-2 py-0.5 text-[11px] text-sol-cyan">Update available</span>
          )}
        </SettingsRow>
      ) : (
        <SettingsRow label={copy.name} description={copy.requires}>
          <GetAppButton app="mac" />
        </SettingsRow>
      )}
      {inDesktop && (
        <SettingsLinkRow
          label="Shortcuts, meeting detection and permissions"
          description="What the desktop app can do that a browser tab cannot"
          onClick={() => openSettingsModal("desktop")}
        />
      )}
      {/* Inverse of the sticky "Always open Codecast links in browser" opt-out
          from OpenInDesktopHandoff: the only place to turn the handoff back on. */}
      {hasUsedDesktop && (
        <SettingsRow
          label="Open links in desktop app"
          description="Hand off codecast.sh pages from the browser to the desktop app"
        >
          <Switch
            checked={!preferBrowser}
            onCheckedChange={(v) => updateDismissed("prefer_browser_links", !v)}
            aria-label="Open links in desktop app"
          />
        </SettingsRow>
      )}
    </SettingsSection>
  );
}

function IosSection() {
  const openSettingsModal = useInboxStore((s) => s.openSettingsModal);
  const copy = NATIVE_APP_COPY.ios;
  return (
    <SettingsSection title="iPhone and iPad" icon={Smartphone} description={copy.pitch}>
      <SettingsRow label={copy.name} description={copy.requires}>
        <GetAppButton app="ios" />
      </SettingsRow>
      <SettingsLinkRow
        label="What reaches your phone"
        description="Pushes for mentions, blocked sessions and calls are set in Notifications"
        onClick={() => openSettingsModal("notifications")}
      />
    </SettingsSection>
  );
}

function ChromeSection() {
  const openSettingsModal = useInboxStore((s) => s.openSettingsModal);
  return (
    <SettingsSection title="Chrome extension" icon={Chrome}>
      <SettingsLinkRow
        label="Let agents use your Chrome"
        description="Agents open their own tabs in your browser, signed in as you. Install and pair it under Integrations"
        onClick={() => openSettingsModal("integrations")}
      />
    </SettingsSection>
  );
}
