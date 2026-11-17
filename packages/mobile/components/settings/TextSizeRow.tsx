// Settings › Appearance › Text size: Small, Medium or Large conversation text
// and composers on this phone (lib/textSize.ts).
import { useCallback } from 'react';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { showActionSheet } from '@/lib/popups';
import { TEXT_SIZES } from '@/lib/textSize';
import { useTextSize } from '@/hooks/useTextSize';
import { NavRow } from './SettingsUI';

export function TextSizeRow() {
  const current = useTextSize();
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const pick = useCallback(() => {
    showActionSheet('Text size', TEXT_SIZES.map((c) => ({
      label: c.label,
      selected: c.key === current,
      onPress: () => updateClientUI({ mobile_text_size: c.key }),
    })));
  }, [current, updateClientUI]);
  const detail = TEXT_SIZES.find((c) => c.key === current)?.label;
  return <NavRow label="Text size" detail={detail} onPress={pick} />;
}
