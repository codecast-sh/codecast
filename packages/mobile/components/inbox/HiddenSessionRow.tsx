import { StyleSheet, TouchableOpacity, View as RNView } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Text as RNText } from '@/components/Themed';
import { Spacing, themedStyles, useTheme } from '@/constants/Theme';
import {
  SessionData, sessionTitle, agentLabel, agentColor, formatRelativeTime, projectName, styles as sessionStyles,
} from '@/components/SessionItem';

// Stashed/Closed bucket row — the web SessionCard's hidden variants. Tap opens
// the session; explicit buttons restore (both) and kill (stashed only — a
// closed session's agent is already stopped).
export function HiddenSessionRow({ session, variant, onPress, onRestore, onKill, held }: {
  session: SessionData;
  variant: "stashed" | "closed";
  onPress: () => void;
  onRestore: () => void;
  onKill?: () => void;
  /** Its kill is waiting behind the undo bar. */
  held?: boolean;
}) {
  const Theme = useTheme();
  const project = projectName(session);
  const agent = agentLabel(session.agent_type ?? "");

  return (
    <TouchableOpacity onPress={onPress} style={[styles.dismissedItem, held && styles.heldKill]} disabled={held} activeOpacity={0.6}>
      <RNView style={sessionStyles.conversationHeader}>
        <RNView style={sessionStyles.titleRow}>
          <FontAwesome
            name={variant === "stashed" ? "archive" : "times-circle"}
            size={10}
            color={Theme.textMuted0}
            style={{ marginRight: 6 }}
          />
          {variant === "stashed" && session.inbox_stashed_at && session.inbox_stash_hidden ? (
            // Stash and hide: trigger wakes don't bring it back (web's EyeOff mark).
            <FontAwesome name="eye-slash" size={10} color={Theme.textMuted0} style={{ marginRight: 6 }} />
          ) : null}
          <RNText style={styles.dismissedTitle} numberOfLines={1}>
            {sessionTitle(session)}
          </RNText>
        </RNView>
        <RNView style={styles.hiddenRowActions}>
          <TouchableOpacity onPress={onRestore} hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
            <FontAwesome name="level-up" size={13} color={Theme.cyan} />
          </TouchableOpacity>
          {onKill && (
            <TouchableOpacity onPress={onKill} accessibilityLabel="Kill" hitSlop={{ top: 10, bottom: 10, left: 8, right: 8 }} activeOpacity={0.6}>
              {/* The web's Kill mark (a square), never a Close X: the reflex must not carry over. */}
              <FontAwesome name="square-o" size={13} color={Theme.red} />
            </TouchableOpacity>
          )}
        </RNView>
      </RNView>
      <RNView style={sessionStyles.conversationMeta}>
        {agent ? (
          <>
            <RNText style={[sessionStyles.agentBadge, { color: agentColor(session.agent_type ?? "") }]}>
              {agent}
            </RNText>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
          </>
        ) : null}
        <RNText style={sessionStyles.metaText}>{formatRelativeTime(session.updated_at)}</RNText>
        {project && (
          <>
            <RNText style={sessionStyles.metaSeparator}>·</RNText>
            <RNText style={sessionStyles.projectText} numberOfLines={1}>{project}</RNText>
          </>
        )}
        <RNText style={sessionStyles.metaSeparator}>·</RNText>
        <RNText style={sessionStyles.metaText}>{session.message_count} msgs</RNText>
      </RNView>
    </TouchableOpacity>
  );
}

const styles = themedStyles((Theme) => StyleSheet.create({
  hiddenRowActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    paddingLeft: 8,
  },
  heldKill: { opacity: 0.4 },
  dismissedItem: {
    paddingHorizontal: Spacing.lg,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Theme.borderLight,
    opacity: 0.7,
  },
  dismissedTitle: {
    fontSize: 14,
    fontWeight: '400',
    color: Theme.textMuted,
    flex: 1,
  },
}));
