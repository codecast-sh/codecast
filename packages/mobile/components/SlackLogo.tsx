import Svg, { Path } from 'react-native-svg';

// The Slack mark, in Slack's own four colours: the same glyph web draws
// (packages/web/components/SlackLogo.tsx). `muted` greys it, for a line we
// mirrored OUT to Slack rather than one that came from there.
const MUTED = '#8a8a8a';

export function SlackLogo({ size = 10, muted }: { size?: number; muted?: boolean }) {
  const c = (hex: string) => (muted ? MUTED : hex);
  return (
    <Svg width={size} height={size} viewBox="0 0 122.8 122.8" opacity={muted ? 0.55 : 1}>
      <Path d="M25.8 77.6a12.9 12.9 0 1 1-12.9-12.9h12.9v12.9z" fill={c('#E01E5A')} />
      <Path d="M32.3 77.6a12.9 12.9 0 0 1 25.8 0v32.3a12.9 12.9 0 0 1-25.8 0V77.6z" fill={c('#E01E5A')} />
      <Path d="M45.2 25.8a12.9 12.9 0 1 1 12.9-12.9v12.9H45.2z" fill={c('#36C5F0')} />
      <Path d="M45.2 32.3a12.9 12.9 0 0 1 0 25.8H12.9a12.9 12.9 0 0 1 0-25.8h32.3z" fill={c('#36C5F0')} />
      <Path d="M97 45.2a12.9 12.9 0 1 1 12.9 12.9H97V45.2z" fill={c('#2EB67D')} />
      <Path d="M90.5 45.2a12.9 12.9 0 0 1-25.8 0V12.9a12.9 12.9 0 0 1 25.8 0v32.3z" fill={c('#2EB67D')} />
      <Path d="M77.6 97a12.9 12.9 0 1 1-12.9 12.9V97h12.9z" fill={c('#ECB22E')} />
      <Path d="M77.6 90.5a12.9 12.9 0 0 1 0-25.8h32.3a12.9 12.9 0 0 1 0 25.8H77.6z" fill={c('#ECB22E')} />
    </Svg>
  );
}
