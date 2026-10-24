// One message a search found, drawn the way its conversation draws it: who
// said it (a face and a name), then the words through the message markdown,
// so ids are pills, emphasis renders and the words found are marked inside
// the rendered text. A long stretch clips with a fade into the row behind it.
import { memo, useMemo, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import { stripWrapperTags } from '@codecast/shared/search';
import { Text as RNText } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { FadeGradient } from '@/components/CollapsibleBody';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { ChatAvatar } from '@/components/chat/MessageRow';
import { formatRelativeTime } from '@/components/SessionItem';
import { MobileAgentSpeaker } from '@/components/identity';
import type { IdentityRow } from '@codecast/web/lib/sessionIdentity';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { SearchHighlightContext } from './highlight';

/** About four lines of a message: a passage, not a wall. */
const CLIP = 80;
const WHO = 16;

/** Who said a session message: the person's face and name ("You" for the
 *  viewer), or who the agent speaks as (its role, its character, or its mark
 *  and product name). */
export function SpeakerLine({ role, agentType, identity, authorName, authorAvatar, isOwn }: {
  role: string; agentType?: string | null; identity: IdentityRow | null; authorName?: string | null; authorAvatar?: string | null; isOwn?: boolean;
}) {
  if (role !== 'user') {
    return (
      <MobileAgentSpeaker
        row={identity}
        agentType={agentType}
        size={WHO}
        mark={<AgentLogoSvg agentType={agentType ?? undefined} size={WHO} />}
        badge={agentType ? <AgentLogoSvg agentType={agentType} size={7} /> : undefined}
        nameStyle={styles.name}
        maxFontSizeMultiplier={CHROME_FONT_CAP}
      />
    );
  }
  const name = isOwn !== false ? 'You' : authorName || 'User';
  return (
    <>
      <ChatAvatar author={{ id: name, name: authorName || name, avatarUrl: authorAvatar ?? undefined }} size={WHO} />
      <RNText style={[styles.name, styles.nameUser]} numberOfLines={1} maxFontSizeMultiplier={CHROME_FONT_CAP}>{name}</RNText>
    </>
  );
}

export const MessageSnippet = memo(function MessageSnippet({ content, timestamp, who, userText, highlight, onPress, fadeColor }: {
  content: string;
  timestamp?: number;
  /** The speaker's line (SpeakerLine, or a chat author). */
  who: ReactNode;
  userText?: boolean;
  /** The words searched for, marked in the text. */
  highlight: string;
  onPress: () => void;
  /** The surface behind the snippet, which the clip fades into. */
  fadeColor?: string;
}) {
  const Theme = useTheme();
  const body = useMemo(() => stripWrapperTags(content), [content]);
  // The fade only where the clip cuts. Yoga hands the clip's height down to
  // the content, so content as tall as the clip is content that was cut.
  const [clipped, setClipped] = useState(false);
  const fade = fadeColor ?? Theme.bg;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <RNView style={styles.who}>
        {who}
        {timestamp ? <RNText style={styles.time} maxFontSizeMultiplier={CHROME_FONT_CAP}>{formatRelativeTime(timestamp)}</RNText> : null}
      </RNView>
      <RNView style={styles.clip}>
        <RNView onLayout={(e) => setClipped(e.nativeEvent.layout.height >= CLIP - 1)} pointerEvents="none">
          <SearchHighlightContext.Provider value={highlight || undefined}>
            <MarkdownContent text={body} baseStyle={styles.text} isUser={userText} selectable={false} />
          </SearchHighlightContext.Provider>
        </RNView>
        {clipped && <FadeGradient colors={[fade + '00', fade]} style={styles.fade} pointerEvents="none" />}
      </RNView>
    </Pressable>
  );
});

const styles = themedStyles((Theme) => StyleSheet.create({
  row: { paddingVertical: 8, paddingLeft: 10, paddingRight: 4, borderRadius: 8 },
  pressed: { backgroundColor: Theme.bgHighlight + '80' },
  who: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  name: { fontSize: 12, fontWeight: '600', color: Theme.textMuted, flexShrink: 1 },
  nameUser: { color: Theme.blue },
  time: { fontSize: 11, color: Theme.textMuted0 },
  clip: { maxHeight: CLIP, overflow: 'hidden', marginLeft: WHO + 6 },
  text: { fontSize: 13, lineHeight: 19, color: Theme.textSecondary },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 24 },
}));
