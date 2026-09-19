// The one-glyph rule for a session on the phone, the same rule as the web's
// SessionGlyph: a personified row wears its face; a row nobody personified
// keeps whatever mark the surface drew before (an agent brand, a chip, or
// nothing). Every mobile surface that shows a session calls this rather than
// deciding for itself.
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { sessionIdentity, type IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { usePersonifyAll } from '@codecast/web/hooks/usePersonifyAll';
import { MobileSessionFace } from './MobileSessionFace';

export function MobileIdentityFace({ row, size = 18, style, fallback = null, badge }: {
  row: IdentityRow | null | undefined;
  size?: number;
  style?: StyleProp<ViewStyle>;
  /** What this surface drew before characters existed. */
  fallback?: ReactNode;
  badge?: ReactNode;
}) {
  const personifyAll = usePersonifyAll();
  if (!row || sessionIdentity(row, personifyAll).kind === 'plain') return <>{fallback}</>;
  return <MobileSessionFace row={row} size={size} style={style} badge={badge} />;
}
