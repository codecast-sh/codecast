"use client";

// Whether the person's own sessions may read every direct message they are in
// (users.sessions_read_dms; chatAccess sessionChatScope applies it). Turning
// it on grants a capability, so it goes through the confirm flow; off is one
// press. Shown on the Agents settings page and beside the Slack DM switch.
import { useCurrentUser } from "../../hooks/useCurrentUser";
import { useInboxStore } from "../../store/inboxStore";
import { ConsequentialSwitch } from "../consequential/ConsequentialSwitch";
import { sessionDmAccessLedger } from "../consequential/ledgers";
import { Switch } from "../ui/switch";

function useSessionDmAccess(): [boolean, (on: boolean) => void] {
  const { user } = useCurrentUser();
  const update = useInboxStore((s) => s.updateNotificationSettings);
  return [!!(user as any)?.sessions_read_dms, (on) => update({ sessions_read_dms: on })];
}

export function SessionDmAccessSwitch() {
  const [on, set] = useSessionDmAccess();
  return (
    <ConsequentialSwitch
      on={on}
      ledger={sessionDmAccessLedger()}
      onTurnOn={() => set(true)}
      onTurnOff={() => set(false)}
      trigger={({ on: isOn, press }) => (
        <Switch checked={isOn} onCheckedChange={press} aria-label="Sessions read your DMs" />
      )}
    />
  );
}
