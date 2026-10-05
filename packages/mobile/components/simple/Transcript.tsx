// A conversation's transcript in the lane on the phone (web
// components/simple/Transcript.tsx): the person's words on the right, the
// assistant's words as plain prose, and each run of tool steps folded into a
// short list of plain lines between them. The items come from lane.ts
// buildTranscript, the web lane's own model.
import { memo, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/Themed';
import { MarkdownContent } from '@/components/MarkdownRenderer';
import { LANE_COPY, visibleSteps, type Step, type TranscriptItem } from '@codecast/web/components/simple/lane';
import { Reading, Rise } from './LaneUI';
import { useLaneTheme } from './laneTheme';

const WORDS = LANE_COPY.transcript;

function StepMark({ state }: { state: Step['state'] }) {
  const { c } = useLaneTheme();
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
          left: -18,
          top: 6,
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
  const { c } = useLaneTheme();
  const [open, setOpen] = useState(false);
  const { shown, more } = visibleSteps(steps, open);
  return (
    <View accessibilityLabel={WORDS.steps} style={{ paddingLeft: 18, paddingVertical: 2 }}>
      <View style={{ position: 'absolute', left: 4, top: 9, bottom: 9, width: 1, backgroundColor: c.lineStrong }} />
      {shown.map((s) => (
        <View key={s.id} style={{ paddingVertical: 3 }}>
          <StepMark state={s.state} />
          <Text style={{ fontSize: 14.5, lineHeight: 20, color: s.state === 'failed' ? c.faint : s.state === 'running' ? c.ink2 : c.soft }}>
            {s.text}
            {s.state === 'failed' ? <Text style={{ fontSize: 13, color: c.danger }}>{WORDS.failed}</Text> : null}
          </Text>
        </View>
      ))}
      {more > 0 ? (
        <Pressable onPress={() => setOpen(true)} hitSlop={8} accessibilityRole="button" style={{ paddingVertical: 3 }}>
          <Text style={{ fontSize: 14, fontWeight: '500', color: c.mark }}>{WORDS.moreSteps(more)}</Text>
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
  const { c } = useLaneTheme();
  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case 'you':
            return (
              <Rise key={item.id} style={{ alignSelf: 'flex-end', maxWidth: '85%', alignItems: 'flex-end', gap: 4 }}>
                <View
                  style={{
                    paddingVertical: 11,
                    paddingHorizontal: 16,
                    borderRadius: 16,
                    borderBottomRightRadius: 4,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: item.failed ? c.dangerWash : c.sheet,
                    opacity: item.pending ? 0.72 : 1,
                  }}
                >
                  <Text selectable style={{ fontSize: 16.5, lineHeight: 24, color: c.ink }}>{item.text}</Text>
                </View>
                {item.failed ? (
                  <Text style={{ fontSize: 12.5, color: c.faint }}>
                    {WORDS.didntSend}
                    <Text style={{ fontWeight: '500', color: c.mark }} onPress={() => onRetry(item)} accessibilityRole="button">
                      {WORDS.retry}
                    </Text>
                  </Text>
                ) : item.pending ? (
                  <Text style={{ fontSize: 12.5, color: c.faint }}>{WORDS.sending}</Text>
                ) : null}
              </Rise>
            );
          case 'said':
            return (
              <Rise key={item.id}>
                <Reading>
                  <MarkdownContent text={item.text} baseStyle={{ fontSize: 18, lineHeight: 29, color: c.ink }} />
                </Reading>
              </Rise>
            );
          case 'steps':
            return <StepList key={item.id} steps={item.steps} />;
          case 'answer':
          case 'note':
            return (
              <View key={item.id} style={{ alignSelf: 'center', paddingVertical: 5, paddingHorizontal: 13, borderRadius: 999, backgroundColor: c.quiet }}>
                <Text style={{ fontSize: 13, color: c.soft }}>{item.text}</Text>
              </View>
            );
        }
      })}
    </>
  );
});
