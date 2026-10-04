// The phone's half of a machine's Claude sign-in: ask the machine to run
// `claude auth login` without opening its own browser, then finish on the
// phone through the code-paste page it reports (cc_login_flow.url), sending
// the code that page shows back to the waiting CLI.
import { useMutation } from 'convex/react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useSettingsData } from '@codecast/web/hooks/useSyncSettings';
import { LOGIN_FLOW_STALE_MS } from '@codecast/convex/convex/ccAccountsShared';

export type AccountDevice = NonNullable<ReturnType<typeof useSettingsData<'accountProfiles'>>['data']>['devices'][number];
export type LoginFlow = NonNullable<AccountDevice['login_flow']>;

/** Every machine reporting accounts, live machines first. */
export function useAccountDevices(): { devices: AccountDevice[]; loaded: boolean } {
  const { data } = useSettingsData('accountProfiles');
  const devices = [...(data?.devices ?? [])].sort((a, b) => Number(b.online) - Number(a.online));
  return { devices, loaded: data !== undefined };
}

export type FlowPhase = 'idle' | 'starting' | 'open' | 'confirmed' | 'rejected';

/** Where a machine's sign-in stands, for one profile (or the machine login when `profile` is undefined). */
export function loginFlowPhase(flow: LoginFlow | null | undefined, now: number, profile?: string): FlowPhase {
  if (!flow || (flow.profile ?? undefined) !== profile) return 'idle';
  if (flow.status === 'pending') {
    if (now - flow.started_at >= LOGIN_FLOW_STALE_MS) return 'idle';
    return flow.url ? 'open' : 'starting';
  }
  const age = now - (flow.finished_at ?? 0);
  if (flow.status === 'confirmed' && age < 3 * 60_000) return 'confirmed';
  if (flow.status === 'rejected' && age < 10 * 60_000) return 'rejected';
  return 'idle';
}

export function useClaudeSignIn() {
  const request = useMutation(api.accountSwitch.requestLoginFlow);
  const submit = useMutation(api.accountSwitch.submitLoginCode);
  return {
    start: (deviceId: string, profile?: string, force = false) =>
      request({ device_id: deviceId, open_browser: false, ...(profile ? { profile } : {}), ...(force ? { force: true } : {}) }),
    sendCode: (deviceId: string, startedAt: number, code: string) =>
      submit({ device_id: deviceId, started_at: startedAt, code }),
  };
}
