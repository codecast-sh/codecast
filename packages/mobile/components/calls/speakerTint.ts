// A voice's color on the phone: the web's palette (components/calls/speakers
// SPEAKER_COLORS, `text-sol-<name>`) read off the phone's theme, indexed by
// the shared rule so spk:0 wears the same color on both.
import { SPEAKER_COLORS } from '@codecast/web/components/calls/speakers';
import { speakerColorIndex } from '@codecast/shared/contracts';

export function speakerTint(theme: Record<string, any>, key: string): string {
  const token = SPEAKER_COLORS[speakerColorIndex(key, SPEAKER_COLORS.length)]!.replace('text-sol-', '');
  return theme[token] ?? theme.textMuted;
}
