// Settings > Privacy in hosted mode: the promise every door makes
// (assistantPrivacy), said again where a cautious person looks for it, with
// the full policy and the way to delete everything one press away. Developer
// mode keeps Sync & Privacy (which folders sync and who sees them) instead.
import { FileText, ShieldCheck, Trash2 } from "lucide-react";
import { SettingsLinkRow, SettingsPanel, SettingsSection } from "../../../components/settings/ui";
import { assistantPrivacy, useConnectAvailable } from "../../../components/simple/assistantPromise";
import { useInboxStore } from "../../../store/inboxStore";

export default function PrivacyPage() {
  const mail = useConnectAvailable().available === true;
  return (
    <SettingsPanel>
      <SettingsSection title="Your data" icon={ShieldCheck} description={assistantPrivacy(mail)}>
        <SettingsLinkRow
          icon={FileText}
          label="Read the privacy policy"
          description="What we keep, why, and for how long, in plain words."
          onClick={() => window.open("/privacy", "_blank", "noopener")}
        />
        <SettingsLinkRow
          icon={Trash2}
          label="Delete your account and data"
          description="Closes your account and deletes your conversations."
          onClick={() => useInboxStore.getState().openSettingsModal("accounts")}
        />
      </SettingsSection>
    </SettingsPanel>
  );
}
