import type { StyleProp, TextStyle } from 'react-native';
import { useCoarseNow } from '@codecast/web/hooks/useCoarseNow';
import { Text } from '@/components/Themed';
import { formatRelativeTime } from '@/components/sessionFormat';

/** "3m ago" that keeps itself current on the shared minute clock, so a
 *  memoized row or bubble around it never re-renders to refresh it. */
export function RelativeTime({ timestamp, style }: { timestamp: number; style?: StyleProp<TextStyle> }) {
  useCoarseNow(60_000);
  return <Text style={style}>{formatRelativeTime(timestamp)}</Text>;
}
