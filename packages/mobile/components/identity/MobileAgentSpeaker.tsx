// Who an agent speaks as, on every phone line that names the speaker of its
// words (a transcript turn, a search hit): a role's face and given name, a
// character's face and name, or for a plain session the surface's own agent
// mark and the agent's product name. The agent brand rides a face as a corner
// badge (session-characters.md S1, S3). The rule is web's useAgentSpeaker.
// The mark and the badge come from the caller, so this module draws nothing
// native of its own.
import type { ReactNode } from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useAgentSpeaker } from '@codecast/web/hooks/useLiveIdentityRow';
import type { IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { MobileSessionFace } from './MobileSessionFace';

export function MobileAgentSpeaker({ row, agentType, size = 16, mark = null, badge, nameStyle, maxFontSizeMultiplier }: {
  row: IdentityRow | null;
  agentType?: string | null;
  size?: number;
  /** What a plain session shows before its name (the agent's dot or logo). */
  mark?: ReactNode;
  /** The agent's brand on the face's corner, for a role or a character. */
  badge?: ReactNode;
  nameStyle?: StyleProp<TextStyle>;
  maxFontSizeMultiplier?: number;
}) {
  const speaker = useAgentSpeaker(row, agentType);
  return (
    <>
      {speaker.row
        ? <MobileSessionFace row={speaker.row} size={size} badge={badge} />
        : mark}
      <RNText style={nameStyle} numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier}>{speaker.name}</RNText>
    </>
  );
}
