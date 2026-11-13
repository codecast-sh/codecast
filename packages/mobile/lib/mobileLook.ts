// Which look this phone wears: Classic or Modern (constants/Theme.ts `Look`).
//
// The phone follows the web. `ui.modern_style` is the web's Modern switch; it
// is a per-device key (PER_DEVICE_UI_KEYS in packages/web/store/inboxStore.ts),
// so a device that never wrote it adopts whatever the server holds, which is
// the last choice made in a browser; with none, Modern (the default). A phone
// can still choose for itself:
// `ui.mobile_modern_style`, also per device, set from Settings › Appearance ›
// Style. Its own choice, when it has made one, wins.
//
// No React Native here, so the decision is tested directly (mobileLook.test.ts).
import type { Look } from '@/constants/Theme';
import { prefersModern } from '@codecast/web/lib/modernStyle';

export type LookPrefs = { modern_style?: unknown; visual_style?: unknown; mobile_modern_style?: unknown } | null | undefined;

export function resolveMobileLook(ui: LookPrefs): Look {
  const own = ui?.mobile_modern_style;
  if (own === true || own === false) return own ? 'modern' : 'classic';
  return prefersModern(ui) ? 'modern' : 'classic';
}

/** Whether the phone's look comes from its own choice or follows the web. */
export function mobileLookSource(ui: LookPrefs): 'phone' | 'web' {
  const own = ui?.mobile_modern_style;
  return own === true || own === false ? 'phone' : 'web';
}
