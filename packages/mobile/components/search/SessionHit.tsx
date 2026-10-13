// One conversation a search found, the phone's twin of web's SessionHit: the
// head is the inbox row's own identity (face, name and title, project badge,
// author, age) and under it the messages that matched, each drawn as its
// transcript draws it (MessageSnippet). A session found only by its name
// shows what it was about instead.
import { memo } from 'react';
import { Pressable, StyleSheet, View as RNView } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { SessionSearchRow } from '@codecast/web/lib/instantSessionSearch';
import { stripWrapperTags } from '@codecast/shared/search';
import { useModeWords, useSurface } from '@codecast/web/lib/surfaces';
import { Text as RNText } from '@/components/Themed';
import { MobileIdentityFace, MobileSessionIdentityLine, useSessionIdentityRow } from '@/components/identity';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { ProjectTag, cleanTitle, formatRelativeTime, projectName, styles as sessionStyles } from '@/components/SessionItem';
import { CHROME_FONT_CAP, themedStyles, useTheme } from '@/constants/Theme';
import { HighlightText } from './highlight';
import { MessageSnippet, SpeakerLine } from './MessageSnippet';

const FACE = 20;

const flat = (t: string) => stripWrapperTags(t).replace(/^\.\.\.|\.\.\.$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

export const SessionHit = memo(function SessionHit({ row, highlight, maxMatches = 2, onOpen, onLongPress }: {
  row: SessionSearchRow;
  /** The words searched for (operators stripped). */
  highlight: string;
  /** Matched messages shown before "N more". */
  maxMatches?: number;
  /** Opens the conversation, at a message when one is named. */
  onOpen: (conversationId: string, messageId?: string) => void;
  onLongPress?: (row: SessionSearchRow) => void;
}) {
  const Theme = useTheme();
  const internals = useSurface('search.internals');
  const words = useModeWords();
  // The store's row when it holds the session, else the identity the server sent.
  const identity = useSessionIdentityRow(row.conversationId, row.identity ? { ...row.identity, _id: row.conversationId } as any : null);
  const project = projectName({ project_path: row.projectPath });
  // A request sent again (Try again) matches twice with the same words; it shows once.
  const seen = new Set<string>();
  const matches = row.matches.filter((m) => {
    const key = `${m.role}\u0000${m.content.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const shown = matches.slice(0, maxMatches);
  const more = Math.max(0, (row.matchCount ?? matches.length) - shown.length);
  // A hit on the first message says what "began as" would: the message shows, the line goes.
  const began = internals ? row.origin?.started_as : undefined;
  const beganShown = !!began && !shown.some((m) => flat(m.content).includes(flat(began).slice(0, 60)) || flat(began).includes(flat(m.content).slice(0, 60)));
  const earlier = row.origin?.earlier_titles ?? [];
  const workers = internals ? row.workerCount ?? 0 : 0;
  const open = () => onOpen(row.conversationId, shown[0]?.messageId);

  return (
    <RNView style={styles.card}>
      <Pressable
        onPress={open}
        onLongPress={onLongPress ? () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onLongPress(row); } : undefined}
        style={({ pressed }) => [styles.head, pressed && styles.pressed]}
      >
        <RNView style={styles.titleRow}>
          <MobileIdentityFace row={identity} size={FACE} fallback={<AgentLogoSvg agentType={row.agentType ?? undefined} size={FACE - 2} />} />
          <MobileSessionIdentityLine row={identity} title={cleanTitle(row.title) || 'Untitled'} style={styles.title} highlight={highlight} />
          <RNText style={sessionStyles.timeText} maxFontSizeMultiplier={CHROME_FONT_CAP}>{formatRelativeTime(row.updatedAt)}</RNText>
        </RNView>
        {(project || !row.isOwn || (internals && !!row.messageCount)) && (
          <RNView style={styles.meta}>
            {project && (
              <ProjectTag name={project} maxFontSizeMultiplier={CHROME_FONT_CAP} />
            )}
            {!row.isOwn && !!row.authorName && <RNText style={sessionStyles.authorText} maxFontSizeMultiplier={CHROME_FONT_CAP}>{row.authorName.split(' ')[0]}</RNText>}
            {internals && !!row.messageCount && <RNText style={styles.dim} maxFontSizeMultiplier={CHROME_FONT_CAP}>{row.messageCount} msgs</RNText>}
          </RNView>
        )}
        {earlier.length > 0 && (
          <HighlightText text={`earlier titled ${earlier.join(' · ')}`} query={highlight} style={styles.origin} numberOfLines={1} />
        )}
        {beganShown && <HighlightText text={`began as ${flatOnce(began!)}`} query={highlight} style={styles.origin} numberOfLines={2} />}
        {workers > 0 && <RNText style={styles.origin}>{workers} worker session{workers === 1 ? '' : 's'} matched too</RNText>}
        {shown.length === 0 && !!row.instantSnippet && (
          <HighlightText text={flatOnce(row.instantSnippet)} query={highlight} style={styles.summary} numberOfLines={2} />
        )}
      </Pressable>
      {shown.length > 0 && (
        <RNView style={[styles.matches, { borderLeftColor: Theme.borderLight }]}>
          {shown.map((m) => (
            <MessageSnippet
              key={m.messageId ?? m.content}
              content={m.content}
              timestamp={m.timestamp}
              who={<SpeakerLine role={m.role} agentType={row.agentType} authorName={row.authorName} authorAvatar={row.authorAvatar} isOwn={row.isOwn} />}
              userText={m.role === 'user'}
              highlight={highlight}
              onPress={() => onOpen(row.conversationId, m.messageId)}
            />
          ))}
          {more > 0 && (
            <Pressable onPress={open} hitSlop={6} style={styles.more}>
              <RNText style={styles.moreText} maxFontSizeMultiplier={CHROME_FONT_CAP}>{more} more in this {words.conversation.toLowerCase()}</RNText>
            </Pressable>
          )}
        </RNView>
      )}
    </RNView>
  );
});

/** A stored stretch as one line of prose: wrappers and line breaks out. */
function flatOnce(text: string): string {
  return stripWrapperTags(text).replace(/\s+/g, ' ').trim();
}

const styles = themedStyles((Theme) => StyleSheet.create({
  card: {
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.bgHighlight,
  },
  head: { paddingHorizontal: 4, paddingVertical: 8, borderRadius: 8 },
  pressed: { backgroundColor: Theme.bgHighlight + '80' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 15, fontWeight: '600', color: Theme.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, marginLeft: FACE + 8 },
  dim: { fontSize: 11, color: Theme.textMuted0 },
  origin: { fontSize: 12, lineHeight: 17, color: Theme.textMuted0, marginTop: 3, marginLeft: FACE + 8 },
  summary: { fontSize: 13, lineHeight: 19, color: Theme.textMuted, marginTop: 4, marginLeft: FACE + 8 },
  matches: { marginLeft: 4 + FACE / 2, paddingLeft: FACE / 2 - 2, borderLeftWidth: StyleSheet.hairlineWidth },
  more: { paddingLeft: 10, paddingVertical: 4 },
  moreText: { fontSize: 12, color: Theme.textMuted0 },
}));
