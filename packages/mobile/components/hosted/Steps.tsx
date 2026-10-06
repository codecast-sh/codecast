// One tool step of the hosted assistant in the session screen's transcript,
// said as a plain line ("Searched your mail for Dana") in the words the web's
// condensed receipt uses (@platform/assistant/steps), with a mark for how it
// came out. Nothing opens: the raw call and its result are a developer's view.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';
import { Text } from '@/components/Themed';
import { stepOutcome, stepText, type ToolCallLike, type ToolResultLike } from '@codecast/web/components/simple/lane';
import { useConversationWorking } from '@codecast/web/components/simple/useLane';
import { useHostedTheme } from './hostedTheme';

/** Running while the turn works, waiting while a parked call waits on the
 *  person, failed for any step that did not happen. */
type StepState = 'running' | 'waiting' | 'done' | 'failed';

function StepMark({ state }: { state: StepState }) {
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
          marginTop: 5,
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

function StepLine({ text, state }: { text: string; state: StepState }) {
  const { c } = useHostedTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 3 }}>
      <StepMark state={state} />
      <Text style={{ flex: 1, fontSize: 13, lineHeight: 19, color: state === 'failed' ? c.faint : state === 'running' ? c.ink2 : c.soft }}>{text}</Text>
    </View>
  );
}

/** A call with no result yet: in progress while the turn runs, and once it
 *  stops, parked on the person's approval. Only this case reads the row. */
function OpenStep({ call, conversationId }: { call: ToolCallLike; conversationId: string }) {
  const live = useConversationWorking(conversationId);
  return <StepLine text={stepText(call, undefined, { asking: !live })} state={live ? 'running' : 'waiting'} />;
}

export function HostedStep({ call, result, conversationId }: { call: ToolCallLike; result?: ToolResultLike; conversationId: string }) {
  const outcome = stepOutcome(result);
  if (outcome === 'pending') return <OpenStep call={call} conversationId={conversationId} />;
  return <StepLine text={stepText(call, result)} state={outcome === 'done' ? 'done' : 'failed'} />;
}
