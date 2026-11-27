// The phone's twin of web's components/inbox/SessionStatusMark: a session
// state's mark, a shape as well as a colour so it reads without the colour
// (working dot, needs-you ring and dot, sleeping moon, idle ring, done check).
// Which shape a state draws is the shared table (web lib/sessionStatus
// SESSION_STATUS); the shapes' geometry and the colours are copied from web's
// SessionStatusMark.tsx and SESSION_STATUS, so keep them in step with it.
import type { ReactNode } from 'react';
import Svg, { Circle, Path } from 'react-native-svg';
import { mixHex, useTheme, type Palette } from '@/constants/Theme';
import { SESSION_STATUS, type SessionStatus, type StatusMarkShape } from '@codecast/web/lib/sessionStatus';

const colorOf = (status: SessionStatus, T: Palette): string => {
  switch (status) {
    case 'working': case 'starting': return T.green;
    case 'needs_you': return T.yellow;
    case 'error': return T.red;
    case 'done': return T.cyan;
    // Blue-grey, between the two tokens, as web's.
    case 'dormant': return mixHex(T.blue, 55, T.textDim);
    default: return T.textDim;
  }
};

const SHAPES: Record<StatusMarkShape, (c: string) => ReactNode> = {
  dot: (c) => <Circle cx={5} cy={5} r={3.5} fill={c} />,
  ask: (c) => <><Circle cx={5} cy={5} r={3.75} fill="none" stroke={c} strokeWidth={1.3} /><Circle cx={5} cy={5} r={1.7} fill={c} /></>,
  alert: (c) => <Path d="M5 1.1 9.3 8.7H.7z" fill={c} stroke={c} strokeWidth={0.6} strokeLinejoin="round" />,
  dashed: (c) => <Circle cx={5} cy={5} r={3.6} fill="none" stroke={c} strokeWidth={1.4} strokeDasharray="2 1.55" />,
  check: (c) => <Path d="M1.9 5.3 4.1 7.4 8.2 2.8" fill="none" stroke={c} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />,
  moon: (c) => <Path d="M6.6 1.3A3.9 3.9 0 1 0 8.9 6.6 3.1 3.1 0 0 1 6.6 1.3z" fill={c} />,
  ring: (c) => <Circle cx={5} cy={5} r={3.4} fill="none" stroke={c} strokeWidth={1.4} />,
  aside: (c) => <Path d="M5 1.2v4.6M3.1 3.9 5 5.8l1.9-1.9M1.4 6.4v2.3h7.2V6.4" fill="none" stroke={c} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />,
  cross: (c) => <Path d="m2.5 2.5 5 5m0-5-5 5" fill="none" stroke={c} strokeWidth={1.5} strokeLinecap="round" />,
};

export function SessionStatusMark({ status, size = 12 }: { status: SessionStatus; size?: number }) {
  const c = colorOf(status, useTheme());
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10" accessible={false}>
      {SHAPES[SESSION_STATUS[status].mark](c)}
    </Svg>
  );
}
