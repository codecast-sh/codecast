import { useMemo } from 'react';
import { ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { Theme, Spacing } from '@/constants/Theme';
import { ChatAvatar } from '@/components/chat/MessageRow';

// The @-completion strip above the composer. Without it, mentioning someone on
// a phone is a spelling test with notification stakes: a near-miss handle simply
// does not notify, and nothing says so.
//
// Appears only while the word under the caret starts with "@"; a tap replaces
// that word with the completed handle. The anchor rides the same list — asking
// the agent should cost the same gesture as naming a person.

export type MentionCandidate = {
  id: string;
  handle: string;
  name: string;
  avatarUrl?: string;
  isAgent?: boolean;
};

/** The active "@word" at the END of the draft, or null. Mobile composers edit at
 *  the tail in practice; mid-string caret tracking needs selection events and
 *  earns its complexity only if tail matching proves insufficient. */
export function activeMentionQuery(draft: string): string | null {
  const m = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_.-]*)?$/.exec(draft);
  if (!m) return null;
  return (m[2] ?? '').toLowerCase();
}

export function completeMention(draft: string, handle: string): string {
  return draft.replace(/(^|\s)@([A-Za-z0-9][A-Za-z0-9_.-]*)?$/, `$1@${handle} `);
}

export function MentionStrip({
  draft,
  members,
  onPick,
}: {
  draft: string;
  members: MentionCandidate[];
  onPick: (nextDraft: string) => void;
}) {
  const query = activeMentionQuery(draft);
  const matches = useMemo(() => {
    if (query === null) return [];
    return members
      .filter((m) =>
        m.handle.toLowerCase().startsWith(query) || m.name.toLowerCase().includes(query),
      )
      .slice(0, 8);
  }, [members, query]);

  if (query === null || matches.length === 0) return null;

  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.stripContent}
    >
      {matches.map((m) => (
        <TouchableOpacity
          key={m.id}
          style={[styles.chip, m.isAgent && styles.chipAgent]}
          onPress={() => onPick(completeMention(draft, m.handle))}
        >
          <ChatAvatar author={{ id: m.id, name: m.name, avatarUrl: m.avatarUrl, isAgent: m.isAgent }} size={18} />
          <RNText style={[styles.chipText, m.isAgent && styles.chipTextAgent]}>@{m.handle}</RNText>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { maxHeight: 40 },
  stripContent: {
    gap: 6,
    paddingHorizontal: Spacing.md,
    paddingVertical: 5,
    alignItems: 'center',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: Theme.border + '66',
    borderRadius: 13,
    paddingLeft: 3,
    paddingRight: 8,
    paddingVertical: 2,
    backgroundColor: Theme.bgAlt + '66',
  },
  chipAgent: { borderColor: Theme.violet + '77' },
  chipText: { fontSize: 12, fontWeight: '600', color: Theme.textSecondary },
  chipTextAgent: { color: Theme.violet },
});
