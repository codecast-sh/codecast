// Where a person starts with the hosted assistant on the phone (web
// components/AssistantIntro.tsx): the assistant's mark, what it does, and
// starters that fill the first ask. AssistantIntro sits in an empty inbox in
// hosted mode; AssistantStart adds the composer, as the new conversation
// sheet's body when the assistant is the agent. Mail and calendar are named
// only once Whisk is connected (useLaneMailAbilities).
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Text } from '@/components/Themed';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { HOSTED_AGENT_TYPE } from '@codecast/shared/contracts/assistant';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { useLaneMailAbilities } from '@codecast/web/components/simple/useLaneMail';
import { Composer } from './Composer';
import { useHostedTheme } from './hostedTheme';

export function AssistantIntro({ onStarter, align = 'center' }: { onStarter: (text: string) => void; align?: 'center' | 'start' }) {
  const { c } = useHostedTheme();
  const { connected } = useLaneMailAbilities();
  const center = align === 'center';
  return (
    <View style={{ alignItems: center ? 'center' : 'flex-start', gap: 10 }}>
      <AgentLogoSvg agentType={HOSTED_AGENT_TYPE} size={32} />
      <Text accessibilityRole="header" style={{ fontSize: 17, fontWeight: '600', color: c.ink, textAlign: center ? 'center' : 'left' }}>
        {LANE_COPY.intro.title}
      </Text>
      <Text style={{ fontSize: 13, lineHeight: 19, color: c.soft, textAlign: center ? 'center' : 'left', maxWidth: 340 }}>
        {LANE_COPY.intro.lede(connected)}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: center ? 'center' : 'flex-start', gap: 8, marginTop: 4 }}>
        {LANE_COPY.home.starters(connected).map((starter) => (
          <Pressable
            key={starter.label}
            accessibilityRole="button"
            onPress={() => onStarter(starter.text)}
            style={({ pressed }) => ({
              paddingVertical: 7,
              paddingHorizontal: 12,
              borderRadius: 999,
              borderWidth: 1,
              borderColor: pressed ? c.lineStrong : c.line,
              backgroundColor: pressed ? c.hover : c.sheet,
              transform: [{ scale: pressed ? 0.97 : 1 }],
            })}
          >
            <Text style={{ fontSize: 12.5, color: c.ink2 }}>{starter.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

/** The intro over the first ask: a starter fills the composer, the person
 *  edits or sends it, and `onStart` gets the words. */
export function AssistantStart({ onStart, seed: initialSeed }: { onStart: (text: string) => void; seed?: string | null }) {
  const [seed, setSeed] = useState<{ text: string; at: number } | null>(initialSeed ? { text: initialSeed, at: 0 } : null);
  return (
    <View style={{ gap: 18 }}>
      <AssistantIntro align="start" onStarter={(text) => setSeed({ text, at: Date.now() })} />
      <Composer hero autoFocus={!initialSeed} placeholder={LANE_COPY.home.placeholder} seed={seed} onSend={onStart} />
    </View>
  );
}
