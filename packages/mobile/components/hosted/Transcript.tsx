// A hosted conversation's transcript on the phone: the person's words on the
// right, the assistant's words as plain prose, and each run of tool steps
// folded into a short list of plain lines between them ("Searched your mail
// for Dana"). The items come from the shared model (web components/simple/
// lane.ts buildTranscript), whose step wording is @platform/assistant/steps,
// the same words the web's condensed receipt says.
import { memo, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { LANE_COPY, visibleSteps, type Step, type TranscriptItem } from '@codecast/web/components/simple/lane';
import { Rise } from './HostedUI';
import { HOSTED_RADIUS, useHostedTheme } from './hostedTheme';

const WORDS = LANE_COPY.transcript;

function StepMark({ state }: { state: Step['state'] }) {
  const { c } = useHostedTheme();
  const breathe = useSharedValue(1);
  useEffect(() => {
    breathe.value = state === 'running' ? withRepeat(withTiming(0.35, { duration: 700 }), -1, true) : 1;
  }, [state, breathe]);
  const style = useAnimatedStyle(() => ({ opacity: breathe.value }));
  const done = state === 'done';
  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          left: -17,
          top: 5,
          width: 9,
          height: 9,
          borderRadius: 5,
          borderWidth: 1.5,
          backgroundColor: done ? c.ok : c.paper,
          borderColor: done ? c.ok : state === 'running' ? c.working : state === 'failed' ? c.danger : c.lineStrong,
        },
        style,
      ]}
    />
  );
}

function StepList({ steps }: { steps: Step[] }) {
  const { c } = useHostedTheme();
  const [open, setOpen] = useState(false);
  const { shown, more } = visibleSteps(steps, open);
  return (
    <View accessibilityLabel={WORDS.steps} style={{ paddingLeft: 17, paddingVertical: 2 }}>
      <View style={{ position: 'absolute', left: 4, top: 8, bottom: 8, width: 1, backgroundColor: c.line }} />
      {shown.map((s) => (
        <View key={s.id} style={{ paddingVertical: 3 }}>
          <StepMark state={s.state} />
          <Text style={{ fontSize: 13, lineHeight: 19, color: s.state === 'failed' ? c.faint : s.state === 'running' ? c.ink2 : c.soft }}>
            {s.text}
          </Text>
        </View>
      ))}
      {more > 0 ? (
        <Pressable onPress={() => setOpen(true)} hitSlop={8} accessibilityRole="button" style={{ paddingVertical: 3 }}>
          <Text style={{ fontSize: 13, fontWeight: '500', color: c.accent }}>{WORDS.moreSteps(more)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const Transcript = memo(function Transcript({
  items,
  onRetry,
}: {
  items: TranscriptItem[];
  onRetry: (item: Extract<TranscriptItem, { kind: 'you' }>) => void;
}) {
  const { c } = useHostedTheme();
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'you':
            return (
              <Rise key={item.id} style={{ alignSelf: 'flex-end', maxWidth: '86%', alignItems: 'flex-end', gap: 4 }}>
                <View
                  style={{
                    paddingVertical: 9,
                    paddingHorizontal: 13,
                    borderRadius: HOSTED_RADIUS,
                    borderBottomRightRadius: 3,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: item.failed ? c.dangerWash : c.sheet,
                    opacity: item.pending ? 0.72 : 1,
                  }}
                >
                  <Text selectable style={{ fontSize: 14.5, lineHeight: 21, color: c.ink }}>{item.text}</Text>
                </View>
                {item.failed ? (
                  <Text style={{ fontSize: 12, color: c.faint }}>
                    {WORDS.didntSend}
                    <Text style={{ fontWeight: '600', color: c.accent }} onPress={() => onRetry(item)} accessibilityRole="button">
                      {WORDS.retry}
                    </Text>
                  </Text>
                ) : item.pending ? (
                  <Text style={{ fontSize: 12, color: c.faint }}>{WORDS.sending}</Text>
                ) : null}
              </Rise>
            );
          case 'said':
            return (
              <Rise key={item.id}>
                <MarkdownContent text={item.text} baseStyle={{ fontSize: 14.5, lineHeight: 22, color: c.ink }} />
              </Rise>
            );
          case 'steps':
            return <StepList key={item.id} steps={item.steps} />;
          case 'answer':
          case 'note':
            return (
              <View key={item.id} style={{ alignSelf: 'center', paddingVertical: 4, paddingHorizontal: 12, borderRadius: 999, backgroundColor: c.quiet }}>
                <Text style={{ fontSize: 12, color: c.soft }}>{item.text}</Text>
              </View>
            );
        }
      })}
    </>
  );
});
