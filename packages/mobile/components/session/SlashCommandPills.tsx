// Slash commands on the phone: typing "/" at the start of a word shows the
// session's commands (its skills and the agent's built-ins, the web
// composer's list) as a row of pills above the composer; a tap completes the
// token. The list and the matching are web's (lib/sessionSkills).
import { useMemo } from 'react';
import { ScrollView, TouchableOpacity } from 'react-native';
import { Text as RNText } from '@/components/Themed';
import { useInboxStore } from '@codecast/web/store/inboxStore';
import { applySlashSkill, matchSlashSkills, resolveSessionSkills, slashQueryAt } from '@codecast/web/lib/sessionSkills';
import { pillStyles } from '@/components/SuggestionPills';

export function SlashCommandPills({ conversationId, text, onPick }: { conversationId: string; text: string; onPick: (next: string) => void }) {
  const availableSkills = useInboxStore((s) => (s.currentUser as any)?.available_skills as string | undefined);
  const projectPath = useInboxStore((s) => s.sessions[conversationId]?.project_path);
  const agentType = useInboxStore((s) => s.sessions[conversationId]?.agent_type);
  const skills = useMemo(
    () => resolveSessionSkills({ availableSkills, projectPath, agentType }),
    [availableSkills, projectPath, agentType],
  );
  // The phone types at the end of the text, so the caret is the end.
  const slash = slashQueryAt(text);
  const matches = slash ? matchSlashSkills(skills, slash.query, 20) : [];
  if (!slash || matches.length === 0) return null;
  return (
    <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} style={pillStyles.strip} contentContainerStyle={pillStyles.stripContent}>
      {matches.map((s) => (
        <TouchableOpacity
          key={s.name}
          activeOpacity={0.7}
          style={pillStyles.pill}
          onPress={() => onPick(applySlashSkill(text, slash.start, s.name).text)}
          accessibilityLabel={`/${s.name}${s.description ? `: ${s.description}` : ''}`}
        >
          <RNText style={pillStyles.pillText} numberOfLines={1}>/{s.name}</RNText>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
