// Where a person starts with the hosted assistant on the phone (web
// components/AssistantIntro.tsx): the assistant's mark, what it does, and
// asks drawn from the web's one pool (simple/starterPool), less any a
// conversation already began with. AssistantIntro sits in an empty inbox in
// hosted mode; AssistantStart is the new conversation sheet's body when the
// assistant is the agent: up to three starters over the composer. Mail and
// calendar are named only once Whisk is connected (useLaneMailAbilities).
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Feather from '@expo/vector-icons/Feather';
import { Text } from '@/components/Themed';
import { AgentLogoSvg } from '@/components/AgentLogo';
import { HOSTED_AGENT_TYPE } from '@codecast/shared/contracts/assistant';
import { LANE_COPY } from '@codecast/web/components/simple/lane';
import { useLaneMailAbilities } from '@codecast/web/components/simple/useLaneMail';
import { useStarterPool } from '@codecast/web/components/simple/starterPool';
import { useHostedAskGate } from '@codecast/web/components/simple/useHostedAskGate';
import { Composer } from './Composer';
import { useHostedTheme } from './hostedTheme';

/** `title` and `lede` replace the intro's own lines where the screen has
 *  something truer to say (an inbox with everything handled). A row hands
 *  its whole ask to `onStarter`. */
export function AssistantIntro({ onStarter, title, lede }: { onStarter: (text: string) => void; title?: string; lede?: string }) {
  const { c } = useHostedTheme();
  const { connected, can } = useLaneMailAbilities();
  const { asks } = useStarterPool(connected, can);
  return (
    <View style={{ alignItems: 'center', gap: 10, alignSelf: 'stretch' }}>
      <AgentLogoSvg agentType={HOSTED_AGENT_TYPE} size={30} />
      <Text accessibilityRole="header" style={{ fontSize: 18, fontWeight: '500', color: c.ink, textAlign: 'center' }}>
        {title ?? LANE_COPY.intro.title}
      </Text>
      <Text style={{ fontSize: 14, lineHeight: 20, color: c.soft, textAlign: 'center', maxWidth: 320 }}>
        {lede ?? LANE_COPY.intro.lede(connected)}
      </Text>
      <StarterRows starters={asks.map((ask) => ({ label: ask, text: ask }))} onStarter={onStarter} />
    </View>
  );
}

/** The web's starter rows (AssistantIntro StarterRow): plain text in body
 *  ink, a muted arrow at the end, a hairline between rows, three lines before
 *  an ask clips so its assumptions show. */
function StarterRows({ starters, onStarter, held = false }: { starters: Array<{ label: string; text: string }>; onStarter: (text: string) => void; held?: boolean }) {
  const { c } = useHostedTheme();
  if (starters.length === 0) return null;
  return (
    <View accessibilityRole="list" accessibilityLabel="Ways to start" style={{ alignSelf: 'stretch', marginTop: 4 }}>
      {starters.map((starter, i) => (
        <Pressable
          key={starter.label}
          accessibilityRole="button"
          accessibilityState={{ disabled: held }}
          disabled={held}
          onPress={() => onStarter(starter.text)}
          style={({ pressed }) => ({
            opacity: held ? 0.45 : 1,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: 12,
            paddingVertical: 11,
            paddingHorizontal: 4,
            borderBottomWidth: i === starters.length - 1 ? 0 : StyleSheet.hairlineWidth,
            borderBottomColor: c.line,
            backgroundColor: pressed ? c.hover : 'transparent',
          })}
        >
          <Text numberOfLines={3} style={{ flex: 1, fontSize: 14.5, lineHeight: 21, color: c.ink }}>{starter.label}</Text>
          <Feather name="arrow-right" size={14} color={c.faint} style={{ marginTop: 4 }} />
        </Pressable>
      ))}
    </View>
  );
}

/** One thing to ask, as a tappable chip: the intro's starters and the empty
 *  Routines list's examples. */
export function StarterChip({ label, onPress }: { label: string; onPress: () => void }) {
  const { c } = useHostedTheme();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
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
      <Text style={{ fontSize: 12.5, color: c.ink2 }}>{label}</Text>
    </Pressable>
  );
}

/** The new conversation sheet's body: starters over the first ask. A
 *  starter fills the composer, the person edits or sends it, and `onStart`
 *  gets the words. The sheet's own header says "What's next?". */
export function AssistantStart({ onStart, onOpenPlan, seed: initialSeed }: {
  onStart: (text: string) => void;
  /** Opens the Plan page from a used-up month's sentence; the sheet closes
   *  itself first. */
  onOpenPlan: () => void;
  seed?: string | null;
}) {
  const { c } = useHostedTheme();
  const [seed, setSeed] = useState<{ text: string; at: number } | null>(initialSeed ? { text: initialSeed, at: 0 } : null);
  const { connected, can } = useLaneMailAbilities();
  const { starters } = useStarterPool(connected, can);
  // A used-up month or thinking that is down holds a new ask, as on the web
  // home (useHostedAskGate): the starters stay in view, greyed, the box keeps
  // the person's words, and one centred block says why. The way out of a
  // used-up month is the Plan page; the phone sells no credit itself.
  const hold = useHostedAskGate();
  return (
    <View style={{ gap: 14 }}>
      {initialSeed ? null : <StarterRows held={!!hold} starters={starters} onStarter={(text) => setSeed({ text, at: Date.now() })} />}
      {hold ? (
        <Text accessibilityRole="alert" style={{ textAlign: 'center', fontSize: 13.5, lineHeight: 20, color: c.soft, paddingHorizontal: 12 }}>
          {hold.words}
          {hold.allowance ? (
            <Text style={{ color: c.accent, fontWeight: '500' }} accessibilityRole="link" onPress={onOpenPlan}>
              {'  See your plan'}
            </Text>
          ) : null}
        </Text>
      ) : null}
      <Composer autoFocus={!initialSeed && !hold} held={!!hold} placeholder={LANE_COPY.home.placeholder} seed={seed} onSend={onStart} />
    </View>
  );
}
