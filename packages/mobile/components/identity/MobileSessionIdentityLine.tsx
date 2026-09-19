// A session's title line on the phone, the same reading order as the web
// card: once personified the NAME leads at full weight and never truncates,
// and what the session is working on follows, dimmer. Not personified: the
// title alone, exactly as the row always read.
import type { StyleProp, TextStyle } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { identityLine, type IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { usePersonifyAll } from '@codecast/web/hooks/usePersonifyAll';
import { useTheme } from '@/constants/Theme';

export function MobileSessionIdentityLine({ row, title, style, maxFontSizeMultiplier }: {
  row: IdentityRow | null | undefined;
  /** The display title, already cleaned by the caller. */
  title: string;
  /** The surface's own title style; the name inherits it. */
  style?: StyleProp<TextStyle>;
  maxFontSizeMultiplier?: number;
}) {
  const Theme = useTheme();
  const personifyAll = usePersonifyAll();
  const line = row ? identityLine(row, title, personifyAll) : { name: null, title, handle: null };
  if (!line.name) {
    return <RNText style={style} numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier}>{title}</RNText>;
  }
  return (
    <RNText style={style} numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier}>
      {line.name}
      {line.handle ? <RNText style={{ color: Theme.textMuted0, fontWeight: '400' }}> @{line.handle}</RNText> : null}
      {line.title ? <RNText style={{ color: Theme.textMuted0, fontWeight: '400' }}>{`: ${line.title}`}</RNText> : null}
    </RNText>
  );
}
