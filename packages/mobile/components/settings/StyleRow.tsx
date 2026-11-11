// Settings › Appearance › Style: Classic or Modern on this phone.
//
// Unset, the phone wears whatever the web's Modern switch says
// (lib/mobileLook.ts). Picking Classic or Modern here is this phone's own
// choice, kept per device; "Same as web" clears it again.
import { useCallback } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { showActionSheet } from '@/lib/popups';
import { mobileLookSource, resolveMobileLook } from '@/lib/mobileLook';
import { NavRow } from './SettingsUI';

/** Hidden until Modern sets code-like text in mono again (the Modern-on-mobile
 *  plan's Wave 2): until then Modern sets paths and commands in sans. The
 *  look follows the web's switch without this row. */
export const STYLE_ROW_SHOWN = false;

const CHOICES = [
  { key: 'web', label: 'Same as web', value: null },
  { key: 'classic', label: 'Classic', value: false },
  { key: 'modern', label: 'Modern', value: true },
] as const;

export function StyleRow() {
  const own = useInboxStore((s) => s.clientState?.ui?.mobile_modern_style);
  const web = useInboxStore((s) => s.clientState?.ui?.modern_style);
  const ui = { mobile_modern_style: own, modern_style: web };
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const source = mobileLookSource(ui);
  const current = source === 'web' ? 'web' : resolveMobileLook(ui);
  const pick = useCallback(() => {
    showActionSheet('Style', CHOICES.map((c) => ({
      label: c.label,
      selected: c.key === current,
      onPress: () => updateClientUI({ mobile_modern_style: c.value }),
    })));
  }, [current, updateClientUI]);
  const detail = CHOICES.find((c) => c.key === current)?.label ?? 'Classic';
  return <NavRow label="Style" description="Classic or Modern, or the same as on the web" detail={detail} onPress={pick} />;
}
