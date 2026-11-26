// A session state's mark on the phone: the same shapes web draws
// (web components/inbox/SessionStatusMark), so a state reads without colour.
import Svg, { Circle, Path } from 'react-native-svg';
import { SESSION_STATUS, type SessionStatus } from '@codecast/web/lib/sessionStatus';
import { mixHex, type Palette } from '@/constants/Theme';

/** A state's colour from the phone palette, web's SESSION_STATUS colours. */
export function statusMarkColor(theme: Palette, status: SessionStatus): string {
  switch (status) {
    case 'working': case 'starting': return theme.green;
    case 'needs_you': return theme.yellow;
    case 'error': return theme.red;
    case 'done': return theme.cyan;
    case 'dormant': return mixHex(theme.blue, 55, theme.textDim);
    default: return theme.textDim;
  }
}

export function StatusMark({ status, theme, size = 10 }: { status: SessionStatus; theme: Palette; size?: number }) {
  const c = statusMarkColor(theme, status);
  const shape = (() => {
    switch (SESSION_STATUS[status].mark) {
      case 'dot': return <Circle cx="5" cy="5" r="3.5" fill={c} />;
      case 'ask': return <><Circle cx="5" cy="5" r="3.75" fill="none" stroke={c} strokeWidth="1.3" /><Circle cx="5" cy="5" r="1.7" fill={c} /></>;
      case 'alert': return <Path d="M5 1.1 9.3 8.7H.7z" fill={c} stroke={c} strokeWidth=".6" strokeLinejoin="round" />;
      case 'dashed': return <Circle cx="5" cy="5" r="3.6" fill="none" stroke={c} strokeWidth="1.4" strokeDasharray="2 1.55" />;
      case 'check': return <Path d="M1.9 5.3 4.1 7.4 8.2 2.8" fill="none" stroke={c} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />;
      case 'moon': return <Path d="M6.6 1.3A3.9 3.9 0 1 0 8.9 6.6 3.1 3.1 0 0 1 6.6 1.3z" fill={c} />;
      case 'ring': return <Circle cx="5" cy="5" r="3.4" fill="none" stroke={c} strokeWidth="1.4" />;
      case 'aside': return <Path d="M5 1.2v4.6M3.1 3.9 5 5.8l1.9-1.9M1.4 6.4v2.3h7.2V6.4" fill="none" stroke={c} strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />;
      case 'cross': return <Path d="m2.5 2.5 5 5m0-5-5 5" fill="none" stroke={c} strokeWidth="1.5" strokeLinecap="round" />;
    }
  })();
  return <Svg viewBox="0 0 10 10" width={size} height={size}>{shape}</Svg>;
}
